import type {
  ExtensionContext,
  ExtensionHandler,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";

import { compactContinuationPrompt } from "./prompts.js";
import { recoveryPhaseBlocksContinuation } from "./recovery-machine.js";
import { isRecoveryPendingAttention, reasonFromRecoveryPendingAttention } from "./recovery.js";
import { applyStaleQueuedWorkEffects, runStaleQueuedWorkPlan } from "./goal-runtime-event-utils.js";
import type { GoalRuntimeSessionHandlerContext } from "./goal-runtime-event-handler-types.js";

export function createSessionEventHandlers(deps: GoalRuntimeSessionHandlerContext) {
  const {
    pi,
    runtimeState,
    stateController,
    continuation,
    goalAccounting,
    recoveryRuntime,
    status,
    resetErrorRecovery,
  } = deps;

  return {
    onSessionStart: (async (event, ctx) => {
      stateController.reloadFromSession(ctx);
      goalAccounting.beginAccounting();
      const goal = stateController.getGoal();
      const pausedGoal = goal?.status === "paused" ? goal : null;
      if (event.reason === "resume" && pausedGoal && ctx.hasUI) {
        const shouldResume = await ctx.ui.confirm(
          "Resume paused goal?",
          `Goal: ${pausedGoal.objective}`,
        );
        if (shouldResume) {
          stateController.resumePausedGoal(ctx);
          goalAccounting.beginAccounting();
          const resumedGoal = stateController.getGoal();
          if (resumedGoal?.status === "active") {
            pi.sendUserMessage(compactContinuationPrompt(resumedGoal), { deliverAs: "followUp" });
          }
          return;
        }
      }
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<SessionStartEvent>,

    onSessionTree: (async (_event, ctx) => {
      stateController.reloadFromSession(ctx);
      goalAccounting.beginAccounting();
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<SessionTreeEvent>,

    onSessionBeforeCompact: (async (_event, ctx) => {
      if (
        runStaleQueuedWorkPlan(
          runtimeState.staleQueuedWorkGuard.planSessionBeforeCompact(),
          ctx,
          deps,
        )
      ) {
        return;
      }

      goalAccounting.accountProgress(ctx, false, 0, true);
      stateController.flushGoalPersistence("runtime");
    }) satisfies ExtensionHandler<SessionBeforeCompactEvent>,

    onSessionCompact: (async (_event, ctx) => {
      if (runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planSessionCompact(), ctx, deps)) {
        return;
      }

      stateController.flushGoalPersistence("runtime");
      recoveryRuntime.onSessionCompact();
      status.refreshUi(ctx);
      if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {
        continuation.maybeContinue(ctx);
      }
    }) satisfies ExtensionHandler<SessionCompactEvent>,

    onSessionShutdown: (async (_event, ctx) => {
      continuation.clearPassthroughContinuationInput();
      applyStaleQueuedWorkEffects(runtimeState.staleQueuedWorkGuard.planSessionShutdown().effects, ctx, deps);

      goalAccounting.accountProgress(ctx, false, 0, true);
      stateController.flushGoalPersistence("runtime");
      continuation.clearContinuationTimer();
      if (hasPendingRecoveryAttention(deps)) {
        pauseForPendingRecoveryShutdown(ctx, deps);
      } else {
        resetErrorRecovery();
      }
      status.stopStatusRefresh();
    }) satisfies ExtensionHandler<SessionShutdownEvent>,
  };
}

function hasPendingRecoveryAttention({ runtimeState, stateController }: GoalRuntimeSessionHandlerContext): boolean {
  const goal = stateController.getGoal();
  return Boolean(
    goal?.status === "active" && isRecoveryPendingAttention(runtimeState.recoveryState.attention),
  );
}

function pauseForPendingRecoveryShutdown(
  ctx: ExtensionContext,
  deps: GoalRuntimeSessionHandlerContext,
): void {
  const { runtimeState, stateController } = deps;
  const goal = stateController.getGoal();
  if (!goal || goal.status !== "active" || !runtimeState.recoveryState.attention) {
    return;
  }

  const reason = reasonFromRecoveryPendingAttention(runtimeState.recoveryState.attention);
  if (!reason) {
    return;
  }

  stateController.applyGoalTransition(
    {
      kind: "recovery_shutdown_pause",
      recoveryReason: reason,
    },
    ctx,
  );
}
