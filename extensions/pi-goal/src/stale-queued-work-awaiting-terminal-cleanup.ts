import { emptyPlan, skipPlan, transition } from "./stale-queued-work-plan.js";
import { consumePendingStaleAgentEnd } from "./stale-queued-work-obligations.js";
import {
  consumePendingStaleTurnEnd,
  resolveLifecycleAfterTerminalCleanup,
} from "./stale-queued-work-terminal-cleanup.js";
import { beginObservingTurn } from "./stale-queued-work-observing.js";
import type {
  AgentEndMessage,
  AwaitingTerminalCleanupState,
  StaleQueuedWorkEvent,
  StaleQueuedWorkTransitionResult,
} from "./stale-queued-work-types.js";

export function reduceAwaitingTerminalCleanup(
  state: AwaitingTerminalCleanupState,
  event: StaleQueuedWorkEvent,
): StaleQueuedWorkTransitionResult {
  switch (event.type) {
    case "runnableWorkStarted":
      return transition({ ...beginObservingTurn(state), hasRunnableWork: true }, emptyPlan());
    case "staleWorkStarted": {
      const observing = beginObservingTurn(state);
      observing.staleGoalIds.add(event.goalId);
      return transition(observing, emptyPlan());
    }
    case "turnEnd":
      return reduceAwaitingTurnEnd(state, event.turnIndex);
    case "agentEnd":
      return reduceAwaitingAgentEnd(state, event.messages);
    case "sessionShutdown":
      return transition({ kind: "idle" }, emptyPlan());
    case "contextAbort":
      return transition(state, null);
    case "userInputClearAbort":
    case "extensionContinuationClearAbort":
    case "beforeAgentStartClearAbort":
    case "turnStart":
    case "toolExecutionEnd":
    case "sessionBeforeCompact":
    case "sessionCompact":
      return transition(state, emptyPlan());
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function reduceAwaitingTurnEnd(
  state: AwaitingTerminalCleanupState,
  turnIndex: number | null,
): StaleQueuedWorkTransitionResult {
  if (!consumePendingStaleTurnEnd(state.terminalCleanup, turnIndex)) {
    return transition(state, emptyPlan());
  }
  return transition(
    resolveLifecycleAfterTerminalCleanup(state.terminalCleanup, null),
    skipPlan({ type: "refreshUi" }),
  );
}

function reduceAwaitingAgentEnd(
  state: AwaitingTerminalCleanupState,
  messages: AgentEndMessage[],
): StaleQueuedWorkTransitionResult {
  if (!consumePendingStaleAgentEnd(state.terminalCleanup, messages)) {
    return transition(state, emptyPlan());
  }
  return transition(
    resolveLifecycleAfterTerminalCleanup(state.terminalCleanup, null),
    skipPlan({ type: "refreshUi" }),
  );
}
