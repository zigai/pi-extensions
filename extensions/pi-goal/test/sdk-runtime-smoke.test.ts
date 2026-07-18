import assert from "node:assert/strict";
import { test } from "vitest";

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import goalExtension, { __testHooks } from "../src/index.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";

function goalIdFromToolResult(result: unknown): string {
  assert.ok(result && typeof result === "object");
  const details = (result as { details?: unknown }).details;
  assert.ok(details && typeof details === "object");
  const goal = (details as { goal?: unknown }).goal;
  assert.ok(goal && typeof goal === "object");
  const goalId = (goal as { goalId?: unknown }).goalId;
  if (typeof goalId !== "string") {
    assert.fail("Expected tool result goal id.");
  }
  return goalId;
}

test("SDK runtime emits a continuation after willRetry compaction when no retry agent starts", async () => {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    noContextFiles: true,
    noExtensions: true,
    extensionFactories: [goalExtension],
  });
  await loader.reload();

  const model = {
    provider: "sdk-smoke",
    id: "mini",
    name: "SDK Smoke",
    api: "sdk-smoke-api",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    authStorage,
    model,
    modelRegistry,
    noTools: "builtin",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager: SettingsManager.inMemory(),
  });

  try {
    const runner = session.extensionRunner;
    const createGoal = runner.getToolDefinition("create_goal");
    assert.ok(createGoal);
    const result = await createGoal.execute(
      "tool-call",
      { objective: "ship it" },
      undefined,
      undefined,
      runner.createContext(),
    );
    const goalId = goalIdFromToolResult(result);

    await runner.emit({
      type: "session_compact",
      compactionEntry: {
        type: "compaction",
        id: "compaction-entry",
        parentId: null,
        timestamp: new Date().toISOString(),
        summary: "compact summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
      fromExtension: false,
      reason: "manual",
      willRetry: true,
    });
    await new Promise((resolve) => setTimeout(resolve, __testHooks.continuationRetryMs + 25));

    const continuationMessages = session.sessionManager.getEntries().filter((entry) => {
      return (
        entry.type === "custom_message" &&
        entry.customType === CUSTOM_ENTRY_TYPE &&
        "details" in entry &&
        (entry.details as { kind?: unknown } | undefined)?.kind === "continuation"
      );
    });
    assert.equal(continuationMessages.length, 1);
    const continuationMessage = continuationMessages[0];
    assert.ok(continuationMessage && "details" in continuationMessage);
    assert.deepEqual(continuationMessage.details, { kind: "continuation", goalId });
  } finally {
    session.dispose();
  }
});
