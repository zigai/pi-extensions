import {
  call,
  output,
  text,
  type GlowupRenderer,
  type GlowupToolResult,
} from "@zigai/pi-glowup/protocol";

import { formatCompactTokenValue, formatDuration } from "./format.js";
import type { GoalStatus } from "./types.js";

type GetGoalArgs = Readonly<Record<string, never>>;

type CreateGoalArgs = {
  readonly objective: string;
  readonly minimum_time_minutes?: number;
  readonly maximum_time_minutes?: number;
  readonly replace_existing?: boolean;
};

type UpdateGoalArgs = {
  readonly status: "complete" | "blocked";
};

type RenderedGoal = {
  readonly objective: string;
  readonly status: GoalStatus;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
};

type GoalRenderingResult = {
  readonly goal: RenderedGoal | null;
};

function isGoalStatus(value: unknown): value is GoalStatus {
  return (
    value === "active" ||
    value === "paused" ||
    value === "blocked" ||
    value === "timeLimited" ||
    value === "complete"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalPositiveInteger(record: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = record[key];
  return (
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 1)
  );
}

function parseGetGoalArgs(value: unknown): GetGoalArgs | undefined {
  return isRecord(value) ? {} : undefined;
}

function parseCreateGoalArgs(value: unknown): CreateGoalArgs | undefined {
  if (!isRecord(value) || typeof value.objective !== "string") return undefined;
  if (
    !optionalPositiveInteger(value, "minimum_time_minutes") ||
    !optionalPositiveInteger(value, "maximum_time_minutes") ||
    (value.replace_existing !== undefined && typeof value.replace_existing !== "boolean")
  ) {
    return undefined;
  }
  return {
    objective: value.objective,
    ...(typeof value.minimum_time_minutes === "number"
      ? { minimum_time_minutes: value.minimum_time_minutes }
      : {}),
    ...(typeof value.maximum_time_minutes === "number"
      ? { maximum_time_minutes: value.maximum_time_minutes }
      : {}),
    ...(typeof value.replace_existing === "boolean"
      ? { replace_existing: value.replace_existing }
      : {}),
  };
}

function parseUpdateGoalArgs(value: unknown): UpdateGoalArgs | undefined {
  if (!isRecord(value) || (value.status !== "complete" && value.status !== "blocked")) {
    return undefined;
  }
  return { status: value.status };
}

function parseGoal(value: unknown): RenderedGoal | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.objective !== "string" ||
    !isGoalStatus(value.status) ||
    typeof value.tokensUsed !== "number" ||
    !Number.isFinite(value.tokensUsed) ||
    typeof value.timeUsedSeconds !== "number" ||
    !Number.isFinite(value.timeUsedSeconds)
  ) {
    return undefined;
  }
  return {
    objective: value.objective,
    status: value.status,
    tokensUsed: Math.max(0, Math.trunc(value.tokensUsed)),
    timeUsedSeconds: Math.max(0, Math.trunc(value.timeUsedSeconds)),
  };
}

function parseGoalResponse(value: unknown): GoalRenderingResult | undefined {
  if (!isRecord(value) || !("goal" in value)) return undefined;
  const goal = parseGoal(value.goal);
  return goal === undefined ? undefined : { goal };
}

function resultText(result: GlowupToolResult): string | undefined {
  if (!Array.isArray(result.content)) return undefined;
  for (const item of result.content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
  }
  return undefined;
}

function parseGoalResult(value: unknown): GoalRenderingResult | undefined {
  if (!isRecord(value)) return undefined;
  const details = parseGoalResponse(value.details);
  if (details !== undefined) return details;
  const text = resultText(value);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parseGoalResponse(parsed);
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
