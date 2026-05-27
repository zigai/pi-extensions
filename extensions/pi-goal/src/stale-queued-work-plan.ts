import type {
  StaleQueuedWorkEffect,
  StaleQueuedWorkPlan,
  StaleQueuedWorkState,
  StaleQueuedWorkTransitionResult,
} from "./stale-queued-work-types.js";

export function emptyPlan(): StaleQueuedWorkPlan {
  return { skip: false, effects: [] };
}

export function skipPlan(...effects: StaleQueuedWorkEffect[]): StaleQueuedWorkPlan {
  return { skip: true, effects };
}

export function transition(
  state: StaleQueuedWorkState,
  plan: StaleQueuedWorkPlan | null,
): StaleQueuedWorkTransitionResult {
  return { state, plan };
}
