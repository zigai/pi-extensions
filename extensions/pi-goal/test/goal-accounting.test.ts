import assert from "node:assert/strict";
import { test } from "vitest";

import {
  assistantMessage,
  createRuntimeHarness,
  type RuntimeHarness,
} from "./support/runtime-harness.ts";

async function emitCompletion(harness: RuntimeHarness, nested: boolean): Promise<void> {
  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: nested ? "outer/1/1" : "outer",
    parentToolCallId: nested ? "outer/1" : undefined,
    toolName: "bash",
    args: {},
    result: {},
    isError: false,
  });
}

async function endTurn(harness: RuntimeHarness): Promise<void> {
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("toolUse", { input: 10, output: 2 }),
    toolResults: [],
  });
}

test.each([false, true])(
  "subsecond completions preserve the same active time as one interval (nested=%s)",
  async (nested) => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    const repeated = createRuntimeHarness();
    const interval = createRuntimeHarness();
    try {
      await repeated.runCommand("ship it");
      await interval.runCommand("ship it");

      for (const harness of [repeated, interval]) {
        await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
      }

      for (const elapsed of [250, 500, 750, 1_000, 1_250, 1_500, 1_750, 2_000, 2_250, 2_500]) {
        now = 1_000 + elapsed;
        await emitCompletion(repeated, nested);
      }

      await emitCompletion(interval, false);
      now = 3_750;
      await endTurn(repeated);
      await endTurn(interval);
      assert.deepEqual(repeated.snapshot().goal?.usage, { tokensUsed: 12, activeSeconds: 2 });
      assert.deepEqual(repeated.snapshot().goal?.usage, interval.snapshot().goal?.usage);
      now = 4_000;

      for (const harness of [repeated, interval]) {
        await harness.emit("agent_end", { type: "agent_end", messages: [] });
      }

      assert.deepEqual(repeated.snapshot().goal?.usage, { tokensUsed: 12, activeSeconds: 3 });
      assert.deepEqual(repeated.snapshot().goal?.usage, interval.snapshot().goal?.usage);
    } finally {
      try {
        await repeated.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
        await interval.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
      } finally {
        Date.now = originalNow;
      }
    }
  },
);

test("subsecond nested completions reach the time limit once at the same boundary as one interval", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  const repeated = createRuntimeHarness();
  const interval = createRuntimeHarness();
  try {
    for (const harness of [repeated, interval]) {
      await harness.runTool("create_goal", { objective: "ship it", maximum_time_minutes: 1 });
      await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    }

    now = 60_000;
    await emitCompletion(repeated, false);

    for (const elapsed of [250, 500, 750]) {
      now = 60_000 + elapsed;
      await emitCompletion(repeated, true);
      assert.equal(repeated.sentMessages.length, 0);
    }

    now = 61_000;
    await emitCompletion(repeated, true);
    await emitCompletion(interval, false);
    assert.equal(repeated.snapshot().goal?.status, "timeLimited");
    assert.deepEqual(repeated.snapshot().goal?.usage, { tokensUsed: 0, activeSeconds: 60 });
    assert.deepEqual(repeated.snapshot().goal?.usage, interval.snapshot().goal?.usage);
    assert.equal(repeated.sentMessages.length, 1);
    assert.equal(interval.sentMessages.length, 1);
    const warning = repeated.sentMessages[0];
    assert.ok(warning);
    assert.deepEqual(warning.message.details, {
      kind: "time_limit",
      goalId: repeated.snapshot().goal?.goalId,
    });
    assert.deepEqual(warning.options, { triggerTurn: true, deliverAs: "steer" });
    now = 81_000;
    await emitCompletion(repeated, true);
    await endTurn(repeated);
    assert.deepEqual(repeated.snapshot().goal?.usage, { tokensUsed: 0, activeSeconds: 60 });
    assert.equal(repeated.sentMessages.length, 1);
  } finally {
    try {
      await repeated.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
      await interval.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    } finally {
      Date.now = originalNow;
    }
  }
});

test.each(["pause", "replace", "reload"])(
  "%s starts a fresh accounting interval without inheriting residual or inactive time",
  async (transition) => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    const harness = createRuntimeHarness();
    try {
      await harness.runCommand("ship it");
      await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
      now = 1_750;
      await endTurn(harness);
      assert.deepEqual(harness.snapshot().goal?.usage, { tokensUsed: 12, activeSeconds: 0 });

      if (transition === "pause") {
        await harness.runCommand("pause");
        now = 21_000;
        await harness.runCommand("resume");
      } else if (transition === "replace") {
        now = 21_000;
        await harness.runTool("create_goal", { objective: "replacement", replace_existing: true });
      } else {
        await harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
        now = 21_000;
        harness.reloadExtension();
        await harness.emit("session_tree", { type: "session_tree" });
      }

      await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 2 });
      now = 21_250;
      await emitCompletion(harness, true);
      await endTurn(harness);
      assert.equal(harness.snapshot().goal?.usage.activeSeconds, 0);

      for (const elapsed of [500, 750, 1_000]) {
        now = 21_000 + elapsed;
        await emitCompletion(harness, true);
      }

      await endTurn(harness);
      assert.equal(harness.snapshot().goal?.usage.activeSeconds, 1);
    } finally {
      try {
        await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
      } finally {
        Date.now = originalNow;
      }
    }
  },
);
