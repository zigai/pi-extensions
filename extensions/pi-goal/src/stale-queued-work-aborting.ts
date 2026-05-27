import { emptyPlan, skipPlan, transition } from "./stale-queued-work-plan.js";
import {
  consumeAbortingAgentEnd,
  dropActiveObligations,
} from "./stale-queued-work-obligations.js";
import {
  awaitingFromCleanup,
  cloneTerminalCleanup,
  consumePendingStaleTurnEnd,
  terminalCleanupHasPending,
} from "./stale-queued-work-terminal-cleanup.js";
import type {
  AbortingTurnState,
  AgentEndMessage,
  StaleQueuedWorkEffect,
  StaleQueuedWorkEvent,
  StaleQueuedWorkPlan,
  StaleQueuedWorkState,
  StaleQueuedWorkTransitionResult,
} from "./stale-queued-work-types.js";

export function reduceAbortingQueuedWork(
  state: AbortingTurnState,
  event: StaleQueuedWorkEvent,
): StaleQueuedWorkTransitionResult {
  switch (event.type) {
    case "contextAbort":
      return transition(state, {
        skip: false,
        effects: [{ type: "clearAccounting" }, { type: "abort" }, { type: "refreshUi" }],
      });
    case "userInputClearAbort":
      return releaseAbortingTurnForUserInput(state);
    case "extensionContinuationClearAbort":
    case "beforeAgentStartClearAbort":
    case "turnStart":
      return releaseAbortingTurn(state);
    case "toolExecutionEnd":
    case "sessionBeforeCompact":
    case "sessionCompact":
      return transition(state, skipPlan({ type: "clearAccounting" }, { type: "refreshUi" }));
    case "turnEnd":
      return reduceAbortingTurnEnd(state, event.turnIndex);
    case "agentEnd":
      return reduceAbortingAgentEnd(state, event.messages);
    case "sessionShutdown":
      return transition({ kind: "idle" }, { skip: false, effects: [{ type: "clearAccounting" }] });
    case "runnableWorkStarted":
    case "staleWorkStarted":
      return transition(state, emptyPlan());
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export function releaseAbortingTurn(state: AbortingTurnState): StaleQueuedWorkTransitionResult {
  const cleanup = cloneTerminalCleanup(state.terminalCleanup);
  const nextState = awaitingFromCleanup(cleanup);
  const effects: StaleQueuedWorkEffect[] = terminalCleanupHasPending(cleanup)
    ? [{ type: "clearAccounting" }]
    : [];
  return transition(nextState, { skip: false, effects });
}

function releaseAbortingTurnForUserInput(
  state: AbortingTurnState,
): StaleQueuedWorkTransitionResult {
  const result = releaseAbortingTurn(state);
  if (result.plan?.effects.length) {
    return transition(result.state, {
      skip: false,
      effects: [...result.plan.effects, { type: "refreshUi" }],
    });
  }
  return result;
}

function reduceAbortingTurnEnd(
  state: AbortingTurnState,
  turnIndex: number | null,
): StaleQueuedWorkTransitionResult {
  const isActiveStaleTurn = turnIndex !== null && state.activeTurnIndex === turnIndex;
  if (isActiveStaleTurn) {
    state.terminalCleanup.pendingTurnEndIndexes.delete(turnIndex);
    return transition(state, skipPlan({ type: "clearAccounting" }, { type: "refreshUi" }));
  }
  if (consumePendingStaleTurnEnd(state.terminalCleanup, turnIndex)) {
    return transition(state, skipPlan({ type: "refreshUi" }));
  }
  return transition(state, emptyPlan());
}

function reduceAbortingAgentEnd(
  state: AbortingTurnState,
  messages: AgentEndMessage[],
): StaleQueuedWorkTransitionResult {
  const plan = abortingAgentEndPlan(state, messages);
  if (plan.skip && plan.effects.some((effect) => effect.type === "clearAccounting")) {
    return finishActiveAbortingLifecycle(state);
  }
  return transition(state, plan);
}

function abortingAgentEndPlan(
  state: AbortingTurnState,
  messages: AgentEndMessage[],
): StaleQueuedWorkPlan {
  const result = consumeAbortingAgentEnd(state, messages);
  if (result.consumedActive) {
    return skipPlan({ type: "clearAccounting" }, { type: "refreshUi" });
  }
  if (result.consumedOlder) {
    return skipPlan({ type: "refreshUi" });
  }
  if (result.activePending) {
    return emptyPlan();
  }
  return skipPlan({ type: "clearAccounting" }, { type: "refreshUi" });
}

function finishActiveAbortingLifecycle(
  aborting: AbortingTurnState): StaleQueuedWorkTransitionResult {
  const cleanup = cloneTerminalCleanup(aborting.terminalCleanup);
  dropActiveObligations(cleanup);
  const nextState: StaleQueuedWorkState = terminalCleanupHasPending(cleanup)
    ? {
        kind: "awaitingTerminalCleanup",
        terminalCleanup: cleanup,
      }
    : { kind: "idle" };
  return transition(nextState, skipPlan({ type: "clearAccounting" }, { type: "refreshUi" }));
}
