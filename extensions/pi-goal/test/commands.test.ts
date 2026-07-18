import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  handleGoalCommand,
  type CommandHost,
  type GoalCommandContext,
  type GoalCommandPi,
} from "../src/commands.js";
import { createThreadGoal } from "../src/state.js";
import type { ThreadGoal } from "../src/types.js";

function createHarness(initialGoal: ThreadGoal | null = null) {
  let goal = initialGoal;
  const notifications: Array<{ message: string; level?: string }> = [];
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
  let confirmResult = true;
  const cwd = mkdtempSync(join(tmpdir(), "pi-goal-command-test-"));

  const pi: GoalCommandPi = {
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(content, options) {
      sentUserMessages.push({ content, options });
    },
  };

  const host: CommandHost = {
    getGoal: () => goal,
    getGoalForAdjustment: () => goal,
    getGoalStartTurnStrategy: () => "hiddenFollowUp",
    resumeGoalWithContinuation(goalId) {
      if (goal?.goalId !== goalId || (goal.status !== "paused" && goal.status !== "blocked")) {
        return { ok: false, message: "Cannot resume.", goal };
      }
      goal = { ...goal, status: "active" };
      return { ok: true, message: "Goal marked active.", goal };
    },
    setGoal(nextGoal) {
      goal = nextGoal;
    },
  };

  const ctx: GoalCommandContext = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => false,
    ui: {
      confirm: async () => confirmResult,
      notify(message, level) {
        notifications.push(level === undefined ? { message } : { message, level });
      },
      setStatus() {},
    },
  };

  return {
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
    ctx,
    host,
    notifications,
    pi,
    sentMessages,
    sentUserMessages,
    get goal() {
      return goal;
    },
    setConfirmResult(value: boolean) {
      confirmResult = value;
    },
  };
}

test("bare /goal shows status without creating a goal", async () => {
  const harness = createHarness();
  try {
    await handleGoalCommand(harness.pi, harness.host, {}, harness.ctx);
    assert.equal(harness.goal, null);
    assert.match(harness.notifications[0]?.message ?? "", /No goal is currently set/);
    assert.equal(harness.sentUserMessages.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("default /goal task renders the creation prompt with form constraints", async () => {
  const harness = createHarness();
  try {
    await handleGoalCommand(
      harness.pi,
      harness.host,
      {
        task: "Build & verify the feature",
        minimumTimeMinutes: 15,
        maximumTimeMinutes: 60,
      },
      harness.ctx,
    );

    assert.equal(harness.goal, null);
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(harness.sentUserMessages.length, 1);
    const content = harness.sentUserMessages[0]?.content;
    assert.equal(typeof content, "string");
    assert.match(String(content), /Build &amp; verify the feature/);
    assert.match(String(content), /minimum_time_minutes=15/);
    assert.match(String(content), /maximum_time_minutes=60/);
    assert.match(String(content), /replace_existing: true/);
  } finally {
    harness.cleanup();
  }
});

test("/goal -r stores the exact objective with active-time constraints", async () => {
  const harness = createHarness();
  try {
    await handleGoalCommand(
      harness.pi,
      harness.host,
      {
        raw: true,
        task: "Write this exact objective",
        minimumTimeMinutes: 2,
        maximumTimeMinutes: 8,
      },
      harness.ctx,
    );

    assert.equal(harness.goal?.objective, "Write this exact objective");
    assert.equal(harness.goal?.minimumActiveSeconds, 120);
    assert.equal(harness.goal?.maximumActiveSeconds, 480);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentUserMessages.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("expanded goal adjustment preserves identity and usage while updating wording", async () => {
  const original = createThreadGoal("original objective");
  original.usage = { tokensUsed: 25, activeSeconds: 30 };
  const harness = createHarness(original);
  try {
    await handleGoalCommand(
      harness.pi,
      harness.host,
      {
        adjustExisting: true,
        adjustedObjective: "revised objective",
      },
      harness.ctx,
    );

    assert.equal(harness.goal?.goalId, original.goalId);
    assert.equal(harness.goal?.objective, "revised objective");
    assert.deepEqual(harness.goal?.usage, { tokensUsed: 25, activeSeconds: 30 });
    assert.equal(harness.sentMessages.length, 1);
    assert.match(
      String((harness.sentMessages[0]?.message as { content?: unknown })?.content),
      /revised objective/,
    );
  } finally {
    harness.cleanup();
  }
});

test("adjusting a blocked goal preserves the blocked state without queuing work", async () => {
  const blocked = { ...createThreadGoal("blocked objective"), status: "blocked" as const };
  const harness = createHarness(blocked);
  try {
    await handleGoalCommand(
      harness.pi,
      harness.host,
      { adjustExisting: true, adjustedObjective: "clarified objective" },
      harness.ctx,
    );
    assert.equal(harness.goal?.status, "blocked");
    assert.equal(harness.goal?.objective, "clarified objective");
    assert.equal(harness.sentMessages.length, 0);

    await handleGoalCommand(harness.pi, harness.host, { task: "resume" }, harness.ctx);
    assert.equal(harness.goal?.status, "active");
  } finally {
    harness.cleanup();
  }
});

test("pause and resume are the only management task spellings", async () => {
  const harness = createHarness(createThreadGoal("ship it"));
  try {
    await handleGoalCommand(harness.pi, harness.host, { task: "pause" }, harness.ctx);
    assert.equal(harness.goal?.status, "paused");

    await handleGoalCommand(harness.pi, harness.host, { task: "resume" }, harness.ctx);
    assert.equal(harness.goal?.status, "active");

    for (const task of ["clear", "copy", "resume cancel"]) {
      harness.sentUserMessages.length = 0;
      await handleGoalCommand(harness.pi, harness.host, { task }, harness.ctx);
      assert.equal(harness.sentUserMessages.length, 1, `${task} should be a generated-goal task`);
    }
  } finally {
    harness.cleanup();
  }
});

test("raw replacement preserves an existing goal when confirmation is declined", async () => {
  const original = createThreadGoal("original objective");
  const harness = createHarness(original);
  harness.setConfirmResult(false);
  try {
    await handleGoalCommand(
      harness.pi,
      harness.host,
      { raw: true, task: "replacement objective" },
      harness.ctx,
    );
    assert.equal(harness.goal?.goalId, original.goalId);
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(harness.notifications.at(-1)?.message, "Goal unchanged.");
  } finally {
    harness.cleanup();
  }
});

test("time constraints are rejected for management commands and empty tasks", async () => {
  const harness = createHarness(createThreadGoal("ship it"));
  try {
    await handleGoalCommand(
      harness.pi,
      harness.host,
      { task: "pause", minimumTimeMinutes: 5 },
      harness.ctx,
    );
    assert.equal(harness.goal?.status, "active");
    assert.match(harness.notifications.at(-1)?.message ?? "", /only when creating/);

    await handleGoalCommand(harness.pi, harness.host, { maximumTimeMinutes: 10 }, harness.ctx);
    assert.match(harness.notifications.at(-1)?.message ?? "", /task or raw objective is required/i);
  } finally {
    harness.cleanup();
  }
});
