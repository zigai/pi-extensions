import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGoalCommand } from "./commands.js";
import { createContinuationScheduler } from "./continuation-scheduler.js";
import { createGoalAccounting } from "./goal-accounting.js";
import { createGoalPersistence } from "./goal-persistence.js";
import {
  createGoalRuntimeEventHandlers,
  type GoalRuntimeEventHandlers,
} from "./goal-runtime-event-handlers.js";
import { registerGoalRuntimeEvents } from "./goal-runtime-events.js";
import { createGoalRuntimeState } from "./goal-runtime-state.js";
import { createGoalRuntimeStatus } from "./goal-runtime-status.js";
import { createGoalStateController } from "./goal-state-controller.js";
import { createGoalRecoveryRuntime } from "./recovery-runtime.js";
import {
  clearActiveHostOverflowRecovery,
  goalStartTurnStrategy,
  resetRecoveryMachine,
  setRecoveryPausedAttention,
  type GoalStartTurnStrategy,
} from "./recovery-machine.js";
import { goalWithLiveUsage, updateGoalStatus } from "./state.js";
import { registerGoalTools } from "./tools.js";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.js";

export interface GoalRuntimeController extends GoalRuntimeEventHandlers {
  getGoalForDisplay(): ThreadGoal | null;
  getGoalStartTurnStrategy(): GoalStartTurnStrategy;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  clearGoal(source: GoalEntrySource, ctx: ExtensionContext): void;
  completeGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
}

export function createGoalRuntimeController(pi: ExtensionAPI): GoalRuntimeController {
  const runtimeState = createGoalRuntimeState();
  const persistence = createGoalPersistence({ pi });

  const clearActiveAccounting = (): void => {
    runtimeState.accounting.activeGoalId = null;
    runtimeState.accounting.lastAccountedAt = null;
  };

  const resetErrorRecovery = (): void => {
    resetRecoveryMachine(runtimeState.recoveryState);
  };

  const goalForDisplay = () =>
    goalWithLiveUsage(
      persistence.getGoal(),
      runtimeState.accounting.activeGoalId,
      runtimeState.accounting.lastAccountedAt,
    );

  const status = createGoalRuntimeStatus({
    getGoalForDisplay: goalForDisplay,
    getGoalStatus: () => persistence.getGoal()?.status ?? null,
    getRecoveryAttention: () => runtimeState.recoveryState.attention,
  });

  const continuation = createContinuationScheduler({
    pi,
    getGoal: () => persistence.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    staleQueuedWorkGuard: runtimeState.staleQueuedWorkGuard,
    getCurrentTurnIndex: () => runtimeState.currentTurnIndex,
  });

  const stateController = createGoalStateController({
    pi,
    persistence,
    getRecoveryState: () => runtimeState.recoveryState,
    transitionEffectHandlers: {
      clearContinuation: continuation.clearContinuationState,
      clearActiveAccounting,
      resetRecovery: resetErrorRecovery,
      clearBudgetWarning: () => {
        runtimeState.accounting.budgetWarningSentFor = null;
      },
      clearHostOverflowRecovery: () => {
        clearActiveHostOverflowRecovery(runtimeState.recoveryState);
      },
      setRecoveryPausedAttention: (reason: string) => {
        setRecoveryPausedAttention(runtimeState.recoveryState, reason);
      },
      markContinuationQueued: continuation.markContinuationQueued,
      stopStatusRefresh: () => status.stopStatusRefresh(),
    },
    refreshUi: (ctx) => status.refreshUi(ctx),
    clearContinuationState: continuation.clearContinuationState,
    clearActiveAccounting,
    resetErrorRecovery,
  });

  const goalAccounting = createGoalAccounting({
    getGoal: () => stateController.getGoal(),
    getAccounting: () => runtimeState.accounting,
    applyRuntimeAccountingTransition(ctx, nextGoal) {
      stateController.applyGoalTransition({ kind: "runtime_accounting", nextGoal }, ctx);
    },
    sendMessage: pi.sendMessage.bind(pi),
  });

  const recoveryRuntime = createGoalRecoveryRuntime({
    getGoal: () => stateController.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    clearContinuationState: continuation.clearContinuationState,
    pauseGoalForRecovery(ctx, activeGoal, recoveryReason) {
      const result = updateGoalStatus(activeGoal, "paused");
      if (!result.ok || !result.goal) {
        return;
      }
      stateController.applyGoalTransition(
        { kind: "recovery_pause", nextGoal: result.goal, recoveryReason },
        ctx,
      );
    },
    refreshUi: status.refreshUi,
    maybeContinue: continuation.maybeContinue,
  });

  const eventHandlers = createGoalRuntimeEventHandlers({
    pi,
    runtimeState,
    stateController,
    continuation,
    goalAccounting,
    recoveryRuntime,
    status,
    clearActiveAccounting,
    resetErrorRecovery,
  });

  const completeGoal = (source: GoalEntrySource, ctx: ExtensionContext): GoalResult => {
    goalAccounting.accountProgress(ctx, false, 0, true);
    return stateController.completeGoal(source, ctx);
  };

  return {
    getGoalForDisplay: goalForDisplay,
    getGoalStartTurnStrategy: () => goalStartTurnStrategy(runtimeState.recoveryState.phase),
    setGoal(nextGoal, source, ctx) {
      stateController.applyGoalTransition({ kind: "set", nextGoal, source }, ctx);
    },
    clearGoal(source, ctx) {
      stateController.applyGoalTransition({ kind: "clear", source }, ctx);
    },
    completeGoal,
    ...eventHandlers,
  };
}

export function registerGoalRuntimeController(pi: ExtensionAPI): void {
  const controller = createGoalRuntimeController(pi);
  registerGoalTools(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    setGoal: controller.setGoal.bind(controller),
    completeGoal: controller.completeGoal.bind(controller),
  });
  registerGoalCommand(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    getGoalStartTurnStrategy: controller.getGoalStartTurnStrategy.bind(controller),
    setGoal: controller.setGoal.bind(controller),
    clearGoal: controller.clearGoal.bind(controller),
  });
  registerGoalRuntimeEvents(pi, controller);
}
