import assert from "node:assert/strict";
import { vi } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { createEventBus } from "@earendil-works/pi-coding-agent";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartUserEvent,
  BeforeAgentStartCustomEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

import goalExtension, { __testHooks } from "../../src/index.ts";
import type { GoalToolResponse } from "../../src/format.ts";
import type { CreateGoalArgs, GetGoalArgs, UpdateGoalArgs } from "../../src/glowup-rendering.ts";
import { isContextOverflowError } from "../../src/recovery.ts";
import { isGoalCustomEntry, reconstructGoal } from "../../src/state.ts";
import {
  toQueuedGoalContextCarrier,
  type ActiveGoalQueuedDetails,
  type QueuedGoalContextCarrier,
  type QueuedGoalContextInput,
  type QueuedGoalUserContent,
} from "../../src/queued-goal-messages.ts";
import { CUSTOM_ENTRY_TYPE } from "../../src/types.ts";

interface HarnessEvent {
  type: string;
}

interface HarnessContextEventResult {
  messages?: QueuedGoalContextInput[];
}

type HarnessEventResult = HarnessContextEventResult | BeforeAgentStartEventResult | void;
type HarnessGoalToolInput = GetGoalArgs | CreateGoalArgs | UpdateGoalArgs;

interface HarnessGoalToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: GoalToolResponse & { error: string | null };
}

type EventHandler = (
  event: HarnessEvent,
  ctx: ExtensionContext,
) => HarnessEventResult | Promise<HarnessEventResult>;

function isHarnessUserMessageStart(
  event: HarnessEvent,
): event is HarnessEvent & { type: "message_start"; message: { role: string } } {
  return (
    event.type === "message_start" &&
    "message" in event &&
    event.message !== null &&
    typeof event.message === "object" &&
    "role" in event.message &&
    typeof event.message.role === "string"
  );
}

function unsupportedHarnessMethod(name: string): never {
  throw new Error(`${name} is not implemented in this test harness.`);
}

function contextWindowModel(contextWindow: number): ExtensionContext["model"] {
  // SAFETY: goal runtime reads only model.contextWindow; this fixture supplies that exact SDK
  // field, while provider execution and the remaining Model capabilities are never invoked.
  return {
    id: "test-model",
    provider: "test",
    contextWindow,
  } as ExtensionContext["model"];
}

export interface SentMessage {
  message: Parameters<ExtensionAPI["sendMessage"]>[0];
  options: Parameters<ExtensionAPI["sendMessage"]>[1];
}

export interface SentUserMessage {
  content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
  options: Parameters<ExtensionAPI["sendUserMessage"]>[1];
}

export function sentMessageText(message: SentMessage): string {
  return Value.Parse(Type.String(), message.message.content);
}

export function sentUserMessageText(message: SentUserMessage): string {
  return Value.Parse(Type.String(), message.content);
}

export function queuedGoalMessageText(message: QueuedGoalContextCarrier): string {
  return Value.Parse(Type.String(), message.content);
}

type CompactionReason = "manual" | "threshold" | "overflow";

interface CompactionEventOptions {
  reason?: CompactionReason;
  willRetry?: boolean;
  summary?: string;
  tokensBefore?: number;
}

export function sessionBeforeCompactEvent(options: CompactionEventOptions = {}) {
  return {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    reason: options.reason ?? "manual",
    willRetry: options.willRetry ?? false,
    signal: new AbortController().signal,
  };
}

export function sessionCompactEvent(options: CompactionEventOptions = {}) {
  const summary = options.summary ?? "compact summary";
  const tokensBefore = options.tokensBefore ?? 100;

  return {
    type: "session_compact",
    compactionEntry: {
      type: "compaction",
      id: "compaction-entry",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      summary,
      firstKeptEntryId: "entry-1",
      tokensBefore,
    },
    fromExtension: false,
    reason: options.reason ?? "manual",
    willRetry: options.willRetry ?? false,
  };
}

export function beforeAgentStartEvent(
  trigger: (
    | Pick<BeforeAgentStartUserEvent, "messageType" | "prompt" | "images">
    | Pick<BeforeAgentStartCustomEvent, "messageType" | "message">
  ) & { systemPrompt?: string },
): BeforeAgentStartEvent {
  return {
    ...trigger,
    type: "before_agent_start",
    systemPrompt: trigger.systemPrompt ?? "",
    systemPromptOptions: {
      cwd: "/tmp",
      selectedTools: [],
      hiddenTools: [],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      sections: {},
      contextFiles: [],
      skills: [],
    },
  };
}

