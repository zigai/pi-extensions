import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { timeLimitPrompt } from "./prompts.js";
import { applyUsage } from "./state.js";
import { CUSTOM_ENTRY_TYPE, type ThreadGoal } from "./types.js";

export interface AccountingState {
  activeGoalId: string | null;
  lastAccountedAt: number | null;
  timeLimitWarningSentFor: string | null;
}

export interface AssistantUsage {
  input: number;
  output: number;
}

export interface AssistantTurnMessage {
  role: string;
  stopReason?: string;
  usage?: AssistantUsage;
}

export function createAccountingState(): AccountingState {
  return {
    activeGoalId: null,
    lastAccountedAt: null,
    timeLimitWarningSentFor: null,
  };
}

function usageChannelTokens(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

export function assistantTurnTokens(message: AssistantTurnMessage): number {
  if (message.role !== "assistant" || !message.usage) {
    return 0;
  }
  return usageChannelTokens(message.usage.input) + usageChannelTokens(message.usage.output);
}

export function isAbortedAssistantMessage(message: AssistantTurnMessage): boolean {
  return message.role === "assistant" && message.stopReason === "aborted";
}

export function isToolUseAssistantMessage(message: AssistantTurnMessage): boolean {
  return message.role === "assistant" && message.stopReason === "toolUse";
}

interface GoalAccountingDeps {
  getGoal: () => ThreadGoal | null;
  getAccounting: () => AccountingState;
  applyRuntimeAccountingTransition: (ctx: ExtensionContext, nextGoal: ThreadGoal) => void;
  sendMessage: ExtensionAPI["sendMessage"];
}

export function createGoalAccounting(deps: GoalAccountingDeps) {
  const clearActiveAccounting = (): void => {
    const accounting = deps.getAccounting();
    accounting.activeGoalId = null;
    accounting.lastAccountedAt = null;
  };

  const beginAccounting = (): void => {
    const goal = deps.getGoal();
    const accounting = deps.getAccounting();
    if (!goal || goal.status !== "active") {
      accounting.activeGoalId = null;
      accounting.lastAccountedAt = null;
      return;
    }

    accounting.activeGoalId = goal.goalId;
    accounting.lastAccountedAt = Date.now();
  };

  const accountProgress = (
    ctx: ExtensionContext,
    allowTimeLimitSteering: boolean,
    completedTurnTokens = 0,
    accountTimeLimited = false,
  ): void => {
    const goal = deps.getGoal();
    const accounting = deps.getAccounting();
    const canAccount =
      goal?.status === "active" || (accountTimeLimited && goal?.status === "timeLimited");
    if (!goal || accounting.activeGoalId !== goal.goalId || !canAccount) {
      beginAccounting();
      return;
    }

    const now = Date.now();
    const elapsed =
      accounting.lastAccountedAt === null
        ? 0
        : Math.floor((now - accounting.lastAccountedAt) / 1000);
    accounting.lastAccountedAt = now;

    const result = applyUsage(goal, completedTurnTokens, elapsed, {
      expectedGoalId: accounting.activeGoalId,
      accountTimeLimited,
    });
    if (!result.changed || !result.goal) {
      return;
    }

    deps.applyRuntimeAccountingTransition(ctx, result.goal);

    if (
      allowTimeLimitSteering &&
      result.crossedTimeLimit &&
      accounting.timeLimitWarningSentFor !== result.goal.goalId
    ) {
      accounting.timeLimitWarningSentFor = result.goal.goalId;
      deps.sendMessage(
        {
          customType: CUSTOM_ENTRY_TYPE,
          content: timeLimitPrompt(result.goal),
          display: false,
          details: { kind: "time_limit", goalId: result.goal.goalId },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  };

  return {
    clearActiveAccounting,
    beginAccounting,
    accountProgress,
  };
}
