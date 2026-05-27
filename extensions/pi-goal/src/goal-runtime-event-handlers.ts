import { createAgentEventHandlers } from "./goal-runtime-agent-handlers.js";
import { createInputContextEventHandlers } from "./goal-runtime-input-context-handlers.js";
import { createSessionEventHandlers } from "./goal-runtime-session-handlers.js";
import { createTurnEventHandlers } from "./goal-runtime-turn-handlers.js";
import { createQueuedGoalWorkMessageIdResolver } from "./goal-runtime-event-utils.js";
import type {
  GoalRuntimeEventHandlerDeps,
  GoalRuntimeEventHandlers,
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

  return {
    ...createInputContextEventHandlers(deps, queuedGoalWorkMessageIdForRuntime),
    ...createTurnEventHandlers(deps),
    ...createAgentEventHandlers(deps),
    ...createSessionEventHandlers(deps),
  };
}
