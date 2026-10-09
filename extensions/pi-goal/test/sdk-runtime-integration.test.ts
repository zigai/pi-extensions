import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import goalExtension, { __testHooks } from "../src/index.js";
import { isActiveGoalQueuedDetails } from "../src/queued-goal-messages.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";

const GoalIdToolResultSchema = Type.Object(
  {
    details: Type.Object(
      {
        goal: Type.Object(
          {
            goalId: Type.String(),
          },
          { additionalProperties: true },
        ),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

const GlowupRenderingOwnerSchema = Type.Object(
  {
    glowupRendering: Type.Object(
      {
        version: Type.Literal(3),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

function goalIdFromToolResult(result: unknown): string {
  return Value.Parse(GoalIdToolResultSchema, result).details.goal.goalId;
}

test("SDK runtime emits a continuation after willRetry compaction when no retry agent starts", async () => {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    noContextFiles: true,
    noExtensions: true,
    extensionFactories: [goalExtension],
  });
  await loader.reload();

  modelRuntime.registerProvider("sdk-verification", {
    baseUrl: "http://localhost",
    apiKey: "test-key",
    api: "openai-completions",
    models: [
      {
        id: "mini",
        name: "SDK Verification",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000,
        maxTokens: 100,
      },
    ],
  });
  const model = modelRuntime.getModel("sdk-verification", "mini");
  assert.ok(model);
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    model,
    modelRuntime,
    noTools: "builtin",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager: SettingsManager.inMemory(),
  });

  try {
    const runner = session.extensionRunner;
    for (const toolName of ["get_goal", "create_goal", "update_goal"]) {
      const definition = runner.getToolDefinition(toolName);
      assert.ok(definition);
      const renderingOwner = Value.Parse(GlowupRenderingOwnerSchema, definition);
      assert.equal(renderingOwner.glowupRendering.version, 3);
    }

    const createGoal = runner.getToolDefinition("create_goal");
    assert.ok(createGoal);
    const result = await createGoal.execute(
      "tool-call",
      { objective: "ship it" },
      undefined,
      undefined,
      runner.createToolContext("tool-call", undefined),
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
        isActiveGoalQueuedDetails(entry.details) &&
        entry.details.kind === "continuation"
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
