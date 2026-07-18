import { StringEnum } from "@earendil-works/pi-ai/compat";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { goalToolResponse, toToolText, type GoalToolResponse } from "./format.js";
import { createGoal, replaceGoal } from "./state.js";
import { TOOL_PROMPT_GUIDELINES } from "./prompts.js";
import type { GoalEntrySource, GoalResult, GoalTimeConstraints, ThreadGoal } from "./types.js";

const EmptyParams = Type.Object({});

const CreateGoalParams = Type.Object({
  objective: Type.String({
    description: "Concrete objective to pursue until completion.",
  }),
  minimum_time_minutes: Type.Optional(
    Type.Integer({
      description: "Optional positive whole minimum active time in minutes.",
      minimum: 1,
    }),
  ),
  maximum_time_minutes: Type.Optional(
    Type.Integer({
      description: "Optional positive whole maximum active time in minutes.",
      minimum: 1,
    }),
  ),
  replace_existing: Type.Optional(
    Type.Boolean({
      description:
        "Replace an existing non-complete goal. Use only when the user explicitly asks to set a new goal over the current one.",
    }),
  ),
});

const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete", "blocked"] as const, {
    description:
      "Use complete only after every requirement is verified. Use blocked only when no safe in-scope path remains without unavailable input, authority, access, or dependencies.",
  }),
});

export interface ToolHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  blockGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
  completeGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
}

function textResult(
  text: string,
  goal: ThreadGoal | null,
  includeCompletionUsageReport = false,
): AgentToolResult<GoalToolResponse & { error: string | null }> {
  return {
    content: [{ type: "text", text }],
    details: { ...goalToolResponse(goal, includeCompletionUsageReport), error: null },
  };
}

function throwToolError(message: string): never {
  throw new Error(message);
}

function constraintsFromMinutes(
  minimumTimeMinutes: number | undefined,
  maximumTimeMinutes: number | undefined,
): GoalTimeConstraints {
  return {
    minimumActiveSeconds: minimumTimeMinutes === undefined ? null : minimumTimeMinutes * 60,
    maximumActiveSeconds: maximumTimeMinutes === undefined ? null : maximumTimeMinutes * 60,
  };
}

export function registerGoalTools(pi: ExtensionAPI, host: ToolHost): void {
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current Codex-style goal and usage for this pi session.",
    promptSnippet: "Inspect the current goal, status, constraints, and usage.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: EmptyParams,
    async execute() {
      const goal = host.getGoal();
      return textResult(toToolText(goal), goal);
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a Codex-style long-running goal for this pi session.",
    promptSnippet: "Create one goal with an objective and optional active-time constraints.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: CreateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = host.getGoal();
      const shouldReplaceExisting =
        params.replace_existing === true && current !== null && current.status !== "complete";
      const constraints = constraintsFromMinutes(
        params.minimum_time_minutes,
        params.maximum_time_minutes,
      );
      const result = shouldReplaceExisting
        ? replaceGoal(params.objective, constraints)
        : createGoal(current, params.objective, constraints);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      host.setGoal(result.goal, "tool", ctx);
      return textResult(toToolText(result.goal), result.goal);
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Mark the current goal complete after an evidence-backed audit, or blocked when no safe in-scope path remains without unavailable input, authority, access, or dependencies.",
    promptSnippet: "Mark the current goal complete or blocked under the goal lifecycle rules.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: UpdateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result =
        params.status === "complete" ? host.completeGoal("tool", ctx) : host.blockGoal("tool", ctx);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      const includeCompletionUsageReport = params.status === "complete";
      return textResult(
        toToolText(result.goal, includeCompletionUsageReport),
        result.goal,
        includeCompletionUsageReport,
      );
    },
  });
}
