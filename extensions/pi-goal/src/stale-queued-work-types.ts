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

export type TerminalObligationPhase = "older" | "active";

/** One stale abort's pending agent_end: match goalIds, or id-less when acceptsAnonymous. */
export type AgentEndObligation = {
  goalIds: Set<string>;
  acceptsAnonymous: boolean;
  phase: TerminalObligationPhase;
};

export type TerminalCleanup = {
  pendingTurnEndIndexes: Set<number>;
  pendingAgentEndObligations: AgentEndObligation[];
};

export type ObservingTurnState = {
  kind: "observingTurn";
  staleGoalIds: Set<string>;
  hasRunnableWork: boolean;
  terminalCleanup?: TerminalCleanup;
};

export type AbortingTurnState = {
  kind: "abortingTurn";
  activeTurnIndex: number | null;
  terminalCleanup: TerminalCleanup;
};

export type AwaitingTerminalCleanupState = {
  kind: "awaitingTerminalCleanup";
  terminalCleanup: TerminalCleanup;
};

export type StaleQueuedWorkState =
  | { kind: "idle" }
  | ObservingTurnState
  | AbortingTurnState
  | AwaitingTerminalCleanupState;

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
  | { type: "turnEnd"; turnIndex: number | null }
  | { type: "agentEnd"; messages: AgentEndMessage[] }
  | { type: "sessionShutdown" };

export type StaleQueuedWorkTransitionResult = {
  state: StaleQueuedWorkState;
  plan: StaleQueuedWorkPlan | null;
};
