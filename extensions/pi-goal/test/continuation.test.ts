import assert from "node:assert/strict";
import { test, vi } from "vitest";

import { formatFooterStatus } from "../src/format.js";
import { isGoalCustomEntry, setEntry } from "../src/state.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";
import {
  assistantMessage,
  createRuntimeHarness,
  emitPersistentAssistantError,
  fireProviderLimitAutoResume,
  flushContinuationScheduler,
  queuedCustomMessage,
  sessionCompactEvent,
  sessionShutdownEvent,
} from "./support/runtime-harness.js";

test("aborted turns pause goals and do not queue continuation", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", {
      input: 40,
      output: 2,
      cacheRead: 500,
      cacheWrite: 600,
      totalTokens: 1_142,
    }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "paused");
  assert.equal(goal?.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 0);
});

test("a new user-driven agent start leaves a paused goal paused", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", { input: 8, output: 2 }),
    toolResults: [],
  });

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "continue",
    systemPrompt: "",
    systemPromptOptions: {},
  });

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 10);
});

test("session resume at maximum time keeps a paused goal timeLimited without follow-up turn", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it", maximum_time_minutes: 1 });
  await harness.runCommand("pause");
  const paused = harness.snapshot().goal;
  assert.ok(paused);
  assert.equal(paused.status, "paused");

  harness.entries.push({
    type: "custom",
    id: "entry-over-budget-paused",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType: CUSTOM_ENTRY_TYPE,
    data: setEntry(
      {
        ...paused,
        usage: { tokensUsed: 0, activeSeconds: 60 },
      },
      "runtime",
    ),
  });
  harness.sentUserMessages.length = 0;

  await harness.emit("session_start", { type: "session_start", reason: "resume" });

  assert.equal(harness.snapshot().goal?.status, "timeLimited");
  assert.equal(harness.sentUserMessages.length, 0);
});

test("session resume prompt can reactivate a paused goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", { input: 8, output: 2 }),
    toolResults: [],
  });
  harness.sentMessages.length = 0;

  await harness.emit("session_start", { type: "session_start", reason: "resume" });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  const sentUserMessage = harness.sentUserMessages[0];
  assert.ok(sentUserMessage);
  assert.deepEqual(sentUserMessage.options, { deliverAs: "followUp" });
  const content = sentUserMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected session resume to send a user continuation prompt.");
  }
  assert.match(content, /<untrusted_objective>[\s\S]*ship it[\s\S]*<\/untrusted_objective>/);
  assert.match(content, /<pi_goal_continuation goal_id="/);
});

test("blocked goals remain stopped across session reload until explicit resume", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runTool("update_goal", { status: "blocked" });
  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;

  await harness.reloadSession("reload");
  assert.equal(harness.snapshot().goal?.status, "blocked");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 0);

  await harness.runCommand("resume");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length + harness.sentUserMessages.length, 1);
});

test("completed turns count input plus output and continue active goals", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = queuedCustomMessage(queued);
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("stop", {
      input: 30,
      output: 12,
      cacheRead: 500,
      cacheWrite: 600,
      totalTokens: 1_142,
    }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(goal?.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0]?.message.customType, CUSTOM_ENTRY_TYPE);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal?.goalId,
  });
});

test("tool-use turn ends do not queue continuation before tool execution finishes", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("toolUse", { input: 10, output: 3 }),
    toolResults: [],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("successful maximum-time crossing clears stale recovery footer attention", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "ship it", maximum_time_minutes: 1 });
    harness.sentMessages.length = 0;
    harness.footerStatuses.length = 0;

    await emitPersistentAssistantError(harness, 0, "websocket closed");
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
    now += 60_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("stop", { input: 8, output: 3 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "timeLimited");
    assert.equal(goal?.usage.tokensUsed, 13);
    assert.equal(goal?.usage.activeSeconds, 60);
    assert.equal(harness.footerStatuses.at(-1), formatFooterStatus(goal));
    assert.match(harness.footerStatuses.at(-1) ?? "", /maximum active time/);
    assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  } finally {
    Date.now = originalNow;
  }
});

