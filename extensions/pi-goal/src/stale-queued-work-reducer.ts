import type { AssistantTurnMessage } from "./goal-accounting.js";
import {
  agentEndMessagesIncludeQueuedGoalWork,
  pendingStaleQueuedGoalWorkIdsFromMessages,
} from "./queued-goal-work.js";

export type StaleQueuedWorkEffect =
  | { type: "clearAccounting" }
  | { type: "refreshUi" }
  | { type: "abort" };

export type StaleQueuedWorkPlan = {
  skip: boolean;
  effects: StaleQueuedWorkEffect[];
};

export type StaleQueuedWorkLifecycleKind =
  | "idle"
  | "observingTurn"
  | "abortingTurn"
  | "awaitingTerminalCleanup";

type TerminalObligationPhase = "older" | "active";

/** One stale abort's pending agent_end: match goalIds, or id-less when acceptsAnonymous. */
type AgentEndObligation = {
  goalIds: Set<string>;
  acceptsAnonymous: boolean;
  phase: TerminalObligationPhase;
};

type TerminalCleanup = {
  pendingTurnEndIndexes: Set<number>;
  pendingAgentEndObligations: AgentEndObligation[];
};

type ObservingTurnState = {
  kind: "observingTurn";
  staleGoalIds: Set<string>;
  hasRunnableWork: boolean;
  terminalCleanup?: TerminalCleanup;
};

type AbortingTurnState = {
  kind: "abortingTurn";
  activeTurnIndex: number | null;
  terminalCleanup: TerminalCleanup;
};

export type StaleQueuedWorkState =
  | { kind: "idle" }
  | ObservingTurnState
  | AbortingTurnState
  | {
      kind: "awaitingTerminalCleanup";
      pendingTurnEndIndexes: Set<number>;
      pendingAgentEndObligations: AgentEndObligation[];
    };

type State = StaleQueuedWorkState;

export type AgentEndMessage = {
  role: string;
  customType?: string;
  details?: unknown;
  content?: unknown;
  stopReason?: string;
};

export type StaleQueuedWorkEvent =
  | { type: "runnableWorkStarted" }
  | { type: "staleWorkStarted"; goalId: string }
  | { type: "contextAbort"; currentTurnIndex: number | null }
  | { type: "userInputClearAbort" }
  | { type: "extensionContinuationClearAbort" }
  | { type: "beforeAgentStartClearAbort" }
  | { type: "turnStart" }
  | { type: "toolExecutionEnd" }
  | { type: "sessionBeforeCompact" }
  | { type: "sessionCompact" }
  | { type: "turnEnd"; turnIndex: number | null; message: AssistantTurnMessage }
  | { type: "agentEnd"; messages: AgentEndMessage[] }
  | { type: "sessionShutdown" };

export type StaleQueuedWorkTransitionResult = {
  state: State;
  plan: StaleQueuedWorkPlan | null;
};

function emptyPlan(): StaleQueuedWorkPlan {
  return { skip: false, effects: [] };
}

function skipPlan(...effects: StaleQueuedWorkEffect[]): StaleQueuedWorkPlan {
  return { skip: true, effects };
}

function transition(state: State, plan: StaleQueuedWorkPlan | null): StaleQueuedWorkTransitionResult {
  return { state, plan };
}

export function lifecycleKindFromState(state: State): StaleQueuedWorkLifecycleKind {
  return state.kind;
}

function isStaleTerminalAssistantMessage(message: { role: string; stopReason?: string }): boolean {
  return (
    message.role === "assistant" &&
    (message.stopReason === "aborted" ||
      message.stopReason === "stop" ||
      message.stopReason === "error")
  );
}

function terminalCleanupHasPending(cleanup: TerminalCleanup): boolean {
  return cleanup.pendingTurnEndIndexes.size > 0 || cleanup.pendingAgentEndObligations.length > 0;
}

function obligationForStaleAbort(
  staleGoalIds: ReadonlySet<string>,
  phase: TerminalObligationPhase,
): AgentEndObligation {
  return { goalIds: new Set(staleGoalIds), acceptsAnonymous: true, phase };
}

