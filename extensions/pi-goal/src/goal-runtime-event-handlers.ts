import { createAgentEventHandlers } from "./goal-runtime-agent-handlers.js";
import { createInputContextEventHandlers } from "./goal-runtime-input-context-handlers.js";
import { createSessionEventHandlers } from "./goal-runtime-session-handlers.js";
import { createTurnEventHandlers } from "./goal-runtime-turn-handlers.js";
import { createQueuedGoalWorkMessageIdResolver } from "./goal-runtime-event-utils.js";
import type {
  GoalRuntimeEventContext,
  GoalRuntimeEventHandlers,
} from "./goal-runtime-event-handler-types.js";

export type {
  ContextEventResult,
  GoalRuntimeEventHandlers,
  MessageStartEvent,
  ToolExecutionEndEvent,
} from "./goal-runtime-event-handler-types.js";

export function createGoalRuntimeEventHandlers(
  context: GoalRuntimeEventContext,
): GoalRuntimeEventHandlers {
  const queuedGoalWorkMessageIdForRuntime = createQueuedGoalWorkMessageIdResolver(
    context.continuation,
  );

  return {
    ...createInputContextEventHandlers(context, queuedGoalWorkMessageIdForRuntime),
    ...createTurnEventHandlers(context),
    ...createAgentEventHandlers(context),
    ...createSessionEventHandlers(context),
  };
}