test("maximum-time crossing sends one hidden time-limit steering message", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "ship it", maximum_time_minutes: 1 });

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    now += 60_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("toolUse", { input: 8, output: 3 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "timeLimited");
    assert.equal(goal?.usage.tokensUsed, 11);
    assert.equal(goal?.usage.activeSeconds, 60);
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "time_limit",
      goalId: goal?.goalId,
    });

    await harness.emit("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "tool-call",
      toolName: "bash",
      args: {},
      result: {},
      isError: false,
    });
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("replacement during an in-flight turn does not charge old tokens to the new goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("old goal");
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.runCommand("new goal");
  const replacement = harness.snapshot().goal;
  assert.equal(replacement?.objective, "new goal");

  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("stop", { input: 80, output: 20 }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.goalId, replacement?.goalId);
  assert.equal(goal?.usage.tokensUsed, 0);
  assert.equal(harness.sentMessages.length, 1);
});

test("goal tools return goal, constraints, and usage details", async () => {
  const harness = createRuntimeHarness();
  const created = (await harness.runTool("create_goal", {
    objective: "ship it",
    maximum_time_minutes: 2,
  })) as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

  assert.equal((created.details.goal as { objective?: string }).objective, "ship it");
  assert.equal(
    (created.details.goal as { maximumActiveSeconds?: number }).maximumActiveSeconds,
    120,
  );
  assert.equal(created.details.minimumTimeRemainingSeconds, null);
  assert.equal(created.details.maximumTimeRemainingSeconds, 120);
  assert.equal(created.details.completionUsageReport, null);
  assert.deepEqual(JSON.parse(created.content[0]?.text ?? ""), {
    goal: created.details.goal,
    minimumTimeRemainingSeconds: null,
    maximumTimeRemainingSeconds: 120,
    completionUsageReport: null,
  });

  const completed = (await harness.runTool("update_goal", { status: "complete" })) as {
    details: Record<string, unknown>;
  };
  assert.equal(completed.details.completionUsageReport, null);
});

test("create_goal converts whole-minute minimum time and blocks premature completion", async () => {
  const harness = createRuntimeHarness();
  const created = (await harness.runTool("create_goal", {
    objective: "ship it carefully",
    minimum_time_minutes: 1,
    maximum_time_minutes: 2,
  })) as { details: Record<string, unknown> };

  assert.equal(
    (created.details.goal as { minimumActiveSeconds?: number }).minimumActiveSeconds,
    60,
  );
  assert.equal(
    (created.details.goal as { maximumActiveSeconds?: number }).maximumActiveSeconds,
    120,
  );
  assert.equal(created.details.minimumTimeRemainingSeconds, 60);
  assert.equal(created.details.maximumTimeRemainingSeconds, 120);
  await assert.rejects(
    harness.runTool("update_goal", { status: "complete" }),
    /requires 60 more active seconds/,
  );
});

test("agent_end, not agent_settled, drives deliberate per-run goal continuation", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedCustomMessage(queued),
  });
  harness.sentMessages.length = 0;

  await harness.emit("agent_settled", { type: "agent_settled" });
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 30, output: 12 })],
  });
  assert.equal(harness.sentMessages.length, 1);
});

test("agent end waits for idle before continuing active goals", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const harness = createRuntimeHarness({ idle: false, pendingMessages: true });
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const queuedMessage = queuedCustomMessage(queued);
    harness.sentMessages.length = 0;

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("message_start", {
      type: "message_start",
      message: queuedMessage,
    });
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("stop", { input: 30, output: 12 })],
    });

    assert.equal(harness.sentMessages.length, 0);
    harness.setIdle(true);
    harness.setPendingMessages(false);
    flushContinuationScheduler();

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    vi.useRealTimers();
  }
});

