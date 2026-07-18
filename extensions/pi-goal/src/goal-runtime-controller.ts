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
import { createGoalRuntimeStatus, type StatusContext } from "./goal-runtime-status.js";
import { createGoalStateController } from "./goal-state-controller.js";
import { createGoalToolPolicyController, type ActiveGoalToolPolicy } from "./goal-tool-policy.js";
import { ensureGoalConfigFiles, loadGoalSettings } from "./goal-settings.js";
import { createProviderLimitAutoResumeScheduler } from "./provider-limit-auto-resume.js";
import { compactContinuationPrompt } from "./prompts.js";
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
  getGoalForMutation(): ThreadGoal | null;
  getGoalStartTurnStrategy(): GoalStartTurnStrategy;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  blockGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
  completeGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
  configureGoalToolPolicy(policy: ActiveGoalToolPolicy): void;
  releaseGoalToolPolicy(): void;
  syncGoalToolPolicy(): void;
  resumeGoalWithContinuation(
    goalId: string,
    source: GoalEntrySource,
    ctx: StatusContext,
  ): GoalResult;
}

export function createGoalRuntimeController(pi: ExtensionAPI): GoalRuntimeController {
  const runtimeState = createGoalRuntimeState();
  const persistence = createGoalPersistence({ pi });
  const goalToolPolicy = createGoalToolPolicyController(pi);

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

  let autoResumeContext: ExtensionContext | null = null;
  const providerLimitAutoResume = createProviderLimitAutoResumeScheduler({
    onTimer(goalId) {
      if (
        !autoResumeContext ||
        !autoResumeContext.isIdle() ||
        autoResumeContext.hasPendingMessages()
      ) {
        return false;
      }
      resumeGoalWithContinuation(goalId, "runtime", autoResumeContext);
      return true;
    },
  });

  const status = createGoalRuntimeStatus({
    getGoalForDisplay: goalForDisplay,
    getGoalStatus: () => persistence.getGoal()?.status ?? null,
    getRecoveryAttention: () => runtimeState.recoveryState.attention,
    isProviderLimitAutoResumeScheduled: providerLimitAutoResume.isScheduledFor,
  });

  const continuation = createContinuationScheduler({
    pi,
    getGoal: () => persistence.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    staleQueuedWorkGuard: runtimeState.staleQueuedWorkGuard,
    getCurrentTurnIndex: () => runtimeState.currentTurnIndex,
    getAgentRunSequence: () => runtimeState.agentRunSequence,
  });

  const stateController = createGoalStateController({
    pi,
    persistence,
    getRecoveryState: () => runtimeState.recoveryState,
    transitionEffectHandlers: {
      clearContinuation: continuation.clearContinuationState,
      clearActiveAccounting,
      resetRecovery: resetErrorRecovery,
      clearTimeLimitWarning: () => {
        runtimeState.accounting.timeLimitWarningSentFor = null;
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
    syncGoalToolPolicy: goalToolPolicy.sync,
    refreshUi: (ctx) => status.refreshUi(ctx),
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
    pauseGoalForRecovery(ctx, recoveryReason) {
      stateController.applyGoalTransition({ kind: "recovery_pause", recoveryReason }, ctx);
    },
    refreshUi: status.refreshUi,
    maybeContinue: continuation.maybeContinue,
    scheduleProviderLimitAutoResume(goalId, ctx) {
      autoResumeContext = ctx;
      providerLimitAutoResume.schedule(goalId);
      status.refreshUi(ctx);
    },
  });

  const resumeGoalWithContinuation = (
    goalId: string,
    _source: GoalEntrySource,
    ctx: StatusContext,
  ): GoalResult => {
    const result = updateGoalStatus(stateController.getGoal(), "active");
    if (!result.ok || !result.goal || result.goal.goalId !== goalId) {
      return result;
    }
    providerLimitAutoResume.clear();
    stateController.resumeStoppedGoal(ctx);
    const resumedGoal = stateController.getGoal();
    if (resumedGoal?.status === "active" && resumedGoal.goalId === goalId) {
      pi.sendUserMessage(compactContinuationPrompt(resumedGoal), { deliverAs: "followUp" });
    }
    return result;
  };

  const eventHandlers = createGoalRuntimeEventHandlers({
    pi,
    runtimeState,
    stateController,
    continuation,
    goalAccounting,
    recoveryRuntime,
    status,
    providerLimitAutoResume,
    clearActiveAccounting,
    resetErrorRecovery,
    resumeGoalWithContinuation,
  });

  const completeGoal = (source: GoalEntrySource, ctx: ExtensionContext): GoalResult => {
    providerLimitAutoResume.clear();
    goalAccounting.accountProgress(ctx, false, 0, true);
    return stateController.completeGoal(source, ctx);
  };

  const blockGoal = (source: GoalEntrySource, ctx: ExtensionContext): GoalResult => {
    providerLimitAutoResume.clear();
    goalAccounting.accountProgress(ctx, false, 0, true);
    return stateController.blockGoal(source, ctx);
  };

  return {
    getGoalForDisplay: goalForDisplay,
    getGoalForMutation: stateController.getGoal,
    getGoalStartTurnStrategy: () => goalStartTurnStrategy(runtimeState.recoveryState.phase),
    setGoal(nextGoal, source, ctx) {
      providerLimitAutoResume.clear();
      stateController.applyGoalTransition({ kind: "set", nextGoal, source }, ctx);
    },
    blockGoal,
    completeGoal,
    configureGoalToolPolicy(policy) {
      goalToolPolicy.configure(policy);
      goalToolPolicy.sync(stateController.getGoal());
    },
    releaseGoalToolPolicy: goalToolPolicy.release,
    resumeGoalWithContinuation,
    syncGoalToolPolicy() {
      goalToolPolicy.sync(stateController.getGoal());
    },
    ...eventHandlers,
  };
}

export function registerGoalRuntimeController(pi: ExtensionAPI): void {
  const controller = createGoalRuntimeController(pi);
  registerGoalTools(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    setGoal: controller.setGoal.bind(controller),
    blockGoal: controller.blockGoal.bind(controller),
    completeGoal: controller.completeGoal.bind(controller),
  });
  registerGoalCommand(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    getGoalForAdjustment: () => controller.getGoalForMutation(),
    getGoalStartTurnStrategy: controller.getGoalStartTurnStrategy.bind(controller),
    setGoal: controller.setGoal.bind(controller),
    resumeGoalWithContinuation: controller.resumeGoalWithContinuation.bind(controller),
  });
  pi.on("session_start", (_event, ctx) => {
    try {
      ensureGoalConfigFiles();
    } catch {
      ctx.ui.notify("Could not initialize pi-codex-goal settings files.", "warning");
    }
    const loaded = loadGoalSettings(ctx);
    if (!loaded.ok) {
      controller.configureGoalToolPolicy({ disabledTools: [] });
      ctx.ui.notify(loaded.message, "warning");
      return;
    }
    controller.configureGoalToolPolicy(loaded.settings.activeGoalToolPolicy);
  });
  registerGoalRuntimeEvents(pi, controller);
  pi.on("before_agent_start", () => {
    controller.syncGoalToolPolicy();
  });
  pi.on("tool_execution_end", () => {
    controller.syncGoalToolPolicy();
  });
  pi.on("session_shutdown", () => {
    controller.releaseGoalToolPolicy();
  });
}
