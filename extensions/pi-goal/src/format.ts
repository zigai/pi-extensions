import type { ThreadGoal } from "./types.js";

const COMPACT_TOKEN_UNITS = [
  { suffix: "T", value: 1_000_000_000_000 },
  { suffix: "B", value: 1_000_000_000 },
  { suffix: "M", value: 1_000_000 },
  { suffix: "K", value: 1_000 },
] as const;

export function formatDuration(seconds: number): string {
  const normalized = Math.max(0, Math.trunc(seconds));
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const remainingSeconds = normalized % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

export function formatInteger(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString("en-US");
}

export function formatCompactTokenValue(value: number): string {
  const normalized = Math.max(0, Math.trunc(value));
  if (normalized < 100_000) {
    return formatInteger(normalized);
  }

  const unit = COMPACT_TOKEN_UNITS.find((candidate) => normalized >= candidate.value);
  if (!unit) {
    return formatInteger(normalized);
  }

  const scaled = normalized / unit.value;
  const fractionDigits = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  const compact = scaled.toLocaleString("en-US", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  });
  return `${compact}${unit.suffix}`;
}

export function formatTokenValue(value: number): string {
  const exact = formatInteger(value);
  const compact = formatCompactTokenValue(value);
  if (compact === exact) {
    return exact;
  }
  return `${compact} (${exact})`;
}

export function formatBudget(goal: ThreadGoal): string {
  if (goal.tokenBudget === null) {
    return `${formatTokenValue(goal.usage.tokensUsed)} tokens`;
  }
  return `${formatTokenValue(goal.usage.tokensUsed)}/${formatTokenValue(goal.tokenBudget)} tokens`;
}

export function formatGoalSummary(goal: ThreadGoal | null): string {
  if (!goal) {
    return "No goal is set.";
  }
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Usage: ${formatBudget(goal)}, ${formatDuration(goal.usage.activeSeconds)} active`,
  ].join("\n");
}

export function formatFooterStatus(goal: ThreadGoal | null): string | undefined {
  if (!goal) {
    return undefined;
  }

  const status =
    goal.status === "budgetLimited"
      ? "budget"
      : goal.status === "complete"
        ? "done"
        : goal.status;
  return `Goal ${status}: ${formatBudget(goal)}, ${formatDuration(goal.usage.activeSeconds)}`;
}

export function toToolText(goal: ThreadGoal | null): string {
  return JSON.stringify(
    {
      has_goal: goal !== null,
      goal: goal
        ? {
            goal_id: goal.goalId,
            objective: goal.objective,
            status: goal.status,
            token_budget: goal.tokenBudget,
            tokens_used: goal.usage.tokensUsed,
            active_seconds: goal.usage.activeSeconds,
            created_at: goal.createdAt,
            updated_at: goal.updatedAt,
          }
        : null,
    },
    null,
    2,
  );
}