test("completing a goal cancels a scheduled continuation before it is sent", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const harness = createRuntimeHarness({ idle: false, pendingMessages: true });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("stop", { input: 30, output: 12 })],
    });
    assert.equal(harness.sentMessages.length, 0);

    await harness.runTool("update_goal", { status: "complete" });
    const completeSetEntries = harness.entries.filter((entry) => {
      return (
        entry.type === "custom" &&
        entry.customType === CUSTOM_ENTRY_TYPE &&
        isGoalCustomEntry(entry.data) &&
        entry.data.kind === "set" &&
        entry.data.goal.status === "complete"
      );
    });
    assert.equal(completeSetEntries.length, 1);
    harness.setIdle(true);
    harness.setPendingMessages(false);
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "complete");
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    vi.useRealTimers();
  }
});

test("goal follow-up guard resets when custom-message continuations start", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it" });
  harness.sentMessages.length = 0;

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 30, output: 12 })],
  });
  assert.equal(harness.sentMessages.length, 1);
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = {
    role: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    content: queued.message.content,
    display: false,
    details: queued.message.details,
    timestamp: 1,
  };
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  assert.equal(harness.abortCount, 0);
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 5, output: 6 })],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal?.goalId,
  });
});

test("auto-queued continuations use the compact prompt", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const commandStart = harness.sentMessages[0];
  assert.ok(commandStart);
  const startPrompt = String(commandStart.message.content);
  assert.match(startPrompt, /<untrusted_objective>/);

  harness.sentMessages.length = 0;
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: startPrompt,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 1, output: 1 })],
  });

  const continuation = harness.sentMessages[0];
  assert.ok(continuation);
  const content = String(continuation.message.content);
  assert.match(content, /<pi_goal_continuation goal_id="/);
  assert.match(content, /<untrusted_objective>[\s\S]*ship it[\s\S]*<\/untrusted_objective>/);
  assert.match(content, /update_goal/);
});

test("extension user continuation accepted before compaction suppresses duplicate compaction continuation", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const content = String(queued.message.content);
  harness.sentMessages.length = 0;

  const results = await harness.emit("input", {
    type: "input",
    text: content,
    source: "extension",
    streamingBehavior: "followUp",
  });

  assert.deepEqual(results, [{ action: "continue" }, { action: "continue" }]);
  await harness.emit("session_compact", sessionCompactEvent());

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("session compaction queues continuation for active goals after the compaction event unwinds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const content = String(queued.message.content);
    harness.sentMessages.length = 0;

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: content,
      systemPrompt: "",
      systemPromptOptions: {},
    });
    await harness.emit("session_compact", sessionCompactEvent());

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);

    vi.advanceTimersByTime(1);
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    vi.useRealTimers();
  }
});

test("session compaction accelerates an existing idle retry after length stops", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const harness = createRuntimeHarness({ idle: false, pendingMessages: true });
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const queuedMessage = queuedCustomMessage(queued);
    harness.sentMessages.length = 0;

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("message_start", {
      type: "message_start",
      message: queuedMessage,
    });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("length", { input: 30, output: 12 }),
      toolResults: [],
    });
    assert.equal(harness.sentMessages.length, 0);

    harness.setIdle(true);
    harness.setPendingMessages(false);
    await harness.emit("session_compact", sessionCompactEvent());

    vi.advanceTimersByTime(1);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    vi.useRealTimers();
  }
});

test("session compaction continuation is cancelled if a host retry starts before the deferred check", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const content = String(queued.message.content);
    harness.sentMessages.length = 0;

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: content,
      systemPrompt: "",
      systemPromptOptions: {},
    });
    await harness.emit("session_compact", sessionCompactEvent());
    assert.equal(harness.sentMessages.length, 0);

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "host compact-and-retry prompt",
      systemPrompt: "",
      systemPromptOptions: {},
    });
    vi.advanceTimersByTime(1);
    assert.equal(harness.sentMessages.length, 0);

    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("stop", { input: 1, output: 1 })],
    });
    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    vi.useRealTimers();
  }
});

test("repeated session_compact events before the deferred check queue at most one continuation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const content = String(queued.message.content);
    harness.sentMessages.length = 0;

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: content,
      systemPrompt: "",
      systemPromptOptions: {},
    });
    for (let index = 0; index < 3; index += 1) {
      await harness.emit(
        "session_compact",
        sessionCompactEvent({
          summary: `compact summary ${index}`,
          tokensBefore: 100 + index,
        }),
      );
    }

    vi.advanceTimersByTime(1);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    vi.useRealTimers();
  }
});

