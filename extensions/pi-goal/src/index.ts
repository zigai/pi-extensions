import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { registerGoalCommand } from "./commands.js";
import { formatFooterStatus } from "./format.js";
import { budgetLimitPrompt, continuationPrompt } from "./prompts.js";
import { applyUsage, clearEntry, goalWithLiveUsage, reconstructGoal, setEntry } from "./state.js";
import { registerGoalTools } from "./tools.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type ThreadGoal } from "./types.js";

interface AccountingState {
  activeGoalId: string | null;
  lastAccountedAt: number | null;
  lastContextTokens: number | null;
  budgetWarningSentFor: string | null;
}

interface StatusContext {
  ui: Pick<ExtensionContext["ui"], "setStatus">;
}

type UsageContext = Pick<ExtensionContext, "getContextUsage">;

export default function (pi: ExtensionAPI): void {
  let goal: ThreadGoal | null = null;
  let continuationQueuedFor: string | null = null;
  let statusContext: StatusContext | null = null;
  let statusRefreshTimer: ReturnType<typeof setInterval> | null = null;
  const accounting: AccountingState = {
    activeGoalId: null,
    lastAccountedAt: null,
    lastContextTokens: null,
    budgetWarningSentFor: null,
  };

  const goalForDisplay = (): ThreadGoal | null =>
    goalWithLiveUsage(goal, accounting.activeGoalId, accounting.lastAccountedAt);

  const stopStatusRefresh = (): void => {
    if (statusRefreshTimer) {
      clearInterval(statusRefreshTimer);
      statusRefreshTimer = null;
    }
  };

  const syncStatusRefresh = (): void => {
    if (goal?.status === "active" && statusContext && !statusRefreshTimer) {
      statusRefreshTimer = setInterval(() => {
        if (!statusContext || goal?.status !== "active") {
          stopStatusRefresh();
          return;
        }
        statusContext.ui.setStatus("codex-goal", formatFooterStatus(goalForDisplay()));
      }, 1_000);
      statusRefreshTimer.unref?.();
      return;
    }

    if (goal?.status !== "active") {
      stopStatusRefresh();
    }
  };

  const refreshUi = (ctx: StatusContext): void => {
    statusContext = ctx;
    ctx.ui.setStatus("codex-goal", formatFooterStatus(goalForDisplay()));
    syncStatusRefresh();
  };

  const persistGoal = (nextGoal: ThreadGoal, source: GoalEntrySource): void => {
    goal = nextGoal;
    pi.appendEntry(CUSTOM_ENTRY_TYPE, setEntry(nextGoal, source));
  };

  const persistClear = (source: GoalEntrySource): void => {
    const clearedGoalId = goal?.goalId ?? null;
    goal = null;
    continuationQueuedFor = null;
    accounting.activeGoalId = null;
    accounting.lastAccountedAt = null;
    accounting.lastContextTokens = null;
    stopStatusRefresh();
    pi.appendEntry(CUSTOM_ENTRY_TYPE, clearEntry(clearedGoalId, source));
  };

  const reloadFromSession = (ctx: ExtensionContext): void => {
    goal = reconstructGoal(ctx.sessionManager.getBranch()).goal;
    continuationQueuedFor = null;
    if (goal?.status !== "active") {
      accounting.activeGoalId = null;
      accounting.lastAccountedAt = null;
      accounting.lastContextTokens = null;
    }
    refreshUi(ctx);
  };

  const beginAccounting = (ctx: UsageContext): void => {
    if (!goal || goal.status !== "active") {
      accounting.activeGoalId = null;
      accounting.lastAccountedAt = null;
      accounting.lastContextTokens = null;
      return;
    }

    accounting.activeGoalId = goal.goalId;
    accounting.lastAccountedAt = Date.now();
    accounting.lastContextTokens = ctx.getContextUsage()?.tokens ?? null;
  };

  const accountProgress = (ctx: ExtensionContext, allowBudgetSteering: boolean): void => {
    if (!goal || accounting.activeGoalId !== goal.goalId || goal.status !== "active") {
      beginAccounting(ctx);
      return;
    }

    const now = Date.now();
    const elapsed = accounting.lastAccountedAt === null ? 0 : Math.floor((now - accounting.lastAccountedAt) / 1000);
    const currentContextTokens = ctx.getContextUsage()?.tokens ?? null;
    const tokenDelta =
      currentContextTokens !== null && accounting.lastContextTokens !== null
        ? Math.max(0, currentContextTokens - accounting.lastContextTokens)
        : 0;

    accounting.lastAccountedAt = now;
    accounting.lastContextTokens = currentContextTokens;

    const result = applyUsage(goal, tokenDelta, elapsed);
    if (!result.changed || !result.goal) {
      return;
    }

    persistGoal(result.goal, "runtime");
    refreshUi(ctx);

    if (
      allowBudgetSteering &&
      result.crossedBudget &&
      accounting.budgetWarningSentFor !== result.goal.goalId
    ) {
      accounting.budgetWarningSentFor = result.goal.goalId;
      pi.sendMessage(
        {
          customType: CUSTOM_ENTRY_TYPE,
          content: budgetLimitPrompt(result.goal),
          display: false,
          details: { kind: "budget_limit", goalId: result.goal.goalId },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  };

  const maybeContinue = (ctx: ExtensionContext): void => {
    if (!goal || goal.status !== "active" || continuationQueuedFor === goal.goalId) {
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      return;
    }

    continuationQueuedFor = goal.goalId;
    pi.sendMessage(
      {
        customType: CUSTOM_ENTRY_TYPE,
        content: continuationPrompt(goal),
        display: false,
        details: { kind: "continuation", goalId: goal.goalId },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  registerGoalTools(pi, {
    getGoal: () => goalForDisplay(),
    setGoal(nextGoal, source, ctx) {
      persistGoal(nextGoal, source);
      refreshUi(ctx);
    },
  });

  registerGoalCommand(pi, {
    getGoal: () => goalForDisplay(),
    setGoal(nextGoal, source, ctx) {
      persistGoal(nextGoal, source);
      beginAccounting(ctx);
      refreshUi(ctx);
    },
    clearGoal(source, ctx) {
      persistClear(source);
      refreshUi(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    reloadFromSession(ctx);
    beginAccounting(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    reloadFromSession(ctx);
    beginAccounting(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    continuationQueuedFor = null;
    beginAccounting(ctx);
    refreshUi(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    accountProgress(ctx, true);
  });

  pi.on("turn_end", async (_event, ctx) => {
    accountProgress(ctx, false);
    maybeContinue(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    accountProgress(ctx, false);
    maybeContinue(ctx);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    accountProgress(ctx, false);
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (goal) {
      persistGoal(goal, "runtime");
    }
    refreshUi(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    accountProgress(ctx, false);
    stopStatusRefresh();
  });
}
