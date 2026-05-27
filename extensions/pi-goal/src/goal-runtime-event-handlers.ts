import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ExtensionHandler,
  InputEvent,
  InputEventResult,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

import { assistantTurnTokens, isAbortedAssistantMessage, isToolUseAssistantMessage } from "./goal-accounting.js";
import type { GoalRuntimeState } from "./goal-runtime-state.js";
import type { GoalStateController } from "./goal-state-controller.js";
import { compactContinuationPrompt, continuationGoalIdFromPrompt } from "./prompts.js";
import { isCommandResumeQueuedGoalMessage } from "./queued-goal-messages.js";
import {
  applyQueuedGoalProviderContextRewrites,
  extensionQueuedGoalWorkMessageId,
  extensionQueuedGoalWorkMessageIdForRuntime,
} from "./queued-goal-work.js";
import type { StaleQueuedWorkEffect } from "./stale-queued-work-guard.js";
import { updateGoalStatus } from "./state.js";
import {
  clearActiveHostOverflowRecovery,
  recoveryPhaseBlocksContinuation,
  resetRecoveryMachine,
  setRecoveryPausedAttention,
} from "./recovery-machine.js";
import {
  isAssistantContextOverflow,
  isContextOverflowError,
  isErrorAssistantMessage,
  isRecoveryPendingAttention,
  reasonFromRecoveryPendingAttention,
  type AssistantErrorMessage,
} from "./recovery.js";

export type ContextEventResult = { messages?: ContextEvent["messages"] };
export type MessageStartEvent = Extract<ExtensionEvent, { type: "message_start" }>;
export type ToolExecutionEndEvent = Extract<ExtensionEvent, { type: "tool_execution_end" }>;

export interface GoalRuntimeEventHandlers {
  onInput: ExtensionHandler<InputEvent, InputEventResult>;
  onContext: ExtensionHandler<ContextEvent, ContextEventResult | undefined>;
  onSessionStart: ExtensionHandler<SessionStartEvent>;
  onSessionTree: ExtensionHandler<SessionTreeEvent>;
  onBeforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, undefined>;
  onMessageStart: ExtensionHandler<MessageStartEvent>;
  onTurnStart: ExtensionHandler<TurnStartEvent>;
  onToolExecutionEnd: ExtensionHandler<ToolExecutionEndEvent>;
  onTurnEnd: ExtensionHandler<TurnEndEvent>;
  onAgentEnd: ExtensionHandler<AgentEndEvent>;
  onSessionBeforeCompact: ExtensionHandler<SessionBeforeCompactEvent>;
  onSessionCompact: ExtensionHandler<SessionCompactEvent>;
  onSessionShutdown: ExtensionHandler<SessionShutdownEvent>;
}

interface GoalRuntimeStatusPort {
  refreshUi: (ctx: ExtensionContext) => void;
  stopStatusRefresh: () => void;
}

interface GoalRuntimeContinuationPort {
  bindPassthroughContinuationInputToTurn: (turnIndex: number) => void;
  clearContinuationState: () => void;
  clearContinuationStateFor: (goalId: string) => void;
  clearContinuationTimer: () => void;
  clearPassthroughContinuationInput: () => void;
  continuationGoalIdFromRuntimePrompt: (prompt: string) => string | null;
  maybeContinue: (ctx: ExtensionContext) => void;
  notePassthroughContinuationInput: (input: string) => void;
}

interface GoalAccountingPort {
  accountProgress: (
    ctx: ExtensionContext,
    includeActiveElapsed: boolean,
    completedTurnTokens: number,
    forceFlush?: boolean,
  ) => void;
  beginAccounting: () => void;
}

interface RecoveryRuntimePort {
  finishSuccessfulAssistantTurn: (
    message: TurnEndEvent["message"],
    ctx: ExtensionContext,
    options: { continueGoal: boolean },
  ) => void;
  handlePersistentAssistantError: (message: AssistantErrorMessage, ctx: ExtensionContext) => void;
  handleSilentContextOverflow: (ctx: ExtensionContext) => void;
  onSessionCompact: () => void;
  onUserInput: () => void;
}

interface GoalRuntimeEventHandlerDeps {
  pi: ExtensionAPI;
  runtimeState: GoalRuntimeState;
  stateController: GoalStateController;
  continuation: GoalRuntimeContinuationPort;
  goalAccounting: GoalAccountingPort;
  recoveryRuntime: RecoveryRuntimePort;
  status: GoalRuntimeStatusPort;
  clearActiveAccounting: () => void;
  resetErrorRecovery: () => void;
}

function applyStaleQueuedWorkEffects(
  effects: readonly StaleQueuedWorkEffect[],
  ctx: ExtensionContext,
  deps: Pick<GoalRuntimeEventHandlerDeps, "clearActiveAccounting" | "status">,
): void {
  for (const effect of effects) {
    switch (effect.type) {
      case "clearAccounting":
        deps.clearActiveAccounting();
        break;
      case "refreshUi":
        deps.status.refreshUi(ctx);
        break;
      case "abort":
        ctx.abort();
        break;
      default: {
        const _exhaustive: never = effect;
        throw new Error(`Unhandled stale queued-work effect: ${String(_exhaustive)}`);
      }
    }
  }
}

