import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import goalExtension, { __testHooks } from "../src/index.ts";
import { isActiveGoalQueuedDetails } from "../src/queued-goal-messages.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

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

test("custom starts run authoritative Goal work and reject stale continuations without handler errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-goal-custom-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const errors: string[] = [];
  let requests = 0;
  let finishGoal = false;
  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider("synthetic", {
      api: "custom-goal-test",
      apiKey: "synthetic-key",
      baseUrl: "https://example.invalid",
      models: [
        {
          id: "small",
          name: "Small",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 10000,
          maxTokens: 100,
        },
      ],
      streamSimple(model) {
        requests += 1;
        const stream = createAssistantMessageEventStream();
        let content: AssistantMessage["content"] = [{ type: "text", text: "Synthetic response" }];
        let reason: "stop" | "toolUse" = "stop";
        if (finishGoal) {
          finishGoal = false;
          content = [
            {
              type: "toolCall",
              id: "complete-goal",
              name: "update_goal",
              arguments: { status: "complete" },
            },
          ];
          reason = "toolUse";
        }

        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content,
          timestamp: 1,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: reason,
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason, message });
        stream.end(message);

        return stream;
      },
    });
    const model = modelRuntime.getModel("synthetic", "small");
    assert.ok(model);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noContextFiles: true,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [goalExtension],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "builtin",
    });
    await session.bindExtensions({
      mode: "print",
      onError: (error) => {
        errors.push(error.error);
      },
    });
    try {
      await session.sendCustomMessage(
        {
          customType: "background-work",
          content: '<pi_goal_continuation goal_id="unrelated">',
          display: false,
        },
        { triggerTurn: true },
      );
      assert.equal(requests, 1);
      assert.deepEqual(errors, []);
      const createGoal = session.agent.state.tools.find((tool) => tool.name === "create_goal");
      assert.ok(createGoal);
      const goalId = goalIdFromToolResult(
        await createGoal.execute("create", { objective: "Complete a synthetic task" }),
      );
      finishGoal = true;
      await session.sendCustomMessage(
        {
          customType: CUSTOM_ENTRY_TYPE,
          content: [
            { type: "text", text: '<pi_goal_continuation goal_id="different-content-id">' },
          ],
          display: false,
          details: { kind: "continuation", goalId },
        },
        { triggerTurn: true },
      );
      assert.equal(requests, 3);
      assert.deepEqual(errors, []);

      await session.sendCustomMessage(
        {
          customType: CUSTOM_ENTRY_TYPE,
          content: "Stale synthetic work",
          display: false,
          details: { kind: "continuation", goalId },
        },
        { triggerTurn: true },
      );
      assert.equal(requests, 3);
      assert.deepEqual(errors, []);
    } finally {
      session.dispose();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

    await rm(root, { recursive: true, force: true });
  }
});

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
