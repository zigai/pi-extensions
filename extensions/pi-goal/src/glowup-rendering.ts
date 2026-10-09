import {
  call,
  output,
  text,
  type GlowupRenderer,
  type GlowupToolResult,
} from "@zigai/pi-glowup/protocol";

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { formatCompactTokenValue, formatDuration } from "./format.js";

export const GetGoalArgsSchema = Type.Object({});
export const CreateGoalArgsSchema = Type.Object({
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

export const UpdateGoalArgsSchema = Type.Object({
  status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")], {
    description:
      "Use complete only after every requirement is verified. Use blocked only when no safe in-scope path remains without unavailable input, authority, access, or dependencies.",
  }),
});

const RenderedGoalSchema = Type.Object({
  objective: Type.String(),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("paused"),
    Type.Literal("blocked"),
    Type.Literal("timeLimited"),
    Type.Literal("complete"),
  ]),
  tokensUsed: Type.Number(),
  timeUsedSeconds: Type.Number(),
});

const GoalRenderingResultSchema = Type.Object({
  goal: Type.Union([RenderedGoalSchema, Type.Null()]),
});

const GlowupTextResultSchema = Type.Object({
  content: Type.Optional(
    Type.Array(
      Type.Object({
        type: Type.String(),
        text: Type.Optional(Type.String()),
      }),
    ),
  ),
  details: Type.Optional(GoalRenderingResultSchema),
});

export type GetGoalArgs = Static<typeof GetGoalArgsSchema>;
export type CreateGoalArgs = Static<typeof CreateGoalArgsSchema>;
export type UpdateGoalArgs = Static<typeof UpdateGoalArgsSchema>;
type GoalRenderingResult = Static<typeof GoalRenderingResultSchema>;

function parseGetGoalArgs(value: unknown): GetGoalArgs | undefined {
  try {
    return Value.Parse(GetGoalArgsSchema, value);
  } catch {
    return undefined;
  }
}

function parseCreateGoalArgs(value: unknown): CreateGoalArgs | undefined {
  try {
    return Value.Parse(CreateGoalArgsSchema, value);
  } catch {
    return undefined;
  }
}

function parseUpdateGoalArgs(value: unknown): UpdateGoalArgs | undefined {
  try {
    return Value.Parse(UpdateGoalArgsSchema, value);
  } catch {
    return undefined;
  }
}

function parseGoalResponse(value: unknown): GoalRenderingResult | undefined {
  try {
    const result = Value.Parse(GoalRenderingResultSchema, value);
    if (result.goal === null) {
      return result;
    }

    return {
      goal: {
        ...result.goal,
        tokensUsed: Math.max(0, Math.trunc(result.goal.tokensUsed)),
        timeUsedSeconds: Math.max(0, Math.trunc(result.goal.timeUsedSeconds)),
      },
    };
  } catch {
    return undefined;
  }
}

function resultText(result: GlowupToolResult): string | undefined {
  try {
    const parsed = Value.Parse(GlowupTextResultSchema, result);

    return parsed.content?.find((item) => item.type === "text")?.text;
  } catch {
    return undefined;
  }
}

function parseGoalResult(value: unknown): GoalRenderingResult | undefined {
  let result: Static<typeof GlowupTextResultSchema>;
  try {
    result = Value.Parse(GlowupTextResultSchema, value);
  } catch {
    return undefined;
  }

  if (result.details !== undefined) return parseGoalResponse(result.details);

  const serialized = resultText(result);
  if (serialized === undefined) return undefined;
  try {
    return parseGoalResponse(JSON.parse(serialized));
  } catch {
    return undefined;
  }
}

function formatGoalResult(result: GoalRenderingResult): string {
  if (result.goal === null) return "No active goal";

  const metadata = [
    result.goal.tokensUsed > 0
      ? `${formatCompactTokenValue(result.goal.tokensUsed)} tok`
      : undefined,
    result.goal.timeUsedSeconds > 0 ? formatDuration(result.goal.timeUsedSeconds) : undefined,
  ].filter((value): value is string => value !== undefined);
  const suffix = metadata.length === 0 ? "" : ` (${metadata.join(", ")})`;
  return `${result.goal.status}: ${result.goal.objective}${suffix}`;
}

export const getGoalGlowupRendering = {
  version: 3,
  parseArgs: parseGetGoalArgs,
  parseResult: parseGoalResult,
  renderCall() {
    return call({ static: "Check Goal", running: "Checking Goal", completed: "Checked Goal" });
  },
  renderResult(result) {
    return output(formatGoalResult(result), { preview: { mode: "head", collapsedLines: 2 } });
  },
} satisfies GlowupRenderer<GetGoalArgs, GoalRenderingResult>;

export const createGoalGlowupRendering = {
  version: 3,
  parseArgs: parseCreateGoalArgs,
  parseResult: parseGoalResult,
  renderCall(args) {
    return call(
      { static: "Create Goal", running: "Creating Goal", completed: "Created Goal" },
      { body: text(args.objective), preview: { mode: "head", collapsedLines: 4 } },
    );
  },
  renderResult(result) {
    return output(formatGoalResult(result), { preview: { mode: "head", collapsedLines: 2 } });
  },
} satisfies GlowupRenderer<CreateGoalArgs, GoalRenderingResult>;

export const updateGoalGlowupRendering = {
  version: 3,
  parseArgs: parseUpdateGoalArgs,
  parseResult: parseGoalResult,
  renderCall(args) {
    return args.status === "complete"
      ? call({
          static: "Complete Goal",
          running: "Completing Goal",
          completed: "Completed Goal",
        })
      : call({ static: "Update Goal", running: "Updating Goal", completed: "Updated Goal" });
  },
  renderResult(result) {
    return output(formatGoalResult(result), { preview: { mode: "head", collapsedLines: 2 } });
  },
} satisfies GlowupRenderer<UpdateGoalArgs, GoalRenderingResult>;
