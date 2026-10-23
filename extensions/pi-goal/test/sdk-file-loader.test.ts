import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test } from "vitest";

test("standalone Goal blocks a deferred question through the real nested-tool pipeline only while active", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-goal-invocation-"));
  const agentDir = join(directory, "agent");
  mkdirSync(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let questionCalls = 0;
  try {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          name: "synthetic-tools",
          factory(pi) {
            pi.registerTool({
              name: "ask_user_question",
              label: "Question",
              description: "Synthetic question",
              exposure: "deferred",
              parameters: Type.Object({}),
              async execute() {
                questionCalls += 1;
                return { content: [{ type: "text", text: "answer" }], details: undefined };
              },
            });
            pi.registerTool({
              name: "invoke_question",
              label: "Invoke",
              description: "Nested question",
              parameters: Type.Object({}),
              async execute(_id, _args, _signal, _update, ctx) {
                const result = await ctx.executeTool("ask_user_question", {});
                return { content: result.result.content, details: result };
              },
            });
          },
        },
      ],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(directory),
      settingsManager: SettingsManager.inMemory(),
      noTools: "builtin",
    });
    await session.bindExtensions({ mode: "print" });
    try {
      const tool = (name: string) => {
        const found = session.agent.state.tools.find((candidate) => candidate.name === name);
        assert.ok(found);
        return found;
      };
      await tool("create_goal").execute("create", { objective: "Complete a synthetic task" });
      expect(
        await session.extensionRunner.emitToolCall({
          type: "tool_call",
          toolCallId: "direct",
          toolName: "ask_user_question",
          input: {},
        }),
      ).toMatchObject({ block: true });
      session.agent.state.messages = [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "outer", name: "invoke_question", arguments: {} }],
          api: "openai-responses",
          provider: "synthetic",
          model: "synthetic",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
      ];
      expect((await tool("invoke_question").execute("outer", {})).details).toMatchObject({
        isError: true,
      });

      expect(questionCalls).toBe(0);
      await tool("update_goal").execute("stop", { status: "blocked" });
      expect(
        await session.extensionRunner.emitToolCall({
          type: "tool_call",
          toolCallId: "after",
          toolName: "ask_user_question",
          input: {},
        }),
      ).toBeUndefined();

      expect((await tool("invoke_question").execute("outer", {})).details).toMatchObject({
        isError: false,
      });

      expect(questionCalls).toBe(1);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

    rmSync(directory, { recursive: true, force: true });
  }
});

test("the real SDK file loader registers every goal tool and command without import errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-goal-file-loader-"));
  const agentDirectory = join(directory, "agent");
  mkdirSync(agentDirectory);
  const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;

  try {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: agentDirectory,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const extension = loaded.extensions[0];
    assert.ok(extension);
    expect([...extension.tools.keys()].sort()).toEqual(["create_goal", "get_goal", "update_goal"]);
    expect([...extension.commands.keys()]).toEqual(["goal"]);
  } finally {
    if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;

    rmSync(directory, { recursive: true, force: true });
  }
});
