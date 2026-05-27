import { reduceAbortingQueuedWork } from "./stale-queued-work-aborting.js";
import { reduceAwaitingTerminalCleanup } from "./stale-queued-work-awaiting-terminal-cleanup.js";
import { reduceIdleQueuedWork } from "./stale-queued-work-idle.js";
import { reduceObservingQueuedWork } from "./stale-queued-work-observing.js";
import type {
  StaleQueuedWorkEvent,
  StaleQueuedWorkLifecycleKind,
  StaleQueuedWorkState,
  StaleQueuedWorkTransitionResult,
} from "./stale-queued-work-types.js";

export type {
  AgentEndMessage,
  StaleQueuedWorkEffect,
  StaleQueuedWorkEvent,
  StaleQueuedWorkLifecycleKind,
  StaleQueuedWorkPlan,
  StaleQueuedWorkState,
  StaleQueuedWorkTransitionResult,
} from "./stale-queued-work-types.js";

export function lifecycleKindFromState(
  state: StaleQueuedWorkState,
): StaleQueuedWorkLifecycleKind {
  return state.kind;
}

export function reduceStaleQueuedWork(
  state: StaleQueuedWorkState,
  event: StaleQueuedWorkEvent,
): StaleQueuedWorkTransitionResult {
  switch (state.kind) {
    case "idle":
      return reduceIdleQueuedWork(event);
    case "observingTurn":
      return reduceObservingQueuedWork(state, event);
    case "abortingTurn":
      return reduceAbortingQueuedWork(state, event);
    case "awaitingTerminalCleanup":
      return reduceAwaitingTerminalCleanup(state, event);
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function createInitialStaleQueuedWorkState(): StaleQueuedWorkState {
  return { kind: "idle" };
}