export function sessionShutdownEvent(
  reason: "quit" | "reload" | "new" | "resume" | "fork" = "quit",
) {
  return { type: "session_shutdown" as const, reason };
}

export function createRuntimeHarness(
  options: {
    idle?: boolean;
    pendingMessages?: boolean;
    compactBehavior?: "success" | "error" | "unavailable";
    compactCompletion?: "immediate" | "manual";
    contextWindow?: number;
    contextUsage?: ReturnType<ExtensionContext["getContextUsage"]>;
    availableTools?: readonly string[];
    activeTools?: readonly string[];
    cwd?: string;
    projectTrusted?: boolean;
  } = {},
) {
  const cwd = options.cwd ?? "/tmp";
  const entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]> = [];
  const handlers = new Map<string, EventHandler[]>();
  const sentMessages: SentMessage[] = [];
  const sentUserMessages: SentUserMessage[] = [];
  const tools = new Map<string, (params: HarnessGoalToolInput) => Promise<HarnessGoalToolResult>>();
  const availableToolNames = new Set(options.availableTools ?? []);
  const activeToolNames = new Set(options.activeTools ?? options.availableTools ?? []);
  const compactCalls: Array<{
    customInstructions?: string;

    onComplete?: (result: {
      summary: string;
      tokensBefore: number;
      firstKeptEntryId: string;
    }) => void;

    onError?: (error: Error) => void;
  }> = [];
  const footerStatuses: Array<string | undefined> = [];
  const runtime = {
    abortCount: 0,
    idle: options.idle ?? true,
    pendingMessages: options.pendingMessages ?? false,
    compactBehavior: options.compactBehavior ?? "success",
    compactCompletion: options.compactCompletion ?? "immediate",
    contextUsage: options.contextUsage,
    hostOverflowRecoveryAttempted: false,
  };
  let commandHandler:
    | ((args: string, ctx: ExtensionCommandContext) => void | Promise<void>)
    | null = null;
  let ctx: ExtensionCommandContext;
  let entryIndex = 0;

  // SAFETY: ExtensionAPI.on supplies handlers for the registered event name; emit stores and
  // invokes each handler only under that same name, preserving the SDK event/result pairing.
  const on = ((event: string, handler: EventHandler) => {
    const currentHandlers = handlers.get(event) ?? [];
    currentHandlers.push(handler);
    handlers.set(event, currentHandlers);

    let subscribed = true;
    return () => {
      if (!subscribed) return;

      subscribed = false;

      const index = currentHandlers.indexOf(handler);
      if (index !== -1) currentHandlers.splice(index, 1);
    };
  }) as ExtensionAPI["on"];

  const registerCommand: ExtensionAPI["registerCommand"] = (name, options) => {
    if (name === "goal") {
      commandHandler = options.handler;
    }
  };

  const pi: ExtensionAPI = {
    appendEntry(customType, data) {
      entries.push({
        type: "custom",
        id: `entry-${++entryIndex}`,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        customType,
        data,
      });
    },
    events: createEventBus(),
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getActiveTools: () => [...activeToolNames],
    getAllTools: () => {
      // SAFETY: goal-tool policy consumes only ToolInfo.name; each fixture supplies that field,
      // and no test or extension path reads omitted execution/render metadata from this list.
      return [...availableToolNames].map((name) => ({
        name,
        description: `${name} test tool`,
      })) as ReturnType<ExtensionAPI["getAllTools"]>;
    },
    getCommands: () => [],
    getFlag: () => undefined,
    getSettings() {
      unsupportedHarnessMethod("pi.getSettings");
    },
    getMcpServers() {
      unsupportedHarnessMethod("pi.getMcpServers");
    },
    getSessionName: () => undefined,
    getThinkingLevel: () => "medium",
    on,
    registerCommand,
    registerEntryRenderer() {
      unsupportedHarnessMethod("pi.registerEntryRenderer");
    },
    registerFlag() {
      unsupportedHarnessMethod("pi.registerFlag");
    },
    registerMarkdownTransformer() {
      unsupportedHarnessMethod("pi.registerMarkdownTransformer");
    },
    registerMessageRenderer() {
      unsupportedHarnessMethod("pi.registerMessageRenderer");
    },
    registerProvider() {
      unsupportedHarnessMethod("pi.registerProvider");
    },
    registerMcpServer() {
      unsupportedHarnessMethod("pi.registerMcpServer");
    },
    unregisterMcpServer() {
      unsupportedHarnessMethod("pi.unregisterMcpServer");
    },
    registerVirtualModel() {
      unsupportedHarnessMethod("pi.registerVirtualModel");
    },
    unregisterVirtualModel() {
      unsupportedHarnessMethod("pi.unregisterVirtualModel");
    },
    registerShortcut() {},
    registerToolRenderer() {
      unsupportedHarnessMethod("pi.registerToolRenderer");
    },
    registerTool(tool) {
      availableToolNames.add(tool.name);
      activeToolNames.add(tool.name);
      tools.set(tool.name, async (params) => {
        const toolContext: ExtensionToolContext = {
          ...ctx,
          tools: [],
          async executeTool() {
            unsupportedHarnessMethod("ctx.executeTool");
          },
        };

        // SAFETY: this harness loads only pi-codex-goal, and runTool callers pair each registered
        // goal-tool name with input derived from that tool's exported schema.
        const result = await tool.execute(
          "tool-call",
          params as Parameters<typeof tool.execute>[1],
          undefined,
          undefined,
          toolContext,
        );

        // SAFETY: all three goal tools return textResult, whose details are the shared
        // GoalToolResponse plus its concrete null error field.
        return result as HarnessGoalToolResult;
      });
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(content, options) {
      sentUserMessages.push({ content, options });
    },
    setActiveTools(names) {
      activeToolNames.clear();

      for (const name of names) {
        if (availableToolNames.has(name)) {
          activeToolNames.add(name);
        }
      }
    },
    setLabel() {
      unsupportedHarnessMethod("pi.setLabel");
    },
    setModel: async () => false,
    setSessionName() {
      unsupportedHarnessMethod("pi.setSessionName");
    },
    setThinkingLevel() {
      unsupportedHarnessMethod("pi.setThinkingLevel");
    },
    unregisterProvider() {
      unsupportedHarnessMethod("pi.unregisterProvider");
    },
  };

  const sessionManager: ExtensionCommandContext["sessionManager"] = {
    buildContextEntries: () => entries,
    buildSessionProjection() {
      unsupportedHarnessMethod("sessionManager.buildSessionProjection");
    },
    getBranch: () => entries,
    getCwd: () => cwd,
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
    setStatus(_key, status) {
      footerStatuses.push(status);
    },
    setTheme: () => ({ success: false }),
    setTitle() {},
    setToolsExpanded() {},
    setWidget() {},
    setWorkingIndicator() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    // SAFETY: pi-codex-goal never reads ui.theme; the field exists only because the external
    // ExtensionCommandContext contract requires a host-provided Theme instance.
    theme: {} as ExtensionCommandContext["ui"]["theme"],
  };

  ctx = {
    abort() {
      runtime.abortCount += 1;
    },
    cwd,
    fork: async () => ({ cancelled: false }),
    getContextUsage: () => runtime.contextUsage,
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: ctx.cwd }),
    hasUI: true,
    compact(options) {
      const call: (typeof compactCalls)[number] = {};
      if (options?.customInstructions !== undefined) {
        call.customInstructions = options.customInstructions;
      }

      if (options?.onComplete) {
        call.onComplete = (result) => options.onComplete?.(result);
      }

      if (options?.onError) {
        call.onError = (error) => options.onError?.(error);
      }

      compactCalls.push(call);

      if (runtime.compactBehavior === "unavailable") {
        unsupportedHarnessMethod("ctx.compact");
      }

      if (runtime.compactBehavior === "error") {
        options?.onError?.(new Error("compaction failed"));
        return;
      }

      if (runtime.compactCompletion === "immediate") {
        options?.onComplete?.({
          summary: "compact summary",
          tokensBefore: 100,
          firstKeptEntryId: "entry-1",
        });
      }
    },
    hasPendingMessages: () => runtime.pendingMessages,
    isIdle: () => runtime.idle,
    isProjectTrusted: () => options.projectTrusted ?? true,
    mode: "tui",
    model: undefined,
    // SAFETY: pi-codex-goal never reads modelRegistry; model discovery is outside this harness,
    // and the field exists only to satisfy the host-owned ExtensionCommandContext contract.
    modelRegistry: {} as ExtensionCommandContext["modelRegistry"],
    navigateTree: async () => ({ cancelled: false }),
    newSession: async () => ({ cancelled: false }),
    reload: async () => {},
    scopedModels: [],
    sessionManager,
    shutdown() {},
    signal: undefined,
    switchSession: async () => ({ cancelled: false }),
    ui,
    waitForIdle: async () => {},
  } satisfies ExtensionCommandContext;

  if (options.contextWindow !== undefined) {
    ctx.model = contextWindowModel(options.contextWindow);
  }

  goalExtension(pi);

  async function emit<const Event extends HarnessEvent>(
    event: Event["type"],
    payload: Event,
  ): Promise<HarnessEventResult[]> {
    if (isHarnessUserMessageStart(payload) && payload.message.role === "user") {
      runtime.hostOverflowRecoveryAttempted = false;
    }

    const results: HarnessEventResult[] = [];
    const eventHandlers = handlers.get(event)?.slice() ?? [];
    for (const handler of eventHandlers) {
      results.push(await handler(payload, ctx));
    }

    return results;
  }

  function reloadExtension(): void {
    handlers.clear();
    goalExtension(pi);
  }

  async function reloadSession(reason: "startup" | "reload" | "resume" = "startup"): Promise<void> {
    reloadExtension();
    await emit("session_start", { type: "session_start", reason });
  }

  async function runCommand(args: string): Promise<void> {
    assert.ok(commandHandler);
    const managementCommand = args === "pause" || args === "resume" || args.length === 0;

    // Most runtime tests exercise continuation/recovery mechanics and need deterministic direct
    // goal creation. The public default now asks the model to generate an objective, so route test
    // objectives through the explicit raw mode while preserving management command spellings.
    await commandHandler(managementCommand || args.startsWith("-") ? args : `-r ${args}`, ctx);
  }

  async function runTool(name: string, params: HarnessGoalToolInput) {
    const tool = tools.get(name);
    assert.ok(tool, `Expected tool ${name} to be registered.`);
    return tool(params);
  }

  return {
    compactCalls,
    footerStatuses,
    emit,
    entries,
    runCommand,
    runTool,
    reloadExtension,
    reloadSession,
    sentMessages,
    sentUserMessages,
    get activeTools() {
      return [...activeToolNames];
    },
    setIdle(idle: boolean) {
      runtime.idle = idle;
    },
    setPendingMessages(pendingMessages: boolean) {
      runtime.pendingMessages = pendingMessages;
    },
    setContextUsage(contextUsage: ReturnType<ExtensionContext["getContextUsage"]>) {
      runtime.contextUsage = contextUsage;
    },
    setContextWindow(contextWindow: number) {
      ctx.model = contextWindowModel(contextWindow);
    },
    get hostOverflowRecoveryAttempted() {
      return runtime.hostOverflowRecoveryAttempted;
    },
    setHostOverflowRecoveryAttempted(value: boolean) {
      runtime.hostOverflowRecoveryAttempted = value;
    },
    get abortCount() {
      return runtime.abortCount;
    },
    snapshot: () => reconstructGoal(entries),
  };
}