function obligationsForStaleAbort(
  staleGoalIds: ReadonlySet<string>,
  phase: TerminalObligationPhase,
): AgentEndObligation[] {
  if (staleGoalIds.size === 0) {
    return [];
  }
  return [obligationForStaleAbort(staleGoalIds, phase)];
}

function cloneTerminalCleanup(cleanup: TerminalCleanup): TerminalCleanup {
  return {
    pendingTurnEndIndexes: new Set(cleanup.pendingTurnEndIndexes),
    pendingAgentEndObligations: cleanup.pendingAgentEndObligations.map((obligation) => ({
      goalIds: new Set(obligation.goalIds),
      acceptsAnonymous: obligation.acceptsAnonymous,
      phase: obligation.phase,
    })),
  };
}

function setAnonymousMatching(
  obligations: AgentEndObligation[],
  acceptsAnonymous: boolean,
): void {
  for (const obligation of obligations) {
    obligation.acceptsAnonymous = acceptsAnonymous;
  }
}

function markAllObligationsOlder(cleanup: TerminalCleanup): void {
  for (const obligation of cleanup.pendingAgentEndObligations) {
    obligation.phase = "older";
  }
}

function dropActiveObligations(cleanup: TerminalCleanup): void {
  cleanup.pendingAgentEndObligations = cleanup.pendingAgentEndObligations.filter(
    (obligation) => obligation.phase !== "active",
  );
}

function pendingGoalIdsFromObligations(obligations: readonly AgentEndObligation[]): Set<string> {
  const goalIds = new Set<string>();
  for (const obligation of obligations) {
    for (const goalId of obligation.goalIds) {
      goalIds.add(goalId);
    }
  }
  return goalIds;
}

function allPendingGoalIds(cleanup: TerminalCleanup): Set<string> {
  return pendingGoalIdsFromObligations(cleanup.pendingAgentEndObligations);
}

function pendingGoalIdsByPhase(
  cleanup: TerminalCleanup,
  phase: TerminalObligationPhase,
): Set<string> {
  return pendingGoalIdsFromObligations(
    cleanup.pendingAgentEndObligations.filter((obligation) => obligation.phase === phase),
  );
}

function obligationMatchesAnyGoal(
  obligation: AgentEndObligation,
  matchedGoalIds: ReadonlySet<string>,
): boolean {
  for (const goalId of obligation.goalIds) {
    if (matchedGoalIds.has(goalId)) {
      return true;
    }
  }
  return false;
}

type ConsumePolicy =
  | {
      kind: "goalIds";
      matchedGoalIds: readonly string[];
      phaseOrder: readonly TerminalObligationPhase[];
    }
  | {
      kind: "anonymous";
      phaseOrder: readonly TerminalObligationPhase[];
      consumeAnyInLastPhase?: boolean;
    };

type ConsumptionResult = {
  consumed: boolean;
  consumedOlder: boolean;
  consumedActive: boolean;
};

function consumeMatchingObligations(
  obligations: AgentEndObligation[],
  policy: ConsumePolicy,
): ConsumptionResult {
  const result: ConsumptionResult = {
    consumed: false,
    consumedOlder: false,
    consumedActive: false,
  };
  const remainingGoalIds =
    policy.kind === "goalIds" ? new Set(policy.matchedGoalIds) : new Set<string>();

  const consumeAt = (index: number): void => {
    const [obligation] = obligations.splice(index, 1);
    if (!obligation) {
      return;
    }
    result.consumed = true;
    result.consumedOlder ||= obligation.phase === "older";
    result.consumedActive ||= obligation.phase === "active";
    for (const goalId of obligation.goalIds) {
      remainingGoalIds.delete(goalId);
    }
  };

  for (const phase of policy.phaseOrder) {
    for (let index = 0; index < obligations.length; ) {
      const obligation = obligations[index]!;
      if (obligation.phase !== phase) {
        index += 1;
        continue;
      }

      const matches =
        policy.kind === "goalIds"
          ? remainingGoalIds.size > 0 && obligationMatchesAnyGoal(obligation, remainingGoalIds)
          : obligation.acceptsAnonymous ||
            Boolean(policy.consumeAnyInLastPhase && phase === policy.phaseOrder.at(-1));
      if (!matches) {
        index += 1;
        continue;
      }

      consumeAt(index);
      if (policy.kind === "anonymous" || remainingGoalIds.size === 0) {
        return result;
      }
    }
  }

  return result;
}