function getContextWindow(ctx: ExtensionContext): number {
  return ctx.model?.contextWindow ?? 0;
}

function hasPendingRecoveryAttention({ runtimeState, stateController }: GoalRuntimeEventHandlerDeps): boolean {
  const goal = stateController.getGoal();
  return Boolean(
    goal?.status === "active" && isRecoveryPendingAttention(runtimeState.recoveryState.attention),
  );
}

function pauseForPendingRecoveryShutdown(ctx: ExtensionContext, deps: GoalRuntimeEventHandlerDeps): void {
  const { runtimeState, stateController } = deps;
  const goal = stateController.getGoal();
  if (!goal || goal.status !== "active" || !runtimeState.recoveryState.attention) {
    return;
  }

  const reason = reasonFromRecoveryPendingAttention(runtimeState.recoveryState.attention);
  if (!reason) {
    return;
  }

  const result = updateGoalStatus(goal, "paused");
  if (!result.ok || !result.goal) {
    return;
  }

  stateController.applyGoalTransition(
    {
      kind: "recovery_shutdown_pause",
      nextGoal: result.goal,
      recoveryReason: reason,
    },
    ctx,
  );
}

function recordAssistantContextOverflow(
  message: AssistantErrorMessage,
  ctx: ExtensionContext,
  deps: GoalRuntimeEventHandlerDeps,
): boolean {
  if (!isAssistantContextOverflow(message, getContextWindow(ctx))) {
    return false;
  }

  deps.stateController.beginOverflowRecovery(ctx);
  if (isErrorAssistantMessage(message)) {
    deps.recoveryRuntime.handlePersistentAssistantError(message, ctx);
  } else {
    deps.recoveryRuntime.handleSilentContextOverflow(ctx);
  }
  return true;
}