export interface TestAssistantUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export function flushContinuationScheduler(): void {
  vi.advanceTimersByTime(__testHooks.continuationRetryMs);
}

export function fireProviderLimitAutoResume(): void {
  vi.advanceTimersByTime(__testHooks.providerLimitAutoResumeMs);
}

export function countGoalSetEntries(
  entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>,
  goalId?: string,
): number {
  return entries.filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data) &&
      entry.data.kind === "set" &&
      (goalId === undefined || entry.data.goal.goalId === goalId)
    );
  }).length;
}

export function countGoalUsageEntries(
  entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>,
  goalId?: string,
): number {
  return entries.filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data) &&
      entry.data.kind === "usage" &&
      (goalId === undefined || entry.data.goalId === goalId)
    );
  }).length;
}

export async function emitToolExecutionEnd(
  harness: ReturnType<typeof createRuntimeHarness>,
): Promise<void> {
  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-call",
    toolName: "bash",
    args: {},
    result: {},
    isError: false,
  });
}

export function queuedCustomMessage(sent: SentMessage, timestamp = 1): QueuedGoalContextCarrier {
  return {
    role: "custom",
    customType: sent.message.customType,
    content: sent.message.content,
    display: sent.message.display,
    details: sent.message.details,
    timestamp,
  };
}

