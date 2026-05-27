import { reduceAbortingQueuedWork } from "./stale-queued-work-aborting.js";
import { reduceAwaitingTerminalCleanup } from "./stale-queued-work-awaiting-terminal-cleanup.js";
import { reduceIdleQueuedWork } from "./stale-queued-work-idle.js";
import { reduceObservingQueuedWork } from "./stale-queued-work-observing.js";
import { cloneTerminalCleanup } from "./stale-queued-work-terminal-cleanup.js";
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
  const draft = cloneStaleQueuedWorkState(state);
  switch (draft.kind) {
    case "idle":
      return reduceIdleQueuedWork(event);
    case "observingTurn":
      return reduceObservingQueuedWork(draft, event);
    case "abortingTurn":
      return reduceAbortingQueuedWork(draft, event);
    case "awaitingTerminalCleanup":
      return reduceAwaitingTerminalCleanup(draft, event);
    default: {
      const _exhaustive: never = draft;
      return _exhaustive;
    }
  }
}

function cloneStaleQueuedWorkState(state: StaleQueuedWorkState): StaleQueuedWorkState {
  switch (state.kind) {
    case "idle":
      return { kind: "idle" };
    case "observingTurn":
      return {
        kind: "observingTurn",
        staleGoalIds: new Set(state.staleGoalIds),
        hasRunnableWork: state.hasRunnableWork,
        ...(state.terminalCleanup
          ? { terminalCleanup: cloneTerminalCleanup(state.terminalCleanup) }
          : {}),
      };
    case "abortingTurn":
      return {
        kind: "abortingTurn",
        activeTurnIndex: state.activeTurnIndex,
        terminalCleanup: cloneTerminalCleanup(state.terminalCleanup),
      };
    case "awaitingTerminalCleanup":
      return {
        kind: "awaitingTerminalCleanup",
        terminalCleanup: cloneTerminalCleanup(state.terminalCleanup),
      };
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function createInitialStaleQueuedWorkState(): StaleQueuedWorkState {
  return { kind: "idle" };
}
