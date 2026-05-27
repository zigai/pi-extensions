import { emptyPlan, transition } from "./stale-queued-work-plan.js";
import { beginObservingTurn } from "./stale-queued-work-observing.js";
import type {
  StaleQueuedWorkEvent,
  StaleQueuedWorkTransitionResult,
} from "./stale-queued-work-types.js";

export function reduceIdleQueuedWork(event: StaleQueuedWorkEvent): StaleQueuedWorkTransitionResult {
  switch (event.type) {
    case "runnableWorkStarted":
      return transition({ ...beginObservingTurn({ kind: "idle" }), hasRunnableWork: true }, emptyPlan());
    case "staleWorkStarted": {
      const observing = beginObservingTurn({ kind: "idle" });
      observing.staleGoalIds.add(event.goalId);
      return transition(observing, emptyPlan());
    }
    case "contextAbort":
      return transition({ kind: "idle" }, null);
    case "sessionShutdown":
    case "userInputClearAbort":
    case "extensionContinuationClearAbort":
    case "beforeAgentStartClearAbort":
    case "turnStart":
    case "toolExecutionEnd":
    case "sessionBeforeCompact":
    case "sessionCompact":
    case "turnEnd":
    case "agentEnd":
      return transition({ kind: "idle" }, emptyPlan());
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
