import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { Type } from "typebox";

import type { ThreadGoal } from "./types.ts";

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
  startSession(sessionId: string): void;
  canInvoke(name: string): boolean;
  dispose(): void;
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

export function createGoalToolPolicyController(
  host: ToolPolicyHost,
  events?: EventBus,
): GoalToolPolicyController {
  let configured = normalizeActiveGoalToolPolicy(["ask_user_question"]);
  let applied: AppliedToolPolicy | null = null;
  let sessionId: string | undefined;
  let currentGoal: ThreadGoal | null = null;
  let delegated = false;

  const envelope = Compile(
    Type.Object(
      { version: Type.Literal(1), sessionId: Type.String() },
      { additionalProperties: false },
    ),
  );
  const publish = (): void => {
    if (sessionId === undefined) return;

    events?.emit("pi-toggles:register-context-key", {
      owner: "pi-goal",
      key: "goal.status",
      type: "string",
      description: "Authoritative Goal lifecycle status; absent when no goal exists.",
    });

    events?.emit("pi-toggles:set-context", {
      owner: "pi-goal",
      key: "goal.status",
      value: currentGoal?.status ?? "absent",
    });

    events?.emit("pi-goal:tool-policy", {
      version: 1,
      sessionId,
      status: currentGoal?.status ?? "absent",
      disabledTools: configured.disabledTools,
    });
  };

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

  const restoreLocal = (): void => {
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
    currentGoal = goal;
    publish();

    if (delegated || goal?.status !== "active" || configured.disabledTools.length === 0) {
      restoreLocal();
      return;
    }

    const key = policyKey(goal, configured);
    if (applied?.key !== key) {
      restoreLocal();

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
    const next = normalizeActiveGoalToolPolicy(["ask_user_question", ...policy.disabledTools]);
    if (
      configured.disabledTools.length === next.disabledTools.length &&
      configured.disabledTools.every((name, index) => name === next.disabledTools[index])
    ) {
      return;
    }

    restoreLocal();
    configured = next;
  };

  const unsubscribers = [
    events?.on("pi-toggles:context-ready", (value) => {
      if (!envelope.Check(value)) return;

      const ready = envelope.Parse(value);
      if (ready.sessionId === sessionId) publish();
    }),
    events?.on("pi-goal:tool-policy-accepted", (value) => {
      if (!envelope.Check(value)) return;

      const accepted = envelope.Parse(value);
      if (accepted.sessionId !== sessionId) return;

      restoreLocal();
      delegated = true;
    }),
    events?.on("pi-goal:tool-policy-released", (value) => {
      if (!envelope.Check(value)) return;

      const released = envelope.Parse(value);
      if (released.sessionId !== sessionId) return;

      delegated = false;
      sync(currentGoal);
    }),
  ];

  const release = (): void => {
    currentGoal = null;
    publish();
    restoreLocal();
  };

  return {
    configure,
    release,
    sync,
    startSession(nextSessionId) {
      restoreLocal();
      sessionId = nextSessionId;
      delegated = false;
      currentGoal = null;
      publish();
    },
    canInvoke: (name) =>
      currentGoal?.status !== "active" || !configured.disabledTools.includes(name),
    dispose() {
      release();
      events?.emit("pi-toggles:clear-context", { owner: "pi-goal" });

      for (const unsubscribe of unsubscribers) unsubscribe?.();
    },
  };
}
