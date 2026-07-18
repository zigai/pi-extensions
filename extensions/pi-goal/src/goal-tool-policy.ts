import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ThreadGoal } from "./types.js";

const REQUIRED_ACTIVE_GOAL_TOOLS = new Set(["get_goal", "update_goal"]);
const MAX_DISABLED_TOOLS = 128;

type ToolPolicyHost = Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "setActiveTools">;

export interface ActiveGoalToolPolicy {
  disabledTools: readonly string[];
}

interface AppliedToolPolicy {
  key: string;
  baseline: Map<string, boolean | undefined>;
  disabledTools: readonly string[];
}

export interface GoalToolPolicyController {
  configure(policy: ActiveGoalToolPolicy): void;
  release(): void;
  sync(goal: ThreadGoal | null): void;
}

export function isRequiredActiveGoalTool(name: string): boolean {
  return REQUIRED_ACTIVE_GOAL_TOOLS.has(name);
}

export function normalizeActiveGoalToolPolicy(
  disabledTools: readonly string[],
): ActiveGoalToolPolicy {
  const normalized = new Set<string>();
  for (const name of disabledTools) {
    const trimmed = name.trim();
    if (trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }
  return {
    disabledTools: [...normalized].sort((left, right) => left.localeCompare(right)),
  };
}

export function validateActiveGoalToolPolicy(disabledTools: readonly string[]): string | null {
  if (disabledTools.length > MAX_DISABLED_TOOLS) {
    return `disabledToolsWhileGoalActive may contain at most ${MAX_DISABLED_TOOLS} tool names.`;
  }
  for (const name of disabledTools) {
    if (name.trim().length === 0) {
      return "disabledToolsWhileGoalActive must not contain empty tool names.";
    }
  }
  const required =
    normalizeActiveGoalToolPolicy(disabledTools).disabledTools.find(isRequiredActiveGoalTool);
  if (required !== undefined) {
    return `${required} must remain available while a goal is active.`;
  }
  return null;
}

function policyKey(goal: ThreadGoal, policy: ActiveGoalToolPolicy): string {
  return [goal.goalId, ...policy.disabledTools].join("\u0000");
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((name) => right.has(name));
}

export function createGoalToolPolicyController(host: ToolPolicyHost): GoalToolPolicyController {
  let configured = normalizeActiveGoalToolPolicy([]);
  let applied: AppliedToolPolicy | null = null;

  const setActiveToolsIfChanged = (
    currentNames: readonly string[],
    next: ReadonlySet<string>,
  ): void => {
    if (setsEqual(new Set(currentNames), next)) {
      return;
    }
    const ordered = currentNames.filter((name) => next.has(name));
    for (const name of next) {
      if (!ordered.includes(name)) {
        ordered.push(name);
      }
    }
    host.setActiveTools(ordered);
  };

  const release = (): void => {
    if (applied === null) {
      return;
    }
    const currentNames = host.getActiveTools();
    const next = new Set(currentNames);
    const available = new Set(host.getAllTools().map((tool) => tool.name));
    for (const [name, wasActive] of applied.baseline) {
      if (wasActive === undefined || !available.has(name)) {
        continue;
      }
      if (wasActive) {
        next.add(name);
      } else {
        next.delete(name);
      }
    }
    applied = null;
    setActiveToolsIfChanged(currentNames, next);
  };

  const enforceAppliedPolicy = (): void => {
    if (applied === null) {
      return;
    }
    const currentNames = host.getActiveTools();
    const next = new Set(currentNames);
    const available = new Set(host.getAllTools().map((tool) => tool.name));
    for (const name of applied.disabledTools) {
      if (applied.baseline.get(name) === undefined && available.has(name)) {
        applied.baseline.set(name, next.has(name));
      }
      next.delete(name);
    }
    setActiveToolsIfChanged(currentNames, next);
  };

  const sync = (goal: ThreadGoal | null): void => {
    if (goal?.status !== "active" || configured.disabledTools.length === 0) {
      release();
      return;
    }

    const key = policyKey(goal, configured);
    if (applied?.key !== key) {
      release();
      const current = new Set(host.getActiveTools());
      const available = new Set(host.getAllTools().map((tool) => tool.name));
      const baseline = new Map<string, boolean | undefined>();
      for (const name of configured.disabledTools) {
        baseline.set(name, available.has(name) ? current.has(name) : undefined);
      }
      applied = {
        key,
        baseline,
        disabledTools: [...configured.disabledTools],
      };
    }
    enforceAppliedPolicy();
  };

  const configure = (policy: ActiveGoalToolPolicy): void => {
    const next = normalizeActiveGoalToolPolicy(policy.disabledTools);
    if (
      configured.disabledTools.length === next.disabledTools.length &&
      configured.disabledTools.every((name, index) => name === next.disabledTools[index])
    ) {
      return;
    }
    release();
    configured = next;
  };

  return { configure, release, sync };
}
