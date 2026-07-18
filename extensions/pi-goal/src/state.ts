import { randomUUID } from "node:crypto";

import {
  CUSTOM_ENTRY_TYPE,
  MAX_OBJECTIVE_CHARS,
  type GoalCustomEntry,
  type GoalEntrySource,
  type GoalResult,
  type GoalSnapshot,
  type GoalStatus,
  type GoalTimeConstraints,
  type GoalUsage,
  type RuntimeUsageGoalStatus,
  type SessionEntryLike,
  type ThreadGoal,
} from "./types.js";

export interface ApplyUsageOptions {
  expectedGoalId?: string | null;
  accountTimeLimited?: boolean;
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function cloneUsage(usage: GoalUsage): GoalUsage {
  return { ...usage };
}

export function cloneGoal(goal: ThreadGoal): ThreadGoal {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    minimumActiveSeconds: goal.minimumActiveSeconds,
    maximumActiveSeconds: goal.maximumActiveSeconds,
    usage: cloneUsage(goal.usage),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export function goalsEquivalent(left: ThreadGoal, right: ThreadGoal): boolean {
  return (
    left.goalId === right.goalId &&
    left.objective === right.objective &&
    left.status === right.status &&
    left.minimumActiveSeconds === right.minimumActiveSeconds &&
    left.maximumActiveSeconds === right.maximumActiveSeconds &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.usage.tokensUsed === right.usage.tokensUsed &&
    left.usage.activeSeconds === right.usage.activeSeconds
  );
}

export function validateObjective(objective: string): string | null {
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    return "Objective must not be empty.";
  }
  if ([...trimmed].length > MAX_OBJECTIVE_CHARS) {
    return `Objective must be ${MAX_OBJECTIVE_CHARS} characters or fewer.`;
  }
  return null;
}

function validateActiveSeconds(value: number | null, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    return `${label} must be a positive whole number of seconds.`;
  }
  return null;
}

export function validateGoalTimeConstraints(constraints: GoalTimeConstraints): string | null {
  const minimumError = validateActiveSeconds(
    constraints.minimumActiveSeconds,
    "Minimum active time",
  );
  if (minimumError !== null) {
    return minimumError;
  }
  const maximumError = validateActiveSeconds(
    constraints.maximumActiveSeconds,
    "Maximum active time",
  );
  if (maximumError !== null) {
    return maximumError;
  }
  if (
    constraints.minimumActiveSeconds !== null &&
    constraints.maximumActiveSeconds !== null &&
    constraints.minimumActiveSeconds > constraints.maximumActiveSeconds
  ) {
    return "Minimum active time must not exceed maximum active time.";
  }
  return null;
}

export function statusAfterTimeLimit(
  status: GoalStatus,
  activeSeconds: number,
  maximumActiveSeconds: number | null,
): GoalStatus {
  if (
    status === "active" &&
    maximumActiveSeconds !== null &&
    activeSeconds >= maximumActiveSeconds
  ) {
    return "timeLimited";
  }
  return status;
}

const UNCONSTRAINED_GOAL: GoalTimeConstraints = {
  minimumActiveSeconds: null,
  maximumActiveSeconds: null,
};

