import {
  consumeAbortingAgentEnd,
  consumePendingStaleAgentEnd,
  dropActiveObligations,
  markAllObligationsOlder,
  obligationsForStaleAbort,
  setAnonymousMatching,
} from "./stale-queued-work-obligations.js";
import {
  awaitingFromCleanup,
  cloneTerminalCleanup,
  consumePendingStaleTurnEnd,
  noteTerminalEvents,
  resolveLifecycleAfterTerminalCleanup,
  terminalCleanupHasPending,
} from "./stale-queued-work-terminal-cleanup.js";
import type {
  AgentEndMessage,
  StaleQueuedWorkEvent,
  StaleQueuedWorkLifecycleKind,
  StaleQueuedWorkPlan,
  StaleQueuedWorkState,
  StaleQueuedWorkTransitionResult,
  TerminalCleanup,
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

function emptyPlan(): StaleQueuedWorkPlan {
  return { skip: false, effects: [] };
}

function clearAccountingAbortRefreshPlan(): StaleQueuedWorkPlan {
  return {
    skip: false,
    effects: [{ type: "clearAccounting" }, { type: "abort" }, { type: "refreshUi" }],
  };
}

function skipClearAccountingRefreshPlan(): StaleQueuedWorkPlan {
  return {
    skip: true,
    effects: [{ type: "clearAccounting" }, { type: "refreshUi" }],
  };
}

function skipRefreshPlan(): StaleQueuedWorkPlan {
  return { skip: true, effects: [{ type: "refreshUi" }] };
}

function transition(
  state: StaleQueuedWorkState,
  plan: StaleQueuedWorkTransitionResult["plan"],
): StaleQueuedWorkTransitionResult {
  return { state, plan };
}

export function lifecycleKindFromState(
  state: StaleQueuedWorkState,
): StaleQueuedWorkLifecycleKind {
  return state.kind;
}

function cloneState(state: StaleQueuedWorkState): StaleQueuedWorkState {
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

function beginObservingFromIdleOrAwaiting(
  state: Extract<StaleQueuedWorkState, { kind: "idle" | "awaitingTerminalCleanup" }>,
): Extract<StaleQueuedWorkState, { kind: "observingTurn" }> {
  return {
    kind: "observingTurn",
    staleGoalIds: new Set(),
    hasRunnableWork: false,
    ...(state.kind === "awaitingTerminalCleanup"
      ? { terminalCleanup: state.terminalCleanup }
      : {}),
  };
}

function finishObservingTurn(
  state: Extract<StaleQueuedWorkState, { kind: "observingTurn" }>,
): StaleQueuedWorkState {
  if (state.terminalCleanup && terminalCleanupHasPending(state.terminalCleanup)) {
    return {
      kind: "awaitingTerminalCleanup",
      terminalCleanup: state.terminalCleanup,
    };
  }
  return { kind: "idle" };
}

function resolveCleanupAfterTerminalEvent(
  cleanup: TerminalCleanup,
  observing: Extract<StaleQueuedWorkState, { kind: "observingTurn" }> | null,
): StaleQueuedWorkState {
  return resolveLifecycleAfterTerminalCleanup(cleanup, observing);
}

function reduceObservingContextAbort(
  state: Extract<StaleQueuedWorkState, { kind: "observingTurn" }>,
  currentTurnIndex: number | null,
): StaleQueuedWorkTransitionResult {
  if (state.staleGoalIds.size === 0 || state.hasRunnableWork) {
    if (!state.terminalCleanup) {
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
  const pendingAgentEndObligations = [
    ...(state.terminalCleanup?.pendingAgentEndObligations ?? []),
  ];
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
    clearAccountingAbortRefreshPlan(),
  );
}

function consumeCleanupTurnEnd(
  cleanup: TerminalCleanup,
  turnIndex: number | null,
): boolean {
  return consumePendingStaleTurnEnd(cleanup, turnIndex);
}

function consumeCleanupAgentEnd(
  cleanup: TerminalCleanup,
  messages: AgentEndMessage[],
): boolean {
  return consumePendingStaleAgentEnd(cleanup, messages);
}

function releaseAbortingTurn(
  state: Extract<StaleQueuedWorkState, { kind: "abortingTurn" }>,
  includeRefresh: boolean,
): StaleQueuedWorkTransitionResult {
  const cleanup = cloneTerminalCleanup(state.terminalCleanup);
  const nextState = awaitingFromCleanup(cleanup);
  const effects: StaleQueuedWorkPlan["effects"] = terminalCleanupHasPending(cleanup)
    ? includeRefresh
      ? [{ type: "clearAccounting" }, { type: "refreshUi" }]
      : [{ type: "clearAccounting" }]
    : includeRefresh
      ? [{ type: "refreshUi" }]
      : [];
  return transition(nextState, { skip: false, effects });
}

function finishActiveAbortingLifecycle(
  state: Extract<StaleQueuedWorkState, { kind: "abortingTurn" }>,
): StaleQueuedWorkTransitionResult {
  const cleanup = cloneTerminalCleanup(state.terminalCleanup);
  dropActiveObligations(cleanup);
  const nextState: StaleQueuedWorkState = terminalCleanupHasPending(cleanup)
    ? { kind: "awaitingTerminalCleanup", terminalCleanup: cleanup }
    : { kind: "idle" };
  return transition(nextState, skipClearAccountingRefreshPlan());
}

export function reduceStaleQueuedWork(
  state: StaleQueuedWorkState,
  event: StaleQueuedWorkEvent,
): StaleQueuedWorkTransitionResult {
  const draft = cloneState(state);

  switch (draft.kind) {
    case "idle": {
      switch (event.type) {
        case "runnableWorkStarted": {
          const next = beginObservingFromIdleOrAwaiting(draft);
          next.hasRunnableWork = true;
          return transition(next, emptyPlan());
        }
        case "staleWorkStarted": {
          const next = beginObservingFromIdleOrAwaiting(draft);
          next.staleGoalIds.add(event.goalId);
          return transition(next, emptyPlan());
        }
        case "contextAbort":
          return transition(draft, null);
        case "userInputClearAbort":
        case "extensionContinuationClearAbort":
        case "beforeAgentStartClearAbort":
        case "turnStart":
        case "toolExecutionEnd":
        case "sessionBeforeCompact":
        case "sessionCompact":
        case "turnEnd":
        case "agentEnd":
        case "sessionShutdown":
          return transition(draft, emptyPlan());
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    }

    case "observingTurn": {
      switch (event.type) {
        case "runnableWorkStarted":
          return transition({ ...draft, hasRunnableWork: true }, emptyPlan());
        case "staleWorkStarted":
          draft.staleGoalIds.add(event.goalId);
          return transition(draft, emptyPlan());
        case "contextAbort":
          return reduceObservingContextAbort(draft, event.currentTurnIndex);
        case "turnStart":
          return transition(finishObservingTurn(draft), emptyPlan());
        case "turnEnd": {
          if (!draft.terminalCleanup || !consumeCleanupTurnEnd(draft.terminalCleanup, event.turnIndex)) {
            return transition(draft, emptyPlan());
          }
          return transition(
            resolveCleanupAfterTerminalEvent(draft.terminalCleanup, draft),
            skipRefreshPlan(),
          );
        }
        case "agentEnd": {
          if (!draft.terminalCleanup || !consumeCleanupAgentEnd(draft.terminalCleanup, event.messages)) {
            return transition(draft, emptyPlan());
          }
          return transition(
            resolveCleanupAfterTerminalEvent(draft.terminalCleanup, draft),
            skipRefreshPlan(),
          );
        }
        case "sessionShutdown":
          return transition({ kind: "idle" }, emptyPlan());
        case "userInputClearAbort":
        case "extensionContinuationClearAbort":
        case "beforeAgentStartClearAbort":
        case "toolExecutionEnd":
        case "sessionBeforeCompact":
        case "sessionCompact":
          return transition(draft, emptyPlan());
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    }

    case "abortingTurn": {
      switch (event.type) {
        case "contextAbort":
          return transition(draft, clearAccountingAbortRefreshPlan());
        case "userInputClearAbort":
          return releaseAbortingTurn(draft, true);
        case "extensionContinuationClearAbort":
        case "beforeAgentStartClearAbort":
        case "turnStart":
          return releaseAbortingTurn(draft, false);
        case "toolExecutionEnd":
        case "sessionBeforeCompact":
        case "sessionCompact":
          return transition(draft, skipClearAccountingRefreshPlan());
        case "turnEnd": {
          if (event.turnIndex !== null && draft.activeTurnIndex === event.turnIndex) {
            draft.terminalCleanup.pendingTurnEndIndexes.delete(event.turnIndex);
            return transition(draft, skipClearAccountingRefreshPlan());
          }
          if (consumeCleanupTurnEnd(draft.terminalCleanup, event.turnIndex)) {
            return transition(draft, skipRefreshPlan());
          }
          return transition(draft, emptyPlan());
        }
        case "agentEnd": {
          const result = consumeAbortingAgentEnd(draft, event.messages);
          if (result.consumedActive) {
            return finishActiveAbortingLifecycle(draft);
          }
          if (result.consumedOlder) {
            return transition(draft, skipRefreshPlan());
          }
          if (result.activePending) {
            return transition(draft, emptyPlan());
          }
          return finishActiveAbortingLifecycle(draft);
        }
        case "sessionShutdown":
          return transition({ kind: "idle" }, { skip: false, effects: [{ type: "clearAccounting" }] });
        case "runnableWorkStarted":
        case "staleWorkStarted":
          return transition(draft, emptyPlan());
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    }

    case "awaitingTerminalCleanup": {
      switch (event.type) {
        case "runnableWorkStarted": {
          const next = beginObservingFromIdleOrAwaiting(draft);
          next.hasRunnableWork = true;
          return transition(next, emptyPlan());
        }
        case "staleWorkStarted": {
          const next = beginObservingFromIdleOrAwaiting(draft);
          next.staleGoalIds.add(event.goalId);
          return transition(next, emptyPlan());
        }
        case "turnEnd": {
          if (!consumeCleanupTurnEnd(draft.terminalCleanup, event.turnIndex)) {
            return transition(draft, emptyPlan());
          }
          return transition(
            resolveCleanupAfterTerminalEvent(draft.terminalCleanup, null),
            skipRefreshPlan(),
          );
        }
        case "agentEnd": {
          if (!consumeCleanupAgentEnd(draft.terminalCleanup, event.messages)) {
            return transition(draft, emptyPlan());
          }
          return transition(
            resolveCleanupAfterTerminalEvent(draft.terminalCleanup, null),
            skipRefreshPlan(),
          );
        }
        case "sessionShutdown":
          return transition({ kind: "idle" }, emptyPlan());
        case "contextAbort":
          return transition(draft, null);
        case "userInputClearAbort":
        case "extensionContinuationClearAbort":
        case "beforeAgentStartClearAbort":
        case "turnStart":
        case "toolExecutionEnd":
        case "sessionBeforeCompact":
        case "sessionCompact":
          return transition(draft, emptyPlan());
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    }

    default: {
      const _exhaustive: never = draft;
      return _exhaustive;
    }
  }
}

export function createInitialStaleQueuedWorkState(): StaleQueuedWorkState {
  return { kind: "idle" };
}
