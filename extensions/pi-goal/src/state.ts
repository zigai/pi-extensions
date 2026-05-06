import { randomUUID } from "node:crypto";

import {
  CUSTOM_ENTRY_TYPE,
  MAX_OBJECTIVE_CHARS,
  type GoalCustomEntry,
  type GoalEntrySource,
  type GoalResult,
  type GoalSnapshot,
  type GoalStatus,
  type SessionEntryLike,
  type ThreadGoal,
} from "./types.js";

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function cloneGoal(goal: ThreadGoal): ThreadGoal {
  return {
    ...goal,
    usage: { ...goal.usage },
  };
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

export function validateTokenBudget(tokenBudget: number | null | undefined): string | null {
  if (tokenBudget === null || tokenBudget === undefined) {
    return null;
  }
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    return "Token budget must be a positive integer.";
  }
  return null;
}

export function createThreadGoal(objective: string, tokenBudget?: number | null, now = unixSeconds()): ThreadGoal {
  return {
    goalId: randomUUID(),
    objective: objective.trim(),
    status: "active",
    tokenBudget: tokenBudget ?? null,
    usage: {
      tokensUsed: 0,
      activeSeconds: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function setEntry(goal: ThreadGoal, source: GoalEntrySource, at = unixSeconds()): GoalCustomEntry {
  return {
    version: 1,
    kind: "set",
    source,
    goal: cloneGoal(goal),
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
  return entry.kind === "set" && isThreadGoal(entry.goal);
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
    (candidate.tokenBudget === null || typeof candidate.tokenBudget === "number") &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number" &&
    candidate.usage !== undefined &&
    typeof candidate.usage.tokensUsed === "number" &&
    typeof candidate.usage.activeSeconds === "number"
  );
}

export function isGoalStatus(status: unknown): status is GoalStatus {
  return status === "active" || status === "paused" || status === "budgetLimited" || status === "complete";
}

export function reconstructGoal(entries: Iterable<SessionEntryLike>): GoalSnapshot {
  let goal: ThreadGoal | null = null;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      continue;
    }
    if (entry.data.kind === "clear") {
      goal = null;
    } else {
      goal = cloneGoal(entry.data.goal);
    }
  }

  return {
    goal,
    hasGoal: goal !== null,
  };
}

export function createGoal(current: ThreadGoal | null, objective: string, tokenBudget?: number | null): GoalResult {
  if (current) {
    return {
      ok: false,
      message: "A goal already exists. Clear it before creating another goal.",
      goal: current,
    };
  }

  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, message: budgetError, goal: null };
  }

  const goal = createThreadGoal(objective, tokenBudget);
  return {
    ok: true,
    message: "Goal created.",
    goal,
  };
}

export function replaceGoal(objective: string, tokenBudget?: number | null): GoalResult {
  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, message: budgetError, goal: null };
  }

  const goal = createThreadGoal(objective, tokenBudget);
  return {
    ok: true,
    message: "Goal set.",
    goal,
  };
}

export function updateGoalStatus(current: ThreadGoal | null, status: GoalStatus): GoalResult {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  const goal = cloneGoal(current);
  goal.status = status;
  goal.updatedAt = unixSeconds();

  return {
    ok: true,
    message: `Goal marked ${status}.`,
    goal,
  };
}

export function applyUsage(
  current: ThreadGoal | null,
  tokensDelta: number,
  activeSecondsDelta: number,
): { goal: ThreadGoal | null; changed: boolean; crossedBudget: boolean } {
  if (!current || current.status !== "active") {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const tokens = Math.max(0, Math.trunc(tokensDelta));
  const seconds = Math.max(0, Math.trunc(activeSecondsDelta));
  if (tokens === 0 && seconds === 0) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const goal = cloneGoal(current);
  const wasUnderBudget = goal.tokenBudget === null || goal.usage.tokensUsed < goal.tokenBudget;
  goal.usage.tokensUsed += tokens;
  goal.usage.activeSeconds += seconds;
  goal.updatedAt = unixSeconds();

  let crossedBudget = false;
  if (goal.tokenBudget !== null && goal.usage.tokensUsed >= goal.tokenBudget) {
    goal.status = "budgetLimited";
    crossedBudget = wasUnderBudget;
  }

  return { goal, changed: true, crossedBudget };
}

export function goalWithLiveUsage(
  current: ThreadGoal | null,
  activeGoalId: string | null,
  lastAccountedAt: number | null,
  now = Date.now(),
): ThreadGoal | null {
  if (!current || current.status !== "active" || activeGoalId !== current.goalId || lastAccountedAt === null) {
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