export function createThreadGoal(
  objective: string,
  constraints: GoalTimeConstraints = UNCONSTRAINED_GOAL,
  now = unixSeconds(),
): ThreadGoal {
  return {
    goalId: randomUUID(),
    objective: objective.trim(),
    status: "active",
    minimumActiveSeconds: constraints.minimumActiveSeconds,
    maximumActiveSeconds: constraints.maximumActiveSeconds,
    usage: {
      tokensUsed: 0,
      activeSeconds: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function setEntry(
  goal: ThreadGoal,
  source: GoalEntrySource,
  at = unixSeconds(),
): GoalCustomEntry {
  return {
    version: 1,
    kind: "set",
    source,
    goal: cloneGoal(goal),
    at,
  };
}

export function runtimeUsageEntry(goal: ThreadGoal, at = unixSeconds()): GoalCustomEntry {
  if (!isRuntimeUsageGoalStatus(goal.status)) {
    throw new Error(`Cannot persist ${goal.status} goal as runtime usage entry.`);
  }
  return {
    version: 1,
    kind: "usage",
    source: "runtime",
    goalId: goal.goalId,
    status: goal.status,
    usage: cloneUsage(goal.usage),
    updatedAt: goal.updatedAt,
    at,
  };
}

export function clearEntry(
  clearedGoalId: string | null,
  source: GoalEntrySource,
  at = unixSeconds(),
): GoalCustomEntry {
  return {
    version: 1,
    kind: "clear",
    source,
    clearedGoalId,
    at,
  };
}

export function hostOverflowCapResetEntry(active: boolean, at = unixSeconds()): GoalCustomEntry {
  return {
    version: 1,
    kind: "host_overflow_cap_reset",
    active,
    at,
  };
}

export function isGoalCustomEntry(data: unknown): data is GoalCustomEntry {
  if (!data || typeof data !== "object") {
    return false;
  }
  const entry = data as GoalCustomEntry;
  if (entry.version !== 1 || typeof entry.at !== "number") {
    return false;
  }
  if (entry.kind === "clear") {
    return entry.clearedGoalId === null || typeof entry.clearedGoalId === "string";
  }
  if (entry.kind === "usage") {
    return (
      entry.source === "runtime" &&
      typeof entry.goalId === "string" &&
      isRuntimeUsageGoalStatus(entry.status) &&
      isGoalUsage(entry.usage) &&
      typeof entry.updatedAt === "number"
    );
  }
  if (entry.kind === "host_overflow_cap_reset") {
    return typeof entry.active === "boolean";
  }
  return entry.kind === "set" && isThreadGoal(entry.goal);
}

export function isGoalUsage(usage: unknown): usage is GoalUsage {
  if (!usage || typeof usage !== "object") {
    return false;
  }
  const candidate = usage as GoalUsage;
  return typeof candidate.tokensUsed === "number" && typeof candidate.activeSeconds === "number";
}

export function isRuntimeUsageGoalStatus(status: unknown): status is RuntimeUsageGoalStatus {
  return status === "active" || status === "timeLimited";
}

export function isThreadGoal(goal: unknown): goal is ThreadGoal {
  if (!goal || typeof goal !== "object") {
    return false;
  }
  const candidate = goal as ThreadGoal;
  return (
    typeof candidate.goalId === "string" &&
    typeof candidate.objective === "string" &&
    isGoalStatus(candidate.status) &&
    (candidate.minimumActiveSeconds === null ||
      typeof candidate.minimumActiveSeconds === "number") &&
    (candidate.maximumActiveSeconds === null ||
      typeof candidate.maximumActiveSeconds === "number") &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number" &&
    isGoalUsage(candidate.usage)
  );
}

export function isGoalStatus(status: unknown): status is GoalStatus {
  return (
    status === "active" ||
    status === "paused" ||
    status === "blocked" ||
    status === "timeLimited" ||
    status === "complete"
  );
}

function normalizeLegacyStoredGoal(value: unknown): ThreadGoal | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.minimumActiveSeconds !== undefined ||
    candidate.maximumActiveSeconds !== undefined ||
    typeof candidate.goalId !== "string" ||
    typeof candidate.objective !== "string" ||
    (candidate.status !== "active" &&
      candidate.status !== "paused" &&
      candidate.status !== "budgetLimited" &&
      candidate.status !== "complete") ||
    typeof candidate.createdAt !== "number" ||
    typeof candidate.updatedAt !== "number" ||
    !isGoalUsage(candidate.usage)
  ) {
    return null;
  }

  return {
    goalId: candidate.goalId,
    objective: candidate.objective,
    status: candidate.status === "budgetLimited" ? "paused" : candidate.status,
    minimumActiveSeconds: null,
    maximumActiveSeconds: null,
    usage: cloneUsage(candidate.usage),
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

function legacySetEntryGoal(data: unknown): ThreadGoal | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const candidate = data as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.kind !== "set" || typeof candidate.at !== "number") {
    return null;
  }
  return normalizeLegacyStoredGoal(candidate.goal);
}

function applyLegacyBudgetLimitedUsage(goal: ThreadGoal | null, data: unknown): ThreadGoal | null {
  if (!goal || !data || typeof data !== "object") {
    return goal;
  }
  const candidate = data as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    candidate.kind !== "usage" ||
    candidate.source !== "runtime" ||
    candidate.status !== "budgetLimited" ||
    candidate.goalId !== goal.goalId ||
    typeof candidate.updatedAt !== "number" ||
    candidate.updatedAt < goal.updatedAt ||
    !isGoalUsage(candidate.usage) ||
    candidate.usage.tokensUsed < goal.usage.tokensUsed ||
    candidate.usage.activeSeconds < goal.usage.activeSeconds ||
    (goal.status !== "active" && goal.status !== "paused")
  ) {
    return goal;
  }

  const migrated = cloneGoal(goal);
  migrated.status = "paused";
  migrated.usage = cloneUsage(candidate.usage);
  migrated.updatedAt = candidate.updatedAt;
  return migrated;
}