function isSubsetOfSet(values: readonly string[], superset: ReadonlySet<string>): boolean {
  for (const value of values) {
    if (!superset.has(value)) {
      return false;
    }
  }
  return true;
}

function activeTurnEndConsumed(aborting: AbortingTurnState): boolean {
  const { activeTurnIndex, terminalCleanup } = aborting;
  return activeTurnIndex !== null && !terminalCleanup.pendingTurnEndIndexes.has(activeTurnIndex);
}

function matchesAnonymousStaleAgentEnd(messages: AgentEndMessage[]): boolean {
  if (agentEndMessagesIncludeQueuedGoalWork(messages)) {
    return false;
  }
  return messages.some(isStaleTerminalAssistantMessage);
}

function noteTerminalEvents(
  pendingTurnEndIndexes: Set<number>,
  currentTurnIndex: number | null,
): void {
  if (currentTurnIndex !== null) {
    pendingTurnEndIndexes.add(currentTurnIndex);
  }
}

function beginObservingTurn(lifecycle: Exclude<State, { kind: "abortingTurn" }>): ObservingTurnState {
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
        terminalCleanup: {
          pendingTurnEndIndexes: lifecycle.pendingTurnEndIndexes,
          pendingAgentEndObligations: lifecycle.pendingAgentEndObligations,
        },
      };
    default: {
      const _exhaustive: never = lifecycle;
      return _exhaustive;
    }
  }
}

function finishObservingTurn(observing: ObservingTurnState): State {
  const cleanup = observing.terminalCleanup;
  if (cleanup !== undefined && terminalCleanupHasPending(cleanup)) {
    return {
      kind: "awaitingTerminalCleanup",
      pendingTurnEndIndexes: cleanup.pendingTurnEndIndexes,
      pendingAgentEndObligations: cleanup.pendingAgentEndObligations,
    };
  }
  return { kind: "idle" };
}

function terminalCleanupFromLifecycle(
  lifecycle: State,
): { cleanup: TerminalCleanup; observing: ObservingTurnState | null } | null {
  switch (lifecycle.kind) {
    case "awaitingTerminalCleanup":
      return {
        cleanup: {
          pendingTurnEndIndexes: lifecycle.pendingTurnEndIndexes,
          pendingAgentEndObligations: lifecycle.pendingAgentEndObligations,
        },
        observing: null,
      };
    case "observingTurn":
      if (lifecycle.terminalCleanup === undefined) {
        return null;
      }
      return { cleanup: lifecycle.terminalCleanup, observing: lifecycle };
    default:
      return null;
  }
}

function resolveLifecycleAfterTerminalCleanup(
  cleanup: TerminalCleanup,
  observing: ObservingTurnState | null,
): State {
  const hasPending = terminalCleanupHasPending(cleanup);

  if (observing) {
    if (hasPending) {
      return { ...observing, terminalCleanup: cleanup };
    }
    const { terminalCleanup: _removed, ...withoutCleanup } = observing;
    return withoutCleanup;
  }

  if (hasPending) {
    return {
      kind: "awaitingTerminalCleanup",
      pendingTurnEndIndexes: cleanup.pendingTurnEndIndexes,
      pendingAgentEndObligations: cleanup.pendingAgentEndObligations,
    };
  }
  return { kind: "idle" };
}

function consumePendingStaleTurnEnd(cleanup: TerminalCleanup, turnIndex: number | null): boolean {
  if (turnIndex === null || !cleanup.pendingTurnEndIndexes.has(turnIndex)) {
    return false;
  }
  cleanup.pendingTurnEndIndexes.delete(turnIndex);
  return true;
}

function consumePendingStaleAgentEnd(cleanup: TerminalCleanup, messages: AgentEndMessage[]): boolean {
  const pendingGoalIds = pendingGoalIdsFromObligations(cleanup.pendingAgentEndObligations);
  const matchedGoalIds = pendingStaleQueuedGoalWorkIdsFromMessages(messages, pendingGoalIds);
  const goalMatch = consumeMatchingObligations(cleanup.pendingAgentEndObligations, {
    kind: "goalIds",
    matchedGoalIds,
    phaseOrder: ["older", "active"],
  });
  if (goalMatch.consumed) {
    return true;
  }
  if (!matchesAnonymousStaleAgentEnd(messages)) {
    return false;
  }
  return consumeMatchingObligations(cleanup.pendingAgentEndObligations, {
    kind: "anonymous",
    phaseOrder: ["older", "active"],
  }).consumed;
}

