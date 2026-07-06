import type {
  ExtensionContext,
  ExtensionHandler,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

import { assistantTurnTokens, isAbortedAssistantMessage, isToolUseAssistantMessage } from "./goal-accounting.js";
import { isAssistantContextOverflow, isErrorAssistantMessage } from "./recovery.js";
import { getContextWindow, runStaleQueuedWorkPlan } from "./goal-runtime-event-utils.js";
import { proactiveCompactionDue } from "./proactive-compaction.js";
import { recoveryPhaseBlocksContinuation } from "./recovery-machine.js";
import { PROACTIVE_COMPACTION_RESERVE_TOKENS } from "./runtime-config.js";
import type {
  GoalRuntimeTurnHandlerContext,
  ToolExecutionEndEvent,
} from "./goal-runtime-event-handler-types.js";

export function createTurnEventHandlers(deps: GoalRuntimeTurnHandlerContext) {
  const { runtimeState, stateController, continuation, goalAccounting, recoveryRuntime, status } = deps;

  const maybeStartProactiveCompaction = (
    message: TurnEndEvent["message"],
    ctx: ExtensionContext,
  ): void => {
    if (runtimeState.proactiveCompactionPending) {
      return;
    }
    if (!isToolUseAssistantMessage(message)) {
      return;
    }
    const goal = stateController.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }
    if (recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {
      return;
    }
    if (!proactiveCompactionDue(ctx.getContextUsage(), PROACTIVE_COMPACTION_RESERVE_TOKENS)) {
      return;
    }

    // ctx.compact() aborts the in-flight agent run before compacting. The
    // pending flag suppresses the abort-pause in the turn/agent handlers;
    // session_compact then clears it and resumes the goal via continuation.
    runtimeState.proactiveCompactionPending = true;
    ctx.compact({
      onError: () => {
        runtimeState.proactiveCompactionPending = false;
        stateController.pauseForAbort(ctx);
      },
    });
  };

  return {
    onTurnStart: (async (event, ctx) => {
      runtimeState.currentTurnIndex = event.turnIndex;
      continuation.bindPassthroughContinuationInputToTurn(event.turnIndex);
      runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planTurnStart(), ctx, deps);
      goalAccounting.beginAccounting();
      status.refreshUi(ctx);
    }) satisfies ExtensionHandler<TurnStartEvent>,

    onToolExecutionEnd: (async (_event, ctx) => {
      if (runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planToolExecutionEnd(), ctx, deps)) {
        return;
      }

      goalAccounting.accountProgress(ctx, true, 0, true);
      stateController.maybeFlushRuntimePersistence("runtime");
    }) satisfies ExtensionHandler<ToolExecutionEndEvent>,

    onTurnEnd: (async (event, ctx) => {
      if (
        runStaleQueuedWorkPlan(
          runtimeState.staleQueuedWorkGuard.planTurnEnd(event.turnIndex),
          ctx,
          deps,
        )
      ) {
        return;
      }

      const completedTurnTokens = assistantTurnTokens(event.message);
      goalAccounting.accountProgress(ctx, true, completedTurnTokens);
      stateController.flushGoalPersistence("runtime");
      if (isAbortedAssistantMessage(event.message)) {
        if (runtimeState.proactiveCompactionPending) {
          return;
        }
        stateController.pauseForAbort(ctx);
        return;
      }
      if (isErrorAssistantMessage(event.message)) {
        return;
      }
      if (isAssistantContextOverflow(event.message, getContextWindow(ctx))) {
        stateController.beginOverflowRecovery(ctx);
        return;
      }
      recoveryRuntime.finishSuccessfulAssistantTurn(event.message, ctx, {
        continueGoal: !isToolUseAssistantMessage(event.message),
      });
      maybeStartProactiveCompaction(event.message, ctx);
    }) satisfies ExtensionHandler<TurnEndEvent>,
  };
}