interface InactiveGoalQueuedDetails {
  kind: "other";
  goalId: string;
}

export function goalCustomContextMessage(options: {
  content: string;
  details: ActiveGoalQueuedDetails | InactiveGoalQueuedDetails;
  display?: boolean;
  timestamp: number;
}): QueuedGoalContextCarrier {
  return {
    role: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    content: options.content,
    display: options.display ?? false,
    details: options.details,
    timestamp: options.timestamp,
  };
}

export interface ProviderContextResult {
  messages: QueuedGoalContextCarrier[];
}

export type ProviderContextHandlerResult = ProviderContextResult | undefined;

function parseProviderContextHandlerResult(
  result: HarnessEventResult,
): ProviderContextHandlerResult {
  if (result === undefined) {
    return undefined;
  }

  assert.ok("messages" in result, "Expected provider context handler result object.");
  assert.ok(Array.isArray(result.messages), "Expected provider context handler messages array.");
  const messages: QueuedGoalContextCarrier[] = [];
  for (const [index, message] of result.messages.entries()) {
    const carrier = toQueuedGoalContextCarrier(message);
    assert.ok(
      carrier,
      `Expected provider context message ${index} to include a numeric timestamp.`,
    );

    messages.push(carrier);
  }

  return { messages };
}

export function requireProviderContextResult(
  results: ProviderContextHandlerResult[],
): ProviderContextResult {
  const result = results[0];
  if (result === undefined) {
    assert.fail("Expected provider context handler to return rewritten messages.");
  }

  return result;
}

