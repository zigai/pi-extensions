import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ExtensionHandler,
  InputEvent,
  InputEventResult,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

import type { GoalRuntimeState } from "./goal-runtime-state.js";
import type { GoalStateController } from "./goal-state-controller.js";
import type { AssistantErrorMessage } from "./recovery.js";

export type ContextEventResult = { messages?: ContextEvent["messages"] };
export type MessageStartEvent = Extract<ExtensionEvent, { type: "message_start" }>;
export type ToolExecutionEndEvent = Extract<ExtensionEvent, { type: "tool_execution_end" }>;

export interface GoalRuntimeEventHandlers {
  onInput: ExtensionHandler<InputEvent, InputEventResult>;
  onContext: ExtensionHandler<ContextEvent, ContextEventResult | undefined>;
  onSessionStart: ExtensionHandler<SessionStartEvent>;
  onSessionTree: ExtensionHandler<SessionTreeEvent>;
  onBeforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, undefined>;
  onMessageStart: ExtensionHandler<MessageStartEvent>;
  onTurnStart: ExtensionHandler<TurnStartEvent>;
  onToolExecutionEnd: ExtensionHandler<ToolExecutionEndEvent>;
  onTurnEnd: ExtensionHandler<TurnEndEvent>;
  onAgentEnd: ExtensionHandler<AgentEndEvent>;
  onSessionBeforeCompact: ExtensionHandler<SessionBeforeCompactEvent>;
  onSessionCompact: ExtensionHandler<SessionCompactEvent>;
  onSessionShutdown: ExtensionHandler<SessionShutdownEvent>;
}

export interface GoalRuntimeStatusPort {
  refreshUi: (ctx: ExtensionContext) => void;
  stopStatusRefresh: () => void;
}

export interface GoalRuntimeContinuationPort {
  bindPassthroughContinuationInputToTurn: (turnIndex: number) => void;
  clearContinuationState: () => void;
  clearContinuationStateFor: (goalId: string) => void;
  clearContinuationTimer: () => void;
  clearPassthroughContinuationInput: () => void;
  continuationGoalIdFromRuntimePrompt: (prompt: string) => string | null;
  maybeContinue: (ctx: ExtensionContext) => void;
  notePassthroughContinuationInput: (input: string) => void;
}

export interface GoalAccountingPort {
  accountProgress: (
    ctx: ExtensionContext,
    includeActiveElapsed: boolean,
    completedTurnTokens: number,
    forceFlush?: boolean,
  ) => void;
  beginAccounting: () => void;
}

export interface RecoveryRuntimePort {
  finishSuccessfulAssistantTurn: (
    message: TurnEndEvent["message"],
    ctx: ExtensionContext,
    options: { continueGoal: boolean },
  ) => void;
  handlePersistentAssistantError: (message: AssistantErrorMessage, ctx: ExtensionContext) => void;
  handleSilentContextOverflow: (ctx: ExtensionContext) => void;
  onSessionCompact: () => void;
  onUserInput: () => void;
}

export interface GoalRuntimeEventHandlerDeps {
  pi: ExtensionAPI;
  runtimeState: GoalRuntimeState;
  stateController: GoalStateController;
  continuation: GoalRuntimeContinuationPort;
  goalAccounting: GoalAccountingPort;
  recoveryRuntime: RecoveryRuntimePort;
  status: GoalRuntimeStatusPort;
  clearActiveAccounting: () => void;
  resetErrorRecovery: () => void;
}

export interface StaleQueuedWorkRuntimePort {
  clearActiveAccounting: () => void;
  status: GoalRuntimeStatusPort;
}

export interface InputContextHandlerDeps extends StaleQueuedWorkRuntimePort {
  runtimeState: GoalRuntimeState;
  stateController: GoalStateController;
  continuation: GoalRuntimeContinuationPort;
  recoveryRuntime: RecoveryRuntimePort;
  resetErrorRecovery: () => void;
}

export interface TurnHandlerDeps extends StaleQueuedWorkRuntimePort {
  runtimeState: GoalRuntimeState;
  stateController: GoalStateController;
  continuation: GoalRuntimeContinuationPort;
  goalAccounting: GoalAccountingPort;
  recoveryRuntime: RecoveryRuntimePort;
}

export interface AgentHandlerDeps extends StaleQueuedWorkRuntimePort, RecoveryEventDeps {
  runtimeState: GoalRuntimeState;
  continuation: GoalRuntimeContinuationPort;
  goalAccounting: GoalAccountingPort;
  resetErrorRecovery: () => void;
}

export interface SessionHandlerDeps extends StaleQueuedWorkRuntimePort {
  pi: ExtensionAPI;
  runtimeState: GoalRuntimeState;
  stateController: GoalStateController;
  continuation: GoalRuntimeContinuationPort;
  goalAccounting: GoalAccountingPort;
  recoveryRuntime: RecoveryRuntimePort;
  resetErrorRecovery: () => void;
}

export interface RecoveryEventDeps {
  stateController: GoalStateController;
  recoveryRuntime: RecoveryRuntimePort;
}

export type QueuedGoalWorkMessage = {
  role: string;
  customType?: string;
  details?: unknown;
  content?: unknown;
};

export type QueuedGoalWorkMessageIdResolver = (message: QueuedGoalWorkMessage) => string | null;
