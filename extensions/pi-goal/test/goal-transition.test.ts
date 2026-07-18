import assert from "node:assert/strict";
import { test } from "vitest";

import {
  applyGoalTransitionEffects,
  planGoalTransition,
  reloadGoalRuntimeEffects,
  type GoalTransitionEffect,
  type GoalTransitionEffectHandlers,
} from "../src/goal-transition.js";
import { createThreadGoal } from "../src/state.js";
import type { GoalStatus, GoalTimeConstraints, ThreadGoal } from "../src/types.js";

const limits: GoalTimeConstraints = {
  minimumActiveSeconds: 5,
  maximumActiveSeconds: 10,
};

function effectTypes(effects: readonly GoalTransitionEffect[]): string[] {
  return effects.map((effect) => effect.type);
}

function goal(objective = "ship it"): ThreadGoal {
  return createThreadGoal(objective, limits, 100);
}

test("reload clears continuation and inactive accounting", () => {
  const active = goal();
  assert.deepEqual(effectTypes(reloadGoalRuntimeEffects(null, active)), [
    "clearContinuation",
    "resetRecovery",
  ]);
  assert.deepEqual(
    effectTypes(reloadGoalRuntimeEffects(active.goalId, { ...active, status: "paused" })),
    ["clearContinuation", "clearActiveAccounting"],
  );
});

test("setting a new command goal resets runtime state and queues continuation", () => {
  const next = goal();
  const plan = planGoalTransition(null, {
    kind: "set",
    nextGoal: next,
    source: "command",
  });
  assert.equal(plan.persist, "set");
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
    "clearTimeLimitWarning",
  ]);
  assert.deepEqual(plan.afterPersist, [{ type: "markContinuationQueued", goalId: next.goalId }]);
});

test("setting an equivalent goal skips persistence but keeps command effects", () => {
  const current = goal();
  const plan = planGoalTransition(current, {
    kind: "set",
    nextGoal: { ...current, usage: { ...current.usage } },
    source: "command",
  });
  assert.equal(plan.persist, "skip");
  assert.deepEqual(plan.beforePersist, []);
  assert.deepEqual(plan.afterPersist, [{ type: "markContinuationQueued", goalId: current.goalId }]);
});

test("clear remains an internal persistence transition", () => {
  const plan = planGoalTransition(goal(), { kind: "clear", source: "runtime" });
  assert.equal(plan.persist, "clear");
  assert.equal(plan.nextGoal, null);
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
    "clearTimeLimitWarning",
  ]);
  assert.deepEqual(effectTypes(plan.afterPersist), ["stopStatusRefresh"]);
});

test("abort pause and resume derive valid statuses without changing constraints", () => {
  const current = goal();
  const paused = planGoalTransition(current, { kind: "abort_pause" });
  assert.ok(paused.nextGoal);
  assert.equal(paused.nextGoal.status, "paused");
  assert.equal(paused.nextGoal.minimumActiveSeconds, 5);
  assert.equal(paused.nextGoal.maximumActiveSeconds, 10);
  assert.deepEqual(effectTypes(paused.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
    "clearTimeLimitWarning",
  ]);

  const resumed = planGoalTransition(paused.nextGoal, { kind: "resume_active" });
  assert.ok(resumed.nextGoal);
  assert.equal(resumed.nextGoal.status, "active");
  assert.deepEqual(effectTypes(resumed.beforePersist), [
    "clearContinuation",
    "resetRecovery",
    "clearTimeLimitWarning",
  ]);
});

test("blocked goals clear active runtime state and can resume explicitly", () => {
  const current = goal();
  const blocked = { ...current, status: "blocked" as const, updatedAt: 101 };
  const setPlan = planGoalTransition(current, {
    kind: "set",
    nextGoal: blocked,
    source: "tool",
  });
  assert.deepEqual(effectTypes(setPlan.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
    "clearTimeLimitWarning",
  ]);

  const resumed = planGoalTransition(blocked, { kind: "resume_active" });
  assert.equal(resumed.nextGoal?.status, "active");
});

test("pause and resume enforce source status invariants", () => {
  const current = goal();
  assert.throws(
    () => planGoalTransition({ ...current, status: "paused" }, { kind: "abort_pause" }),
    /current status must be active/,
  );
  assert.throws(
    () => planGoalTransition(current, { kind: "resume_active" }),
    /current status must be paused/,
  );
});

test("ordinary runtime accounting defers compact persistence", () => {
  const current = goal();
  const next = {
    ...current,
    usage: { tokensUsed: 50, activeSeconds: 4 },
    updatedAt: 101,
  };
  const plan = planGoalTransition(current, {
    kind: "runtime_accounting",
    nextGoal: next,
  });
  assert.equal(plan.persist, "defer");
  assert.deepEqual(effectTypes(plan.beforePersist), ["clearTimeLimitWarning"]);
});

