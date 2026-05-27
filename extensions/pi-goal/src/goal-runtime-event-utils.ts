import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { extensionQueuedGoalWorkMessageIdForRuntime } from "./queued-goal-work.js";
import {
  isAssistantContextOverflow,
  isContextOverflowError,
  isErrorAssistantMessage,
  type AssistantErrorMessage,
} from "./recovery.js";
import type { StaleQueuedWorkEffect, StaleQueuedWorkPlan } from "./stale-queued-work-guard.js";
import type {
  GoalRuntimeContinuationPort,
  QueuedGoalWorkMessage,
  QueuedGoalWorkMessageIdResolver,
  RecoveryEventDeps,
  StaleQueuedWorkRuntimePort,
} from "./goal-runtime-event-handler-types.js";

export function applyStaleQueuedWorkEffects(
  effects: readonly StaleQueuedWorkEffect[],
  ctx: ExtensionContext,
  deps: StaleQueuedWorkRuntimePort,
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

export function runStaleQueuedWorkPlan(
  plan: StaleQueuedWorkPlan,
  ctx: ExtensionContext,
  deps: StaleQueuedWorkRuntimePort,
): boolean {
  applyStaleQueuedWorkEffects(plan.effects, ctx, deps);
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
  deps: RecoveryEventDeps,
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

export function handleAgentErrorMessage(
  message: AssistantErrorMessage,
  ctx: ExtensionContext,
  deps: RecoveryEventDeps,
): void {
  recordAssistantContextOverflow(message, ctx, deps);
  if (!isContextOverflowError(message.errorMessage)) {
    deps.recoveryRuntime.handlePersistentAssistantError(message, ctx);
  }
}