test("session shutdown cancels deferred session_compact continuations", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const content = String(queued.message.content);
    harness.sentMessages.length = 0;

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: content,
      systemPrompt: "",
      systemPromptOptions: {},
    });
    await harness.emit("session_compact", sessionCompactEvent());
    await harness.emit("session_shutdown", sessionShutdownEvent());

    vi.advanceTimersByTime(1);
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    vi.useRealTimers();
  }
});

test("provider-limit pauses schedule auto-resume", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "usage limit has been reached");

    const paused = harness.snapshot().goal;
    assert.equal(paused?.status, "paused");
    assert.match(harness.footerStatuses.at(-1) ?? "", /Auto-resume will retry in about 5 minutes/);
    assert.equal(harness.sentUserMessages.length, 0);

    fireProviderLimitAutoResume();

    const resumed = harness.snapshot().goal;
    assert.equal(resumed?.goalId, paused?.goalId);
    assert.equal(resumed?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);
    const content = harness.sentUserMessages[0]?.content;
    assert.equal(typeof content, "string");
    assert.match(String(content), /<pi_goal_continuation goal_id="/);
    assert.match(
      String(content),
      /<untrusted_objective>[\s\S]*ship it[\s\S]*<\/untrusted_objective>/,
    );
  } finally {
    vi.useRealTimers();
  }
});

test("provider-limit auto-resume retries instead of resuming while busy", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const harness = createRuntimeHarness({ idle: false, pendingMessages: true });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "usage limit has been reached");
    fireProviderLimitAutoResume();

    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentUserMessages.length, 0);
    assert.match(harness.footerStatuses.at(-1) ?? "", /Auto-resume will retry/);

    harness.setIdle(true);
    harness.setPendingMessages(false);
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);
  } finally {
    vi.useRealTimers();
  }
});

test("non-limit non-retryable pauses do not schedule auto-resume", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "invalid api key");
    fireProviderLimitAutoResume();

    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentUserMessages.length, 0);
    assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Auto-resume/);
  } finally {
    vi.useRealTimers();
  }
});

test("manual resume clears provider-limit auto-resume", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "insufficient_quota 429");
    await harness.runCommand("resume");
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);

    fireProviderLimitAutoResume();
    assert.equal(harness.sentUserMessages.length, 1);
  } finally {
    vi.useRealTimers();
  }
});

test("user input and session shutdown clear provider-limit auto-resume", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const userInputHarness = createRuntimeHarness();
    await userInputHarness.runCommand("ship it");
    userInputHarness.sentMessages.length = 0;
    await emitPersistentAssistantError(userInputHarness, 0, "available balance");
    await userInputHarness.emit("input", {
      type: "input",
      text: "I'll handle it",
      source: "user",
      streamingBehavior: "normal",
    });
    fireProviderLimitAutoResume();
    assert.equal(userInputHarness.snapshot().goal?.status, "paused");
    assert.equal(userInputHarness.sentUserMessages.length, 0);

    const shutdownHarness = createRuntimeHarness();
    await shutdownHarness.runCommand("ship it");
    shutdownHarness.sentMessages.length = 0;
    await emitPersistentAssistantError(shutdownHarness, 0, "quota exceeded");
    await shutdownHarness.emit("session_shutdown", sessionShutdownEvent());
    fireProviderLimitAutoResume();
    assert.equal(shutdownHarness.sentUserMessages.length, 0);
  } finally {
    vi.useRealTimers();
  }
});

test("a second provider-limit failure after auto-resume schedules one new retry", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "FreeUsageLimitError");
    fireProviderLimitAutoResume();
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);

    harness.sentUserMessages.length = 0;
    await emitPersistentAssistantError(harness, 1, "FreeUsageLimitError");
    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentUserMessages.length, 0);
    fireProviderLimitAutoResume();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);
  } finally {
    vi.useRealTimers();
  }
});

test("assistant error turns do not immediately queue continuation", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = queuedCustomMessage(queued);
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("error", { input: 30, output: 12 }, "websocket closed"),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(goal?.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 0);
});