test("crossing maximum active time persists the timeLimited checkpoint immediately", () => {
  const current = {
    ...goal(),
    usage: { tokensUsed: 10, activeSeconds: 9 },
  };
  const next = {
    ...current,
    status: "timeLimited" as const,
    usage: { tokensUsed: 20, activeSeconds: 10 },
    updatedAt: 101,
  };
  const plan = planGoalTransition(current, {
    kind: "runtime_accounting",
    nextGoal: next,
  });
  assert.equal(plan.persist, "set");
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
  ]);
});

test("runtime accounting accepts monotonic usage on an already timeLimited goal", () => {
  const current = {
    ...goal(),
    status: "timeLimited" as const,
    usage: { tokensUsed: 20, activeSeconds: 10 },
  };
  const next = {
    ...current,
    usage: { tokensUsed: 25, activeSeconds: 11 },
    updatedAt: 101,
  };
  const plan = planGoalTransition(current, {
    kind: "runtime_accounting",
    nextGoal: next,
  });
  assert.equal(plan.persist, "defer");
});

test("runtime accounting rejects identity, objective, constraint, and usage mutations", () => {
  const current = goal();
  const valid = {
    ...current,
    usage: { tokensUsed: 1, activeSeconds: 1 },
    updatedAt: 101,
  };
  const cases: Array<{ next: ThreadGoal; pattern: RegExp }> = [
    { next: { ...valid, goalId: "other" }, pattern: /goalId mismatch/ },
    { next: { ...valid, objective: "other" }, pattern: /objective must be unchanged/ },
    {
      next: { ...valid, maximumActiveSeconds: 20 },
      pattern: /time constraints must be unchanged/,
    },
    {
      next: { ...valid, usage: { tokensUsed: -1, activeSeconds: 1 } },
      pattern: /tokensUsed must not decrease/,
    },
    {
      next: { ...valid, usage: { tokensUsed: 1, activeSeconds: -1 } },
      pattern: /activeSeconds must not decrease/,
    },
    { next: { ...current }, pattern: /must increase usage or change status/ },
  ];
  for (const item of cases) {
    assert.throws(
      () =>
        planGoalTransition(current, {
          kind: "runtime_accounting",
          nextGoal: item.next,
        }),
      item.pattern,
    );
  }
});

test("runtime accounting validates timeLimited thresholds and statuses", () => {
  const current = goal();
  const belowLimit = {
    ...current,
    status: "timeLimited" as const,
    usage: { tokensUsed: 1, activeSeconds: 9 },
    updatedAt: 101,
  };
  assert.throws(
    () =>
      planGoalTransition(current, {
        kind: "runtime_accounting",
        nextGoal: belowLimit,
      }),
    /activeSeconds must be at or above maximumActiveSeconds/,
  );

  const limited = {
    ...current,
    status: "timeLimited" as const,
    usage: { tokensUsed: 1, activeSeconds: 10 },
    updatedAt: 101,
  };
  assert.throws(
    () =>
      planGoalTransition(limited, {
        kind: "runtime_accounting",
        nextGoal: { ...limited, status: "active", updatedAt: 102 },
      }),
    /timeLimited goals cannot transition to active/,
  );

  for (const status of ["paused", "blocked", "complete"] as const satisfies readonly GoalStatus[]) {
    assert.throws(
      () =>
        planGoalTransition(
          { ...current, status },
          {
            kind: "runtime_accounting",
            nextGoal: { ...current, status, usage: { tokensUsed: 1, activeSeconds: 1 } },
          },
        ),
      /current status must be active or timeLimited/,
    );
  }
});

test("applyGoalTransitionEffects dispatches each effect exactly once", () => {
  const calls: string[] = [];
  const handlers: GoalTransitionEffectHandlers = {
    clearContinuation: () => calls.push("clearContinuation"),
    clearActiveAccounting: () => calls.push("clearActiveAccounting"),
    resetRecovery: () => calls.push("resetRecovery"),
    clearTimeLimitWarning: () => calls.push("clearTimeLimitWarning"),
    clearHostOverflowRecovery: () => calls.push("clearHostOverflowRecovery"),
    setRecoveryPausedAttention: (reason) => calls.push(`attention:${reason}`),
    markContinuationQueued: (goalId) => calls.push(`queued:${goalId}`),
    stopStatusRefresh: () => calls.push("stopStatusRefresh"),
  };
  applyGoalTransitionEffects(
    [
      { type: "clearContinuation" },
      { type: "clearActiveAccounting" },
      { type: "resetRecovery" },
      { type: "clearTimeLimitWarning" },
      { type: "clearHostOverflowRecovery" },
      { type: "setRecoveryPausedAttention", reason: "retry" },
      { type: "markContinuationQueued", goalId: "goal" },
      { type: "stopStatusRefresh" },
    ],
    handlers,
  );
  assert.deepEqual(calls, [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
    "clearTimeLimitWarning",
    "clearHostOverflowRecovery",
    "attention:retry",
    "queued:goal",
    "stopStatusRefresh",
  ]);
});