function abortingAgentEndPlan(aborting: AbortingTurnState, messages: AgentEndMessage[]): StaleQueuedWorkPlan {
  const { terminalCleanup } = aborting;
  const matchedGoalIds = pendingStaleQueuedGoalWorkIdsFromMessages(
    messages,
    allPendingGoalIds(terminalCleanup),
  );
  const preferActiveFirst =
    activeTurnEndConsumed(aborting) &&
    matchedGoalIds.length > 0 &&
    isSubsetOfSet(matchedGoalIds, pendingGoalIdsByPhase(terminalCleanup, "active"));

  const goalMatch = consumeMatchingObligations(terminalCleanup.pendingAgentEndObligations, {
    kind: "goalIds",
    matchedGoalIds,
    phaseOrder: preferActiveFirst ? ["active", "older"] : ["older", "active"],
  });

  let finishActive = goalMatch.consumedActive;
  let consumedOlder = goalMatch.consumedOlder;
  if (matchesAnonymousStaleAgentEnd(messages)) {
    const preferActiveAnonymous =
      activeTurnEndConsumed(aborting) &&
      terminalCleanup.pendingAgentEndObligations.some(
        (obligation) => obligation.phase === "active" && obligation.acceptsAnonymous,
      );
    const anonymousMatch = consumeMatchingObligations(
      terminalCleanup.pendingAgentEndObligations,
      {
        kind: "anonymous",
        phaseOrder: preferActiveAnonymous ? ["active", "older"] : ["older", "active"],
        consumeAnyInLastPhase: true,
      },
    );
    finishActive ||= anonymousMatch.consumedActive;
    consumedOlder ||= anonymousMatch.consumedOlder;
  }

  if (finishActive) {
    return skipPlan({ type: "clearAccounting" }, { type: "refreshUi" });
  }
  if (consumedOlder) {
    return skipPlan({ type: "refreshUi" });
  }
  const activePending = terminalCleanup.pendingAgentEndObligations.some(
    (obligation) => obligation.phase === "active",
  );
  if (activePending) {
    return emptyPlan();
  }
  return skipPlan({ type: "clearAccounting" }, { type: "refreshUi" });
}

function awaitingFromCleanup(cleanup: TerminalCleanup): State {
  markAllObligationsOlder(cleanup);
  if (!terminalCleanupHasPending(cleanup)) {
    return { kind: "idle" };
  }
  return {
    kind: "awaitingTerminalCleanup",
    pendingTurnEndIndexes: cleanup.pendingTurnEndIndexes,
    pendingAgentEndObligations: cleanup.pendingAgentEndObligations,
  };
}

function releaseAbortingTurn(state: State): StaleQueuedWorkTransitionResult {
  if (state.kind !== "abortingTurn") {
    return transition(state, emptyPlan());
  }
  const cleanup = cloneTerminalCleanup(state.terminalCleanup);
  const nextState = awaitingFromCleanup(cleanup);
  const effects = terminalCleanupHasPending(cleanup) ? [{ type: "clearAccounting" } as const] : [];
  return transition(nextState, { skip: false, effects });
}

function finishActiveAbortingLifecycle(aborting: AbortingTurnState): StaleQueuedWorkTransitionResult {
  const cleanup = cloneTerminalCleanup(aborting.terminalCleanup);
  dropActiveObligations(cleanup);
  const nextState = terminalCleanupHasPending(cleanup)
    ? {
        kind: "awaitingTerminalCleanup" as const,
        pendingTurnEndIndexes: cleanup.pendingTurnEndIndexes,
        pendingAgentEndObligations: cleanup.pendingAgentEndObligations,
      }
    : ({ kind: "idle" } as const);
  return transition(nextState, skipPlan({ type: "clearAccounting" }, { type: "refreshUi" }));
}