export function providerContextMessageAt(
  result: ProviderContextResult,
  index: number,
): QueuedGoalContextCarrier {
  const message = result.messages[index];
  assert.ok(message, `Expected provider context message at index ${index}.`);
  return message;
}

export function goalUserContextMessage(text: string, timestamp = 1): QueuedGoalContextCarrier {
  const content: QueuedGoalUserContent = [{ type: "text", text }];
  return {
    role: "user",
    content,
    timestamp,
  };
}

export async function emitProviderContext(
  harness: RuntimeHarness,
  messages: QueuedGoalContextCarrier[],
): Promise<ProviderContextHandlerResult[]> {
  const results = await harness.emit("context", { type: "context", messages });
  return results.map(parseProviderContextHandlerResult);
}

export type RuntimeHarness = ReturnType<typeof createRuntimeHarness>;

export async function emitQueuedTurnThroughContext(
  harness: RuntimeHarness,
  messages: QueuedGoalContextCarrier[],
  turnIndex = 0,
): Promise<ProviderContextHandlerResult[]> {
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });

  for (const message of messages) {
    await harness.emit("message_start", { type: "message_start", message });
    await harness.emit("message_end", { type: "message_end", message });
  }

  const results = await harness.emit("context", { type: "context", messages });
  return results.map(parseProviderContextHandlerResult);
}

export function assistantMessage(
  stopReason: "stop" | "aborted" | "length" | "toolUse" | "error",
  usage: TestAssistantUsage,
  errorMessage?: string,
) {
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;

  const message = {
    role: "assistant" as const,
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
  };
  if (stopReason === "error") {
    return { ...message, errorMessage: errorMessage ?? "provider error", timestamp: 1 };
  }

  return { ...message, timestamp: 1 };
}

export async function emitPersistentAssistantError(
  harness: ReturnType<typeof createRuntimeHarness>,
  turnIndex: number,
  errorMessage: string,
): Promise<void> {
  const message = assistantMessage("error", { input: 1, output: 1 }, errorMessage);

  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [message],
  });

  if (isContextOverflowError(errorMessage)) {
    harness.setHostOverflowRecoveryAttempted(true);
  }
}

export async function emitHostSessionCompact(
  harness: RuntimeHarness,
  options: CompactionEventOptions = {},
): Promise<void> {
  const eventOptions: CompactionEventOptions = { reason: "overflow", ...options };
  await harness.emit("session_before_compact", sessionBeforeCompactEvent(eventOptions));
  await harness.emit("session_compact", sessionCompactEvent(eventOptions));
}

export async function emitSilentContextOverflow(
  harness: RuntimeHarness,
  turnIndex: number,
  message: ReturnType<typeof assistantMessage>,
): Promise<void> {
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [message],
  });
  harness.setHostOverflowRecoveryAttempted(true);
}