function canApplyRuntimeUsageEntry(
  goal: ThreadGoal | null,
  entry: Extract<GoalCustomEntry, { kind: "usage" }>,
): goal is ThreadGoal {
  if (!goal || goal.goalId !== entry.goalId) {
    return false;
  }
  if (!isRuntimeUsageGoalStatus(goal.status)) {
    return false;
  }
  if (goal.status === "timeLimited" && entry.status === "active") {
    return false;
  }
  return (
    entry.updatedAt >= goal.updatedAt &&
    entry.usage.tokensUsed >= goal.usage.tokensUsed &&
    entry.usage.activeSeconds >= goal.usage.activeSeconds
  );
}

export function reconstructGoal(entries: Iterable<SessionEntryLike>): GoalSnapshot {
  let goal: ThreadGoal | null = null;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      const legacyGoal = legacySetEntryGoal(entry.data);
      if (legacyGoal !== null) {
        goal = legacyGoal;
      } else {
        goal = applyLegacyBudgetLimitedUsage(goal, entry.data);
      }
      continue;
    }
    if (entry.data.kind === "clear") {
      goal = null;
    } else if (entry.data.kind === "set") {
      goal = cloneGoal(entry.data.goal);
    } else if (entry.data.kind === "usage") {
      if (!canApplyRuntimeUsageEntry(goal, entry.data)) {
        continue;
      }
      goal = cloneGoal(goal);
      goal.status = entry.data.status;
      goal.usage = cloneUsage(entry.data.usage);
      goal.updatedAt = entry.data.updatedAt;
    }
  }

  return {
    goal,
    hasGoal: goal !== null,
  };
}

export function reconstructHostOverflowCapNeedsUserReset(
  entries: Iterable<SessionEntryLike>,
): boolean {
  let needsReset = false;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      continue;
    }
    if (entry.data.kind === "host_overflow_cap_reset") {
      needsReset = entry.data.active;
    }
  }

  return needsReset;
}

export function createGoal(
  current: ThreadGoal | null,
  objective: string,
  constraints: GoalTimeConstraints = UNCONSTRAINED_GOAL,
): GoalResult {
  if (current && current.status !== "complete") {
    return {
      ok: false,
      message:
        "cannot create a new goal because this thread already has a non-complete goal; use update_goal to mark it complete or /goal to replace it",
      goal: current,
    };
  }

  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const constraintsError = validateGoalTimeConstraints(constraints);
  if (constraintsError) {
    return { ok: false, message: constraintsError, goal: null };
  }

  const goal = createThreadGoal(objective, constraints, unixSeconds());
  return {
    ok: true,
    message: "Goal created.",
    goal,
  };
}

export function replaceGoal(
  objective: string,
  constraints: GoalTimeConstraints = UNCONSTRAINED_GOAL,
): GoalResult {
  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const constraintsError = validateGoalTimeConstraints(constraints);
  if (constraintsError) {
    return { ok: false, message: constraintsError, goal: null };
  }

  const goal = createThreadGoal(objective, constraints, unixSeconds());
  return {
    ok: true,
    message: "Goal set.",
    goal,
  };
}

export function adjustGoal(current: ThreadGoal | null, objective: string): GoalResult {
  if (!current) {
    return { ok: false, message: "No goal exists to adjust.", goal: null };
  }
  if (current.status === "complete" || current.status === "timeLimited") {
    return {
      ok: false,
      message: "Completed and time-limited goals cannot be adjusted; use /goal to replace them.",
      goal: current,
    };
  }
  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: current };
  }
  const normalizedObjective = objective.trim();
  if (current.objective === normalizedObjective) {
    return { ok: true, message: "Goal unchanged.", goal: current };
  }

  const goal = cloneGoal(current);
  goal.objective = normalizedObjective;
  goal.updatedAt = unixSeconds();
  return { ok: true, message: "Goal adjusted.", goal };
}