export function reduceStaleQueuedWork(state: StaleQueuedWorkState, event: StaleQueuedWorkEvent): StaleQueuedWorkTransitionResult {
  switch (event.type) {
    case "runnableWorkStarted":
      if (state.kind === "abortingTurn") {
        return transition(state, emptyPlan());
      }
      return transition({ ...beginObservingTurn(state), hasRunnableWork: true }, emptyPlan());
    case "staleWorkStarted": {
      if (state.kind === "abortingTurn") {
        return transition(state, emptyPlan());
      }
      const observing = beginObservingTurn(state);
      observing.staleGoalIds.add(event.goalId);
      return transition(observing, emptyPlan());
    }
    case "contextAbort":
      return reduceContextAbort(state, event.currentTurnIndex);
    case "userInputClearAbort": {
      const result = releaseAbortingTurn(state);
      if (result.plan?.effects.length) {
        return transition(result.state, {
          skip: false,
          effects: [...result.plan.effects, { type: "refreshUi" }],
        });
      }
      return result;
    }
    case "extensionContinuationClearAbort":
    case "beforeAgentStartClearAbort":
      return releaseAbortingTurn(state);
    case "turnStart": {
      const nextState = state.kind === "observingTurn" ? finishObservingTurn(state) : state;
      return releaseAbortingTurn(nextState);
    }
    case "toolExecutionEnd":
    case "sessionBeforeCompact":
    case "sessionCompact":
      return state.kind === "abortingTurn"
        ? transition(state, skipPlan({ type: "clearAccounting" }, { type: "refreshUi" }))
        : transition(state, emptyPlan());
    case "turnEnd":
      return reduceTurnEnd(state, event.turnIndex);
    case "agentEnd":
      return reduceAgentEnd(state, event.messages);
    case "sessionShutdown": {
      const effects: StaleQueuedWorkEffect[] =
        state.kind === "abortingTurn" ? [{ type: "clearAccounting" }] : [];
      return transition({ kind: "idle" }, { skip: false, effects });
    }
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function reduceContextAbort(state: State, currentTurnIndex: number | null): StaleQueuedWorkTransitionResult {
  if (state.kind === "abortingTurn") {
    return transition(state, {
      skip: false,
      effects: [{ type: "clearAccounting" }, { type: "abort" }, { type: "refreshUi" }],
    });
  }

  if (state.kind !== "observingTurn") {
    return transition(state, null);
  }

  if (state.staleGoalIds.size === 0 || state.hasRunnableWork) {
    if (state.terminalCleanup === undefined) {
      return transition(state, null);
    }
    setAnonymousMatching(state.terminalCleanup.pendingAgentEndObligations, false);
    return transition(
      {
        kind: "awaitingTerminalCleanup",
        pendingTurnEndIndexes: state.terminalCleanup.pendingTurnEndIndexes,
        pendingAgentEndObligations: state.terminalCleanup.pendingAgentEndObligations,
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

function reduceTurnEnd(state: State, turnIndex: number | null): StaleQueuedWorkTransitionResult {
  if (state.kind === "abortingTurn") {
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

  const pending = terminalCleanupFromLifecycle(state);
  if (pending === null || !consumePendingStaleTurnEnd(pending.cleanup, turnIndex)) {
    return transition(state, emptyPlan());
  }
  return transition(
    resolveLifecycleAfterTerminalCleanup(pending.cleanup, pending.observing),
    skipPlan({ type: "refreshUi" }),
  );
}

function reduceAgentEnd(state: State, messages: AgentEndMessage[]): StaleQueuedWorkTransitionResult {
  if (state.kind === "abortingTurn") {
    const plan = abortingAgentEndPlan(state, messages);
    if (plan.skip && plan.effects.some((effect) => effect.type === "clearAccounting")) {
      return finishActiveAbortingLifecycle(state);
    }
    return transition(state, plan);
  }

  const pending = terminalCleanupFromLifecycle(state);
  if (pending === null || !consumePendingStaleAgentEnd(pending.cleanup, messages)) {
    return transition(state, emptyPlan());
  }
  return transition(
    resolveLifecycleAfterTerminalCleanup(pending.cleanup, pending.observing),
    skipPlan({ type: "refreshUi" }),
  );
}


export function createInitialStaleQueuedWorkState(): StaleQueuedWorkState {
  return { kind: "idle" };
}
