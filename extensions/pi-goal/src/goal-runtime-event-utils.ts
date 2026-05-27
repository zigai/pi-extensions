import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
  GoalRuntimeContinuationPort,
  GoalRuntimeEventContext,
  QueuedGoalWorkMessage,
  QueuedGoalWorkMessageIdResolver,
} from "./goal-runtime-event-handler-types.js";
import { extensionQueuedGoalWorkMessageIdForRuntime } from "./queued-goal-work.js";
import {
  isAssistantContextOverflow,
  isContextOverflowError,
  isErrorAssistantMessage,
  type AssistantErrorMessage,
} from "./recovery.js";
import type { StaleQueuedWorkEffect, StaleQueuedWorkPlan } from "./stale-queued-work-guard.js";

export function applyStaleQueuedWorkEffects(
  effects: readonly StaleQueuedWorkEffect[],
  ctx: ExtensionContext,
  context: GoalRuntimeEventContext,
): void {
  for (const effect of effects) {
    switch (effect.type) {
      case "clearAccounting":
        context.clearActiveAccounting();
        break;
      case "refreshUi":
        context.status.refreshUi(ctx);
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

export function runStaleQueuedWorkPlan(
  plan: StaleQueuedWorkPlan,
  ctx: ExtensionContext,
  context: GoalRuntimeEventContext,
): boolean {
  applyStaleQueuedWorkEffects(plan.effects, ctx, context);
  return plan.skip;
}

export function createQueuedGoalWorkMessageIdResolver(
  continuation: GoalRuntimeContinuationPort,
): QueuedGoalWorkMessageIdResolver {
  return (message: QueuedGoalWorkMessage): string | null =>
    extensionQueuedGoalWorkMessageIdForRuntime(
      message,
      continuation.continuationGoalIdFromRuntimePrompt,
    );
}

export function getContextWindow(ctx: ExtensionContext): number {
  return ctx.model?.contextWindow ?? 0;
}

export function recordAssistantContextOverflow(
  message: AssistantErrorMessage,
  ctx: ExtensionContext,
  context: GoalRuntimeEventContext,
): boolean {
  if (!isAssistantContextOverflow(message, getContextWindow(ctx))) {
    return false;
  }

  context.stateController.beginOverflowRecovery(ctx);
  if (isErrorAssistantMessage(message)) {
    context.recoveryRuntime.handlePersistentAssistantError(message, ctx);
  } else {
    context.recoveryRuntime.handleSilentContextOverflow(ctx);
  }
  return true;
}

export function handleAgentErrorMessage(
  message: AssistantErrorMessage,
  ctx: ExtensionContext,
  context: GoalRuntimeEventContext,
): void {
  recordAssistantContextOverflow(message, ctx, context);
  if (!isContextOverflowError(message.errorMessage)) {
    context.recoveryRuntime.handlePersistentAssistantError(message, ctx);
  }
}
