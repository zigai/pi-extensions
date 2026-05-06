import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

import goalExtension from "../src/index.js";
import { reconstructGoal } from "../src/state.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";

type EventHandler = (event: object, ctx: ExtensionContext) => void | Promise<void>;

interface SentMessage {
  message: Parameters<ExtensionAPI["sendMessage"]>[0];
  options: Parameters<ExtensionAPI["sendMessage"]>[1];
}

function createRuntimeHarness() {
  const entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]> = [];
  const handlers = new Map<string, EventHandler[]>();
  const sentMessages: SentMessage[] = [];
  let commandHandler: ((args: string, ctx: ExtensionCommandContext) => void | Promise<void>) | null = null;
  let entryIndex = 0;

  const on = ((event: string, handler: EventHandler) => {
    const currentHandlers = handlers.get(event) ?? [];
    currentHandlers.push(handler);
    handlers.set(event, currentHandlers);
  }) as ExtensionAPI["on"];

  const registerCommand: ExtensionAPI["registerCommand"] = (name, options) => {
    if (name === "goal") {
      commandHandler = options.handler;
    }
  };

  const pi: ExtensionAPI = {
    appendEntry(customType: string, data: unknown) {
      entries.push({
        type: "custom",
        id: `entry-${++entryIndex}`,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        customType,
        data,
      });
    },
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getActiveTools: () => [],
    getAllTools: () => [],
    getCommands: () => [],
    getFlag: () => undefined,
    getSessionName: () => undefined,
    getThinkingLevel: () => "medium",
    on,
    registerCommand,
    registerFlag() {},
    registerMessageRenderer() {},
    registerProvider() {},
    registerShortcut() {},
    registerTool() {},
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
    sendUserMessage() {},
    setActiveTools() {},
    setLabel() {},
    setModel: async () => false,
    setSessionName() {},
    setThinkingLevel() {},
    unregisterProvider() {},
  };

  const sessionManager: ExtensionCommandContext["sessionManager"] = {
    getBranch: () => entries,
    getCwd: () => "/tmp",
    getEntries: () => entries,
    getEntry: () => undefined,
    getHeader: () => null,
    getLabel: () => undefined,
    getLeafEntry: () => undefined,
    getLeafId: () => null,
    getSessionDir: () => "/tmp",
    getSessionFile: () => undefined,
    getSessionId: () => "session",
    getSessionName: () => undefined,
    getTree: () => [],
  };

  const ui: ExtensionCommandContext["ui"] = {
    addAutocompleteProvider() {},
    confirm: async () => true,
    custom: async () => {
      throw new Error("custom UI is not implemented in this test harness.");
    },
    editor: async () => undefined,
    getAllThemes: () => [],
    getEditorComponent: () => undefined,
    getEditorText: () => "",
    getTheme: () => undefined,
    getToolsExpanded: () => false,
    input: async () => undefined,
    notify() {},
    onTerminalInput: () => () => {},
    pasteToEditor() {},
    select: async () => undefined,
    setEditorComponent() {},
    setEditorText() {},
    setFooter() {},
    setHeader() {},
    setHiddenThinkingLabel() {},
    setStatus() {},
    setTheme: () => ({ success: false }),
    setTitle() {},
    setToolsExpanded() {},
    setWidget() {},
    setWorkingIndicator() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    theme: {} as ExtensionCommandContext["ui"]["theme"],
  };

  const ctx: ExtensionCommandContext = {
    abort() {},
    compact() {},
    cwd: "/tmp",
    fork: async () => ({ cancelled: false }),
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
    hasUI: true,
    hasPendingMessages: () => false,
    isIdle: () => true,
    model: undefined,
    modelRegistry: {} as ExtensionCommandContext["modelRegistry"],
    navigateTree: async () => ({ cancelled: false }),
    newSession: async () => ({ cancelled: false }),
    reload: async () => {},
    sessionManager,
    shutdown() {},
    signal: undefined,
    switchSession: async () => ({ cancelled: false }),
    ui,
    waitForIdle: async () => {},
  };

  goalExtension(pi);

  async function runCommand(args: string): Promise<void> {
    assert.ok(commandHandler);
    await commandHandler(args, ctx);
  }

  async function emit(event: string, payload: object): Promise<void> {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  }

  return {
    emit,
    entries,
    runCommand,
    sentMessages,
    snapshot: () => reconstructGoal(entries),
  };
}

interface TestAssistantUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

function assistantMessage(stopReason: "stop" | "aborted", usage: TestAssistantUsage) {
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;

  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead,
      cacheWrite,
      totalTokens: usage.totalTokens ?? usage.input + usage.output + cacheRead + cacheWrite,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: 1,
  };
}

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

test("a new user-driven agent start resumes a paused goal", async () => {
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

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 10);
});

test("completed turns count input plus output and continue active goals", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
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
