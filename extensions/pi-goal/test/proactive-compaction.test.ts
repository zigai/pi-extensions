import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { proactiveCompactionDue } from "../src/proactive-compaction.js";
import { PROACTIVE_COMPACTION_RESERVE_TOKENS } from "../src/runtime-config.js";
import {
  assistantMessage,
  createRuntimeHarness,
  flushContinuationScheduler,
  queuedCustomMessage,
  sessionCompactEvent,
} from "./support/runtime-harness.js";

const CONTEXT_WINDOW = 272_000;
const OVER_THRESHOLD = CONTEXT_WINDOW - PROACTIVE_COMPACTION_RESERVE_TOKENS + 1;
const UNDER_THRESHOLD = CONTEXT_WINDOW - PROACTIVE_COMPACTION_RESERVE_TOKENS - 1;

function contextUsage(tokens: number | null, window = CONTEXT_WINDOW) {
  return {
    tokens,
    contextWindow: window,
    percent: tokens === null ? null : (tokens / window) * 100,
  };
}

async function emitToolUseTurnEnd(
  harness: ReturnType<typeof createRuntimeHarness>,
  turnIndex: number,
): Promise<void> {
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message: assistantMessage("toolUse", { input: 10, output: 2 }),
    toolResults: [],
  });
}

test("proactiveCompactionDue requires known usage and meaningful window", () => {
  assert.equal(proactiveCompactionDue(undefined, 50_000), false);
  assert.equal(proactiveCompactionDue(contextUsage(null), 50_000), false);
  assert.equal(proactiveCompactionDue(contextUsage(40_000, 50_000), 50_000), false);
  assert.equal(proactiveCompactionDue(contextUsage(UNDER_THRESHOLD), 50_000), false);
  assert.equal(proactiveCompactionDue(contextUsage(OVER_THRESHOLD), 50_000), true);
});

test("tool-use turn_end above the reserve threshold triggers compaction for active goals", async () => {
  const harness = createRuntimeHarness({
    contextUsage: contextUsage(OVER_THRESHOLD),
    compactCompletion: "manual",
  });
  await harness.runCommand("ship it");

  await emitToolUseTurnEnd(harness, 0);

  assert.equal(harness.compactCalls.length, 1);
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("tool-use turn_end below the reserve threshold does not trigger compaction", async () => {
  const harness = createRuntimeHarness({ contextUsage: contextUsage(UNDER_THRESHOLD) });
  await harness.runCommand("ship it");

  await emitToolUseTurnEnd(harness, 0);

  assert.equal(harness.compactCalls.length, 0);
});

test("turn_end above the threshold without an active goal does not trigger compaction", async () => {
  const harness = createRuntimeHarness({ contextUsage: contextUsage(OVER_THRESHOLD) });

  await emitToolUseTurnEnd(harness, 0);

  assert.equal(harness.compactCalls.length, 0);
});

test("a pending proactive compaction is not retriggered by later turns", async () => {
  const harness = createRuntimeHarness({
    contextUsage: contextUsage(OVER_THRESHOLD),
    compactCompletion: "manual",
  });
  await harness.runCommand("ship it");

  await emitToolUseTurnEnd(harness, 0);
  await emitToolUseTurnEnd(harness, 1);

  assert.equal(harness.compactCalls.length, 1);
});

test("abort caused by a proactive compaction does not pause the goal and continuation resumes after compact", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness({
      contextUsage: contextUsage(OVER_THRESHOLD),
      compactCompletion: "manual",
    });
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    await harness.emit("message_start", {
      type: "message_start",
      message: queuedCustomMessage(queued),
    });
    harness.sentMessages.length = 0;

    await emitToolUseTurnEnd(harness, 0);
    assert.equal(harness.compactCalls.length, 1);

    const aborted = assistantMessage("aborted", { input: 0, output: 0 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: aborted,
      toolResults: [],
    });
    await harness.emit("agent_end", { type: "agent_end", messages: [aborted] });
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);

    harness.setContextUsage(contextUsage(null));
    await harness.emit("session_compact", sessionCompactEvent({ reason: "manual" }));
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("a user abort without a pending proactive compaction still pauses the goal", async () => {
  const harness = createRuntimeHarness({ contextUsage: contextUsage(UNDER_THRESHOLD) });
  await harness.runCommand("ship it");

  const aborted = assistantMessage("aborted", { input: 0, output: 0 });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: aborted,
    toolResults: [],
  });

  assert.equal(harness.snapshot().goal?.status, "paused");
});

test("proactive compaction failure pauses the goal for user attention", async () => {
  const harness = createRuntimeHarness({
    contextUsage: contextUsage(OVER_THRESHOLD),
    compactBehavior: "error",
  });
  await harness.runCommand("ship it");

  await emitToolUseTurnEnd(harness, 0);

  assert.equal(harness.compactCalls.length, 1);
  assert.equal(harness.snapshot().goal?.status, "paused");
});