export function createGoalRuntimeEventHandlers(deps: GoalRuntimeEventHandlerDeps): GoalRuntimeEventHandlers {
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

  const applyStaleEffects = (effects: readonly StaleQueuedWorkEffect[], ctx: ExtensionContext) =>
    applyStaleQueuedWorkEffects(effects, ctx, deps);

  const queuedGoalWorkMessageIdForRuntime = (message: {
    role: string;
    customType?: string;
    details?: unknown;
    content?: unknown;
  }): string | null =>
    extensionQueuedGoalWorkMessageIdForRuntime(
      message,
      continuation.continuationGoalIdFromRuntimePrompt,
    );

  return {
    onInput: (async (event, ctx) => {
      continuation.clearPassthroughContinuationInput();
      const continuationGoalId = continuationGoalIdFromPrompt(event.text);

      if (event.source !== "extension") {
        recoveryRuntime.onUserInput();
        applyStaleEffects(runtimeState.staleQueuedWorkGuard.planUserInputClearAbort().effects, ctx);
        if (continuationGoalId !== null) {
          continuation.notePassthroughContinuationInput(event.text);
        }
        return undefined;
      }

      if (continuationGoalId === null) {
        return undefined;
      }

      applyStaleEffects(
        runtimeState.staleQueuedWorkGuard.planExtensionContinuationClearAbort().effects,
        ctx,
      );
      continuation.clearContinuationStateFor(continuationGoalId);
      if (stateController.isCurrentActiveGoalId(continuationGoalId)) {
        return { action: "continue" } as const;
      }

      status.refreshUi(ctx);
      return { action: "handled" } as const;
    }) satisfies ExtensionHandler<InputEvent, InputEventResult>,

    onContext: (async (event, ctx) => {
      const { messages, changed } = applyQueuedGoalProviderContextRewrites(event.messages, {
        goal: stateController.getGoal(),
        resolveStaleQueuedGoalWorkMessageId: queuedGoalWorkMessageIdForRuntime,
        resolveActiveContinuationQueuedGoalWorkMessageId: extensionQueuedGoalWorkMessageId,
      });

      const contextAbortPlan = runtimeState.staleQueuedWorkGuard.planContextAbort(
        runtimeState.currentTurnIndex,
      );
      if (contextAbortPlan !== null) {
        applyStaleEffects(contextAbortPlan.effects, ctx);
      }

      return changed ? { messages } : undefined;
    }) satisfies ExtensionHandler<ContextEvent, ContextEventResult | undefined>,

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

    onBeforeAgentStart: (async (event, ctx) => {
      const continuationGoalId = continuation.continuationGoalIdFromRuntimePrompt(event.prompt);
      if (continuationGoalId !== null) {
        continuation.clearContinuationStateFor(continuationGoalId);
        if (!stateController.isCurrentActiveGoalId(continuationGoalId)) {
          status.refreshUi(ctx);
          return undefined;
        }
        applyStaleEffects(runtimeState.staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects, ctx);
      } else {
        applyStaleEffects(runtimeState.staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects, ctx);
        continuation.clearContinuationState();
      }
      return undefined;
    }) satisfies ExtensionHandler<BeforeAgentStartEvent, undefined>,

    onMessageStart: (async (event, _ctx) => {
      if (event.message.role === "user") {
        stateController.persistHostOverflowUserReset(false);
      }

      const queuedGoalId = queuedGoalWorkMessageIdForRuntime(event.message);
      if (queuedGoalId === null) {
        if (event.message.role === "user" || event.message.role === "custom") {
          runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
          continuation.clearContinuationState();
        }
        return;
      }

      continuation.clearContinuationStateFor(queuedGoalId);
      if (stateController.isCurrentActiveGoalId(queuedGoalId)) {
        runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
        if (isCommandResumeQueuedGoalMessage(event.message)) {
          resetErrorRecovery();
        }
        return;
      }

      runtimeState.staleQueuedWorkGuard.noteStaleWorkStarted(queuedGoalId);
    }) satisfies ExtensionHandler<MessageStartEvent>,

    onTurnStart: (async (event, ctx) => {
      runtimeState.currentTurnIndex = event.turnIndex;
      continuation.bindPassthroughContinuationInputToTurn(event.turnIndex);
      applyStaleEffects(runtimeState.staleQueuedWorkGuard.planTurnStart().effects, ctx);
      goalAccounting.beginAccounting();
      status.refreshUi(ctx);
    }) satisfies ExtensionHandler<TurnStartEvent>,

    onToolExecutionEnd: (async (_event, ctx) => {
      const toolEndPlan = runtimeState.staleQueuedWorkGuard.planToolExecutionEnd();
      applyStaleEffects(toolEndPlan.effects, ctx);
      if (toolEndPlan.skip) {
        return;
      }

      goalAccounting.accountProgress(ctx, true, 0, true);
      stateController.maybeFlushRuntimePersistence("runtime");
    }) satisfies ExtensionHandler<ToolExecutionEndEvent>,

    onTurnEnd: (async (event, ctx) => {
      const turnEndPlan = runtimeState.staleQueuedWorkGuard.planTurnEnd(
        event.turnIndex,
        event.message,
      );
      applyStaleEffects(turnEndPlan.effects, ctx);
      if (turnEndPlan.skip) {
        return;
      }

      const completedTurnTokens = assistantTurnTokens(event.message);
      goalAccounting.accountProgress(ctx, true, completedTurnTokens);
      stateController.flushGoalPersistence("runtime");
      if (isAbortedAssistantMessage(event.message)) {
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
    }) satisfies ExtensionHandler<TurnEndEvent>,

    onAgentEnd: (async (event, ctx) => {
      continuation.clearPassthroughContinuationInput();
      const agentEndPlan = runtimeState.staleQueuedWorkGuard.planAgentEnd(event.messages);
      applyStaleEffects(agentEndPlan.effects, ctx);
      if (agentEndPlan.skip) {
        return;
      }

      const abortedMessages = event.messages.filter(isAbortedAssistantMessage);
      const abortedTurnTokens = abortedMessages.reduce((sum, message) => {
        return sum + assistantTurnTokens(message);
      }, 0);
      goalAccounting.accountProgress(ctx, false, abortedTurnTokens, true);
      stateController.flushGoalPersistence("runtime");
      if (abortedMessages.length > 0) {
        stateController.pauseForAbort(ctx);
        return;
      }
      const errorMessages = event.messages.filter(isErrorAssistantMessage);
      if (errorMessages.length > 0) {
        const lastError = errorMessages.at(-1) as AssistantErrorMessage | undefined;
        if (lastError) {
          recordAssistantContextOverflow(lastError, ctx, deps);
          if (!isContextOverflowError(lastError.errorMessage)) {
            recoveryRuntime.handlePersistentAssistantError(lastError, ctx);
          }
        }
        return;
      }

      const lastAssistant = [...event.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (lastAssistant && recordAssistantContextOverflow(lastAssistant, ctx, deps)) {
        return;
      }
      resetErrorRecovery();
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<AgentEndEvent>,

    onSessionBeforeCompact: (async (_event, ctx) => {
      const compactPlan = runtimeState.staleQueuedWorkGuard.planSessionBeforeCompact();
      applyStaleEffects(compactPlan.effects, ctx);
      if (compactPlan.skip) {
        return;
      }

      goalAccounting.accountProgress(ctx, false, 0, true);
      stateController.flushGoalPersistence("runtime");
    }) satisfies ExtensionHandler<SessionBeforeCompactEvent>,

    onSessionCompact: (async (_event, ctx) => {
      const compactPlan = runtimeState.staleQueuedWorkGuard.planSessionCompact();
      applyStaleEffects(compactPlan.effects, ctx);
      if (compactPlan.skip) {
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
      applyStaleEffects(runtimeState.staleQueuedWorkGuard.planSessionShutdown().effects, ctx);

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