export function updateGoalStatus(current: ThreadGoal | null, status: GoalStatus): GoalResult {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  if (current.status === "complete") {
    if (status === "complete") {
      return {
        ok: true,
        message: "Goal already complete.",
        goal: current,
      };
    }
    return {
      ok: false,
      message: "Completed goals are terminal; use /goal to replace them.",
      goal: current,
    };
  }

  if (status === "complete") {
    if (
      current.minimumActiveSeconds !== null &&
      current.usage.activeSeconds < current.minimumActiveSeconds
    ) {
      const remaining = current.minimumActiveSeconds - current.usage.activeSeconds;
      return {
        ok: false,
        message: `Goal requires ${remaining} more active second${remaining === 1 ? "" : "s"} before completion.`,
        goal: current,
      };
    }
    const goal = cloneGoal(current);
    goal.status = "complete";
    goal.updatedAt = unixSeconds();
    return {
      ok: true,
      message: "Goal marked complete.",
      goal,
    };
  }

  if (status === "blocked") {
    if (current.status === "blocked") {
      return { ok: true, message: "Goal already blocked.", goal: current };
    }
    if (current.status !== "active") {
      return {
        ok: false,
        message: "Only active goals can be marked blocked.",
        goal: current,
      };
    }
    const goal = cloneGoal(current);
    goal.status = "blocked";
    goal.updatedAt = unixSeconds();
    return { ok: true, message: "Goal marked blocked.", goal };
  }

  if (status === "paused" && current.status !== "active") {
    return {
      ok: false,
      message: "Only active goals can be paused.",
      goal: current,
    };
  }

  if (status === "active" && current.status !== "paused" && current.status !== "blocked") {
    return {
      ok: false,
      message: "Only paused or blocked goals can be resumed.",
      goal: current,
    };
  }

  const goal = cloneGoal(current);
  if (current.status === "timeLimited" && (status === "active" || status === "paused")) {
    goal.status = "timeLimited";
  } else {
    goal.status = statusAfterTimeLimit(status, goal.usage.activeSeconds, goal.maximumActiveSeconds);
  }
  goal.updatedAt = unixSeconds();

  return {
    ok: true,
    message: `Goal marked ${goal.status}.`,
    goal,
  };
}

export function applyUsage(
  current: ThreadGoal | null,
  tokensDelta: number,
  activeSecondsDelta: number,
  options: ApplyUsageOptions = {},
): { goal: ThreadGoal | null; changed: boolean; crossedTimeLimit: boolean } {
  if (!current) {
    return { goal: current, changed: false, crossedTimeLimit: false };
  }

  if (
    options.expectedGoalId !== undefined &&
    options.expectedGoalId !== null &&
    current.goalId !== options.expectedGoalId
  ) {
    return { goal: current, changed: false, crossedTimeLimit: false };
  }

  const canAccount =
    current.status === "active" ||
    (options.accountTimeLimited === true && current.status === "timeLimited");
  if (!canAccount) {
    return { goal: current, changed: false, crossedTimeLimit: false };
  }

  const tokens = Math.max(0, Math.trunc(tokensDelta));
  const seconds = Math.max(0, Math.trunc(activeSecondsDelta));
  if (tokens === 0 && seconds === 0) {
    return { goal: current, changed: false, crossedTimeLimit: false };
  }

  const goal = cloneGoal(current);
  const wasUnderTimeLimit =
    goal.maximumActiveSeconds === null || goal.usage.activeSeconds < goal.maximumActiveSeconds;
  goal.usage.tokensUsed += tokens;
  goal.usage.activeSeconds += seconds;
  goal.status = statusAfterTimeLimit(
    goal.status,
    goal.usage.activeSeconds,
    goal.maximumActiveSeconds,
  );
  goal.updatedAt = unixSeconds();

  const crossedTimeLimit =
    current.status === "active" &&
    wasUnderTimeLimit &&
    goal.maximumActiveSeconds !== null &&
    goal.usage.activeSeconds >= goal.maximumActiveSeconds;

  return { goal, changed: true, crossedTimeLimit };
}

export function goalWithLiveUsage(
  current: ThreadGoal | null,
  activeGoalId: string | null,
  lastAccountedAt: number | null,
  now = Date.now(),
): ThreadGoal | null {
  if (
    !current ||
    current.status !== "active" ||
    activeGoalId !== current.goalId ||
    lastAccountedAt === null
  ) {
    return current;
  }

  const liveSeconds = Math.max(0, Math.floor((now - lastAccountedAt) / 1000));
  if (liveSeconds === 0) {
    return current;
  }

  const goal = cloneGoal(current);
  goal.usage.activeSeconds += liveSeconds;
  return goal;
}
