import { emptyPlan, transition } from "./stale-queued-work-plan.js";
import {
  consumePendingStaleAgentEnd,
  markAllObligationsOlder,
  obligationsForStaleAbort,
  setAnonymousMatching,
} from "./stale-queued-work-obligations.js";
import {
  consumePendingStaleTurnEnd,
  noteTerminalEvents,
  resolveLifecycleAfterTerminalCleanup,
  terminalCleanupFromObserving,
  terminalCleanupHasPending,
} from "./stale-queued-work-terminal-cleanup.js";
import type {
  AgentEndMessage,
  AwaitingTerminalCleanupState,
  ObservingTurnState,
  StaleQueuedWorkEvent,
  StaleQueuedWorkState,
  StaleQueuedWorkTransitionResult,
} from "./stale-queued-work-types.js";

export function beginObservingTurn(
  lifecycle: { kind: "idle" } | ObservingTurnState | AwaitingTerminalCleanupState,
): ObservingTurnState {
  switch (lifecycle.kind) {
    case "observingTurn":
      return lifecycle;
    case "idle":
      return {
        kind: "observingTurn",
        staleGoalIds: new Set(),
        hasRunnableWork: false,
      };
    case "awaitingTerminalCleanup":
      return {
        kind: "observingTurn",
        staleGoalIds: new Set(),
        hasRunnableWork: false,
        terminalCleanup: lifecycle.terminalCleanup,
      };
    default: {
      const _exhaustive: never = lifecycle;
      return _exhaustive;
    }
  }
}

export function reduceObservingQueuedWork(
  state: ObservingTurnState,
  event: StaleQueuedWorkEvent,
): StaleQueuedWorkTransitionResult {
  switch (event.type) {
    case "runnableWorkStarted":
      return transition({ ...state, hasRunnableWork: true }, emptyPlan());
    case "staleWorkStarted": {
      state.staleGoalIds.add(event.goalId);
      return transition(state, emptyPlan());
    }
    case "contextAbort":
      return reduceObservingContextAbort(state, event.currentTurnIndex);
    case "turnStart":
      return transition(finishObservingTurn(state), emptyPlan());
    case "turnEnd":
      return reduceObservingTurnEnd(state, event.turnIndex);
    case "agentEnd":
      return reduceObservingAgentEnd(state, event.messages);
    case "sessionShutdown":
      return transition({ kind: "idle" }, emptyPlan());
    case "userInputClearAbort":
    case "extensionContinuationClearAbort":
    case "beforeAgentStartClearAbort":
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

function finishObservingTurn(observing: ObservingTurnState): StaleQueuedWorkState {
  const cleanup = observing.terminalCleanup;
  if (cleanup !== undefined && terminalCleanupHasPending(cleanup)) {
    return {
      kind: "awaitingTerminalCleanup",
      terminalCleanup: cleanup,
    };
  }
  return { kind: "idle" };
}

function reduceObservingContextAbort(
  state: ObservingTurnState,
  currentTurnIndex: number | null,
): StaleQueuedWorkTransitionResult {
  if (state.staleGoalIds.size === 0 || state.hasRunnableWork) {
    if (state.terminalCleanup === undefined) {
      return transition(state, null);
    }
    setAnonymousMatching(state.terminalCleanup.pendingAgentEndObligations, false);
    return transition(
      {
        kind: "awaitingTerminalCleanup",
        terminalCleanup: state.terminalCleanup,
      },
      null,
    );
  }

  const pendingTurnEndIndexes = new Set(state.terminalCleanup?.pendingTurnEndIndexes ?? []);
  const pendingAgentEndObligations = [...(state.terminalCleanup?.pendingAgentEndObligations ?? [])];
  markAllObligationsOlder({ pendingTurnEndIndexes, pendingAgentEndObligations });
  setAnonymousMatching(pendingAgentEndObligations, true);
  noteTerminalEvents(pendingTurnEndIndexes, currentTurnIndex);

  return transition(
    {
      kind: "abortingTurn",
      activeTurnIndex: currentTurnIndex,
      terminalCleanup: {
        pendingTurnEndIndexes,
        pendingAgentEndObligations: [
          ...pendingAgentEndObligations,
          ...obligationsForStaleAbort(state.staleGoalIds, "active"),
        ],
      },
    },
    {
      skip: false,
      effects: [{ type: "clearAccounting" }, { type: "abort" }, { type: "refreshUi" }],
    },
  );
}

function reduceObservingTurnEnd(
  state: ObservingTurnState,
  turnIndex: number | null,
): StaleQueuedWorkTransitionResult {
  const pending = terminalCleanupFromObserving(state);
  if (pending === null || !consumePendingStaleTurnEnd(pending.cleanup, turnIndex)) {
    return transition(state, emptyPlan());
  }
  return transition(
    resolveLifecycleAfterTerminalCleanup(pending.cleanup, pending.observing),
    { skip: true, effects: [{ type: "refreshUi" }] },
  );
}

function reduceObservingAgentEnd(
  state: ObservingTurnState,
  messages: AgentEndMessage[],
): StaleQueuedWorkTransitionResult {
  const pending = terminalCleanupFromObserving(state);
  if (pending === null || !consumePendingStaleAgentEnd(pending.cleanup, messages)) {
    return transition(state, emptyPlan());
  }
  return transition(
    resolveLifecycleAfterTerminalCleanup(pending.cleanup, pending.observing),
    { skip: true, effects: [{ type: "refreshUi" }] },
  );
}
