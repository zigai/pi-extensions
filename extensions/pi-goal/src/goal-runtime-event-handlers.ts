import { createAgentEventHandlers } from "./goal-runtime-agent-handlers.js";
import { createInputContextEventHandlers } from "./goal-runtime-input-context-handlers.js";
import { createSessionEventHandlers } from "./goal-runtime-session-handlers.js";
import { createTurnEventHandlers } from "./goal-runtime-turn-handlers.js";
import { createQueuedGoalWorkMessageIdResolver } from "./goal-runtime-event-utils.js";
import type {
  AgentHandlerDeps,
  GoalRuntimeEventHandlerDeps,
  GoalRuntimeEventHandlers,
  InputContextHandlerDeps,
  SessionHandlerDeps,
  TurnHandlerDeps,
} from "./goal-runtime-event-handler-types.js";

export type {
  ContextEventResult,
  GoalRuntimeEventHandlers,
  MessageStartEvent,
  ToolExecutionEndEvent,
} from "./goal-runtime-event-handler-types.js";

export function createGoalRuntimeEventHandlers(
  deps: GoalRuntimeEventHandlerDeps,
): GoalRuntimeEventHandlers {
  const queuedGoalWorkMessageIdForRuntime = createQueuedGoalWorkMessageIdResolver(
    deps.continuation,
  );

  const staleQueuedWorkRuntime = {
    clearActiveAccounting: deps.clearActiveAccounting,
    status: deps.status,
  };
  const inputContextDeps: InputContextHandlerDeps = {
    ...staleQueuedWorkRuntime,
    runtimeState: deps.runtimeState,
    stateController: deps.stateController,
    continuation: deps.continuation,
    recoveryRuntime: deps.recoveryRuntime,
    resetErrorRecovery: deps.resetErrorRecovery,
  };
  const turnDeps: TurnHandlerDeps = {
    ...staleQueuedWorkRuntime,
    runtimeState: deps.runtimeState,
    stateController: deps.stateController,
    continuation: deps.continuation,
    goalAccounting: deps.goalAccounting,
    recoveryRuntime: deps.recoveryRuntime,
  };
  const agentDeps: AgentHandlerDeps = {
    ...staleQueuedWorkRuntime,
    runtimeState: deps.runtimeState,
    stateController: deps.stateController,
    continuation: deps.continuation,
    goalAccounting: deps.goalAccounting,
    recoveryRuntime: deps.recoveryRuntime,
    resetErrorRecovery: deps.resetErrorRecovery,
  };
  const sessionDeps: SessionHandlerDeps = {
    ...staleQueuedWorkRuntime,
    pi: deps.pi,
    runtimeState: deps.runtimeState,
    stateController: deps.stateController,
    continuation: deps.continuation,
    goalAccounting: deps.goalAccounting,
    recoveryRuntime: deps.recoveryRuntime,
    resetErrorRecovery: deps.resetErrorRecovery,
  };

  return {
    ...createInputContextEventHandlers(inputContextDeps, queuedGoalWorkMessageIdForRuntime),
    ...createTurnEventHandlers(turnDeps),
    ...createAgentEventHandlers(agentDeps),
    ...createSessionEventHandlers(sessionDeps),
  };
}
