import assert from "node:assert/strict";
import { test, vi } from "vitest";

import {
  assistantMessage,
  createRuntimeHarness,
  flushContinuationScheduler,
  sessionCompactEvent,
} from "./support/runtime-harness.js";

async function emitToolUseTurnEnd(
  harness: ReturnType<typeof createRuntimeHarness>,
  turnIndex: number,
): Promise<void> {
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message: assistantMessage("toolUse", { input: 260_000, output: 2 }),
    toolResults: [],
  });
}

test("active goals never initiate compaction from tool-use turns", async () => {
  const harness = createRuntimeHarness({
    contextUsage: { tokens: 260_000, contextWindow: 272_000, percent: 95.6 },
  });
  await harness.runCommand("ship it");

  await emitToolUseTurnEnd(harness, 0);

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("post-compaction goal continuation waits for the host pending queue", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const harness = createRuntimeHarness({ idle: true, pendingMessages: true });
    await harness.runCommand("ship it");
    const initialContinuation = harness.sentMessages[0];
    assert.ok(initialContinuation);
    harness.sentMessages.length = 0;

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: String(initialContinuation.message.content),
      systemPrompt: "",
      systemPromptOptions: {},
    });
    await harness.emit("session_compact", sessionCompactEvent({ reason: "manual" }));

    vi.advanceTimersByTime(1);
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(harness.compactCalls.length, 0);

    harness.setPendingMessages(false);
    flushContinuationScheduler();

    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: harness.snapshot().goal?.goalId,
    });
    assert.equal(harness.compactCalls.length, 0);
  } finally {
    vi.useRealTimers();
  }
});
