import { formatRecoveryAttention, type RecoveryAttention } from "./recovery.js";
import type { GoalStatus, ThreadGoal } from "./types.js";

const COMPACT_TOKEN_UNITS = [
  { suffix: "T", value: 1_000_000_000_000 },
  { suffix: "B", value: 1_000_000_000 },
  { suffix: "M", value: 1_000_000 },
  { suffix: "K", value: 1_000 },
] as const;

export interface GoalToolRecord {
  goalId: string;
  objective: string;
  status: GoalStatus;
  minimumActiveSeconds: number | null;
  maximumActiveSeconds: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalToolResponse {
  goal: GoalToolRecord | null;
  minimumTimeRemainingSeconds: number | null;
  maximumTimeRemainingSeconds: number | null;
  completionUsageReport: string | null;
}

export function formatDuration(seconds: number): string {
  const normalized = Math.max(0, Math.trunc(seconds));
  const days = Math.floor(normalized / 86_400);
  const hours = Math.floor((normalized % 86_400) / 3_600);
  const minutes = Math.floor((normalized % 3_600) / 60);
  const remainingSeconds = normalized % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
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

function statusLabel(status: GoalStatus): string {
  return status === "timeLimited" ? "limited by maximum time" : status;
}

function commandHint(status: GoalStatus): string {
  if (status === "active") {
    return "/goal pause";
  }
  if (status === "paused" || status === "blocked") {
    return "/goal resume";
  }
  if (status === "complete") {
    return "/goal <goal> to replace";
  }
  return "/goal <goal> to replace";
}

export function formatGoalSummary(goal: ThreadGoal | null): string {
  if (!goal) {
    return ["Usage: /goal <goal> or /goal -r <goal>", "No goal is currently set."].join("\n");
  }

  const lines = [
    `Status: ${statusLabel(goal.status)}`,
    `Objective: ${goal.objective}`,
    `Time used: ${formatDuration(goal.usage.activeSeconds)}`,
    `Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}`,
  ];

  if (goal.minimumActiveSeconds !== null) {
    lines.push(`Minimum active time: ${formatDuration(goal.minimumActiveSeconds)}`);
  }
  if (goal.maximumActiveSeconds !== null) {
    lines.push(`Maximum active time: ${formatDuration(goal.maximumActiveSeconds)}`);
  }
  lines.push(`Hint: ${commandHint(goal.status)}`);
  return lines.join("\n");
}

export function formatFooterStatus(
  goal: ThreadGoal | null,
  recoveryAttention: RecoveryAttention | null = null,
  providerLimitAutoResumeScheduled = false,
): string | undefined {
  if (!goal) {
    return undefined;
  }

  if (goal.status === "timeLimited") {
    return `Goal reached its maximum active time (${formatDuration(goal.usage.activeSeconds)})`;
  }

  if (goal.status === "paused" && providerLimitAutoResumeScheduled) {
    return "Goal paused because the provider usage limit was reached. Auto-resume will retry in about 5 minutes. Use /goal resume to resume now.";
  }

  const recoveryAttentionMessage = formatRecoveryAttention(recoveryAttention);
  if (recoveryAttentionMessage) {
    return recoveryAttentionMessage;
  }

  if (goal.status === "active") {
    if (goal.maximumActiveSeconds !== null) {
      return `Pursuing goal (${formatDuration(goal.usage.activeSeconds)} / ${formatDuration(goal.maximumActiveSeconds)} max)`;
    }
    if (goal.usage.activeSeconds > 0) {
      return `Pursuing goal (${formatDuration(goal.usage.activeSeconds)})`;
    }
    return "Pursuing goal";
  }

  if (goal.status === "paused") {
    return "Goal paused (/goal resume)";
  }

  if (goal.status === "blocked") {
    return "Goal blocked (/goal resume after resolving the blocker)";
  }

  if (goal.usage.activeSeconds > 0) {
    return `Goal achieved (${formatDuration(goal.usage.activeSeconds)})`;
  }
  return "Goal achieved";
}

export function toToolGoal(goal: ThreadGoal): GoalToolRecord {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    minimumActiveSeconds: goal.minimumActiveSeconds,
    maximumActiveSeconds: goal.maximumActiveSeconds,
    tokensUsed: goal.usage.tokensUsed,
    timeUsedSeconds: goal.usage.activeSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export function minimumTimeRemainingSeconds(goal: ThreadGoal | null): number | null {
  if (!goal || goal.minimumActiveSeconds === null) {
    return null;
  }
  return Math.max(0, goal.minimumActiveSeconds - goal.usage.activeSeconds);
}

export function maximumTimeRemainingSeconds(goal: ThreadGoal | null): number | null {
  if (!goal || goal.maximumActiveSeconds === null) {
    return null;
  }
  return Math.max(0, goal.maximumActiveSeconds - goal.usage.activeSeconds);
}

export function completionUsageReport(goal: ThreadGoal | null): string | null {
  if (!goal || goal.status !== "complete") {
    return null;
  }
  if (goal.usage.activeSeconds <= 0 && goal.usage.tokensUsed <= 0) {
    return null;
  }

  const parts: string[] = [];
  if (goal.usage.activeSeconds > 0) {
    parts.push(`time used: ${formatDuration(goal.usage.activeSeconds)}.`);
  }
  if (goal.usage.tokensUsed > 0) {
    parts.push(`tokens used: ${formatInteger(goal.usage.tokensUsed)}.`);
  }

  return `Goal achieved. Report final usage to the user: ${parts.join(" ")}`;
}

export function goalToolResponse(
  goal: ThreadGoal | null,
  includeCompletionUsageReport = false,
): GoalToolResponse {
  return {
    goal: goal ? toToolGoal(goal) : null,
    minimumTimeRemainingSeconds: minimumTimeRemainingSeconds(goal),
    maximumTimeRemainingSeconds: maximumTimeRemainingSeconds(goal),
    completionUsageReport: includeCompletionUsageReport ? completionUsageReport(goal) : null,
  };
}

export function toToolText(goal: ThreadGoal | null, includeCompletionUsageReport = false): string {
  return JSON.stringify(goalToolResponse(goal, includeCompletionUsageReport), null, 2);
}
