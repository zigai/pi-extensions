import assert from "node:assert/strict";
import {
    createEventBus,
    type BeforeAgentStartEvent,
    type BeforeAgentStartEventResult,
    type BeforeProviderHeadersEvent,
    type BeforeProviderRequestEvent,
    type BuildSystemPromptOptions,
    type EventBus,
    type ExtensionAPI,
    type ExtensionContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { JsonObjectDecoder, JsonStringDecoder } from "../src/compaction/responses-input.ts";
import type { JsonValue } from "../src/compaction/types.ts";
import type { CodexRuntime, ScheduledTask } from "../src/runtime.ts";

export const TEST_THEME = makeTestTheme();

type HarnessInputEvent = {
    readonly type: "input";
    readonly text: string;
    readonly source: string;
    readonly images?: readonly JsonValue[];
    readonly streamingBehavior?: "steer" | "followUp" | undefined;
};
type HarnessMessageEndEvent = { readonly type: "message_end"; readonly message: JsonValue };
type HarnessAgentEndEvent = {
    readonly type: "agent_end";
    readonly messages: readonly JsonValue[];
};
type HarnessModelSelectEvent = { readonly type: "model_select" };
type HarnessLifecycleEvent = {
    readonly type: "agent_settled" | "session_compact" | "session_start";
};
type HarnessShutdownEvent = { readonly type: "session_shutdown"; readonly reason: string };
type HarnessBeforeCompactEvent = {
    readonly type: "session_before_compact";
    readonly reason: string;
    readonly customInstructions: string | undefined;
    readonly signal: AbortSignal;
    readonly branchEntries: readonly JsonValue[];
    readonly preparation: JsonValue;
};

type ExtensionHarnessEvent =
    | HarnessLifecycleEvent
    | BeforeAgentStartEvent
    | BeforeProviderHeadersEvent
    | BeforeProviderRequestEvent
    | HarnessAgentEndEvent
    | HarnessInputEvent
    | HarnessMessageEndEvent
    | HarnessModelSelectEvent
    | HarnessBeforeCompactEvent
    | HarnessShutdownEvent;

type ExtensionHarnessResult = BeforeAgentStartEventResult | JsonValue | void;

type ExtensionEventHandler = (
    event: ExtensionHarnessEvent,
    ctx: ExtensionContext,
) => ExtensionHarnessResult | Promise<ExtensionHarnessResult>;
type MessageComponent = {
    readonly render: (width: number) => string[];
    readonly invalidate: () => void;
};
type HarnessRenderOptions = {
    readonly expanded?: boolean;
    readonly outputPad?: number;
};
type HarnessMessage = { readonly content?: JsonValue };
type MessageRenderer = (
    message: HarnessMessage,
    options: HarnessRenderOptions,
    theme: Theme,
) => MessageComponent;

type ExtensionHarness = {
    readonly api: ExtensionAPI;
    readonly events: EventBus;
    readonly activeTools: readonly string[];
    readonly appendedEntries: readonly {
        readonly customType: string;
        readonly data: JsonValue;
    }[];
    readonly sentUserMessages: readonly JsonValue[];
    readonly startSession: (ctx: ExtensionContext) => Promise<void>;
    readonly selectModel: (ctx: ExtensionContext) => Promise<void>;
    readonly submitInput: (
        event: HarnessInputEvent,
        ctx: ExtensionContext,
    ) => Promise<Readonly<Record<string, JsonValue | undefined>> | undefined>;
    readonly endMessage: (message: JsonValue, ctx: ExtensionContext) => Promise<void>;
    readonly endAgent: (messages: readonly JsonValue[], ctx: ExtensionContext) => Promise<void>;
    readonly settleAgent: (ctx: ExtensionContext) => Promise<void>;
    readonly shutdownSession: (reason: string, ctx: ExtensionContext) => Promise<void>;
    readonly renderMessage: (
        type: string,
        message: Parameters<MessageRenderer>[0],
        options?: Parameters<MessageRenderer>[1],
    ) => MessageComponent;
    readonly prepareProviderHeaders: (
        headers: Record<string, string | null>,
        ctx: ExtensionContext,
    ) => Promise<void>;
    readonly rewriteProviderRequest: <Payload>(
        payload: Payload,
        ctx: ExtensionContext,
    ) => Promise<(Payload & Readonly<Record<string, JsonValue | undefined>>) | undefined>;
    readonly beginCompaction: (
        ctx: ExtensionContext,
    ) => Promise<Readonly<Record<string, JsonValue | undefined>> | undefined>;
    readonly finishCompaction: (ctx: ExtensionContext) => Promise<void>;
    readonly prepareSystemPrompt: (
        systemPrompt: string,
        options: BuildSystemPromptOptions,
        ctx: ExtensionContext,
    ) => Promise<string>;
};

export function makeExtensionHarness(initialActiveTools: readonly string[] = []): ExtensionHarness {
    let activeTools: string[] = [...initialActiveTools];
    const events = createEventBus();
    const appendedEntries: Array<{ readonly customType: string; readonly data: JsonValue }> = [];
    const sentUserMessages: JsonValue[] = [];
    const messageRenderers = new Map<string, MessageRenderer>();
    const handlers = new Map<string, ExtensionEventHandler>();
    let sessionStart: ExtensionEventHandler | undefined;
    let beforeProviderHeaders: ExtensionEventHandler | undefined;
    let beforeProviderRequest: ExtensionEventHandler | undefined;
    let beforeAgentStart: ExtensionEventHandler | undefined;
    let sessionBeforeCompact: ExtensionEventHandler | undefined;
    let sessionCompact: ExtensionEventHandler | undefined;
    const api = {
        events,
        registerTool() {},
        registerCommand() {},
        registerMessageRenderer(type: string, renderer: MessageRenderer) {
            messageRenderers.set(type, renderer);
        },
        on(eventName: string, handler: ExtensionEventHandler) {
            handlers.set(eventName, handler);
            if (eventName === "session_start") sessionStart = handler;
            if (eventName === "before_provider_headers") beforeProviderHeaders = handler;
            if (eventName === "before_provider_request") beforeProviderRequest = handler;
            if (eventName === "before_agent_start") beforeAgentStart = handler;
            if (eventName === "session_before_compact") sessionBeforeCompact = handler;
            if (eventName === "session_compact") sessionCompact = handler;
        },
        appendEntry(customType: string, data: JsonValue) {
            appendedEntries.push({ customType, data });
        },
        sendUserMessage(message: JsonValue) {
            sentUserMessages.push(message);
        },
        getActiveTools: () => activeTools,
        setActiveTools(tools: readonly string[]) {
            activeTools = [...tools];
        },
        getAllTools: () => [],
    };
    return {
        api: testDouble<ExtensionAPI>()(api),
        events,
        get activeTools() {
            return activeTools;
        },
        appendedEntries,
        sentUserMessages,
        async startSession(ctx: ExtensionContext): Promise<void> {
            assert.ok(sessionStart);
            await sessionStart({ type: "session_start" }, ctx);
        },
        async selectModel(ctx: ExtensionContext): Promise<void> {
            await dispatch("model_select", { type: "model_select" }, ctx);
        },
        async submitInput(
            event: HarnessInputEvent,
            ctx: ExtensionContext,
        ): Promise<Readonly<Record<string, JsonValue | undefined>> | undefined> {
            const result = await dispatch("input", event, ctx);
            return JsonObjectDecoder.decode(result);
        },
        async endMessage(message: JsonValue, ctx: ExtensionContext): Promise<void> {
            await dispatch("message_end", { type: "message_end", message }, ctx);
        },
        async endAgent(messages: readonly JsonValue[], ctx: ExtensionContext): Promise<void> {
            await dispatch("agent_end", { type: "agent_end", messages }, ctx);
        },
        async settleAgent(ctx: ExtensionContext): Promise<void> {
            await dispatch("agent_settled", { type: "agent_settled" }, ctx);
        },
        async shutdownSession(reason: string, ctx: ExtensionContext): Promise<void> {
            await dispatch("session_shutdown", { type: "session_shutdown", reason }, ctx);
        },
        renderMessage(
            type: string,
            message: Parameters<MessageRenderer>[0],
            options: Parameters<MessageRenderer>[1] = {},
        ): MessageComponent {
            const renderer = messageRenderers.get(type);
            assert.ok(renderer);
            return renderer(message, options, TEST_THEME);
        },
        async prepareProviderHeaders(
            headers: Record<string, string | null>,
            ctx: ExtensionContext,
        ): Promise<void> {
            assert.ok(beforeProviderHeaders);
            await beforeProviderHeaders({ type: "before_provider_headers", headers }, ctx);
        },
        async rewriteProviderRequest<Payload>(
            payload: Payload,
            ctx: ExtensionContext,
        ): Promise<(Payload & Readonly<Record<string, JsonValue | undefined>>) | undefined> {
            assert.ok(beforeProviderRequest);
            const result = await beforeProviderRequest(
                { type: "before_provider_request", payload },
                ctx,
            );
            const resultObject = JsonObjectDecoder.decode(result);
            return resultObject === undefined
                ? undefined
                : testDouble<Payload & Readonly<Record<string, JsonValue | undefined>>>()(
                      resultObject,
                  );
        },
        async beginCompaction(
            ctx: ExtensionContext,
        ): Promise<Readonly<Record<string, JsonValue | undefined>> | undefined> {
            assert.ok(sessionBeforeCompact);
            const result = await sessionBeforeCompact(
                {
                    type: "session_before_compact",
                    reason: "manual",
                    customInstructions: undefined,
                    signal: new AbortController().signal,
                    branchEntries: [
                        {
                            type: "message",
                            id: "entry-1",
                            parentId: null,
                            timestamp: "2026-01-01T00:00:00.000Z",
                            message: {
                                role: "user",
                                content: [{ type: "text", text: "hello" }],
                                timestamp: 0,
                            },
                        },
                    ],
                    preparation: {
                        firstKeptEntryId: "entry-1",
                        tokensBefore: 1,
                        previousSummary: undefined,
                        messagesToSummarize: [],
                        turnPrefixMessages: [],
                        fileOps: { read: [], written: [], edited: [] },
                    },
                },
                ctx,
            );
            return JsonObjectDecoder.decode(result);
        },
        async finishCompaction(ctx: ExtensionContext): Promise<void> {
            assert.ok(sessionCompact);
            await sessionCompact({ type: "session_compact" }, ctx);
        },
        async prepareSystemPrompt(
            systemPrompt: string,
            options: BuildSystemPromptOptions,
            ctx: ExtensionContext,
        ): Promise<string> {
            assert.ok(beforeAgentStart);
            const result = await beforeAgentStart(
                {
                    type: "before_agent_start",
                    prompt: "test",
                    systemPrompt,
                    systemPromptOptions: options,
                },
                ctx,
            );
            const resultObject = JsonObjectDecoder.decode(result);
            const preparedPrompt = JsonStringDecoder.decode(resultObject?.systemPrompt);
            if (preparedPrompt === undefined) {
                assert.fail("before_agent_start did not return a system prompt");
            }
            return preparedPrompt;
        },
    };

    async function dispatch(
        eventName: string,
        event: ExtensionHarnessEvent,
        ctx: ExtensionContext,
    ): Promise<ExtensionHarnessResult> {
        const handler = handlers.get(eventName);
        assert.ok(handler);
        return handler(event, ctx);
    }
}

type TestExtensionModel = {
    readonly provider: string;
    readonly api: string;
    readonly id: string;
    readonly baseUrl: string;
    readonly input: readonly string[];
    readonly contextWindow?: number;
};

export const DEFAULT_TEST_EXTENSION_MODEL: TestExtensionModel = {
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5.5",
    baseUrl: "https://chatgpt.com/backend-api",
    input: ["text", "image"],
    contextWindow: 272_000,
};

export function makeExtensionContext(
    cwd: string,
    trusted: boolean,
    model: TestExtensionModel = DEFAULT_TEST_EXTENSION_MODEL,
    options: { readonly agentActive?: boolean } = {},
): ExtensionContext {
    const sessionManager = {
        getSessionId: () => "extension-session",
        getBranch: () => [],
    };
    const ctx = options.agentActive
        ? {
              cwd,
              hasUI: false,
              isProjectTrusted: () => trusted,
              model,
              signal: new AbortController().signal,
              sessionManager,
          }
        : { cwd, hasUI: false, isProjectTrusted: () => trusted, model, sessionManager };
    return testDouble<ExtensionContext>()(ctx);
}

export function makeTestRuntime(
    fetch: typeof globalThis.fetch = async () => {
        throw new Error("Unexpected test fetch.");
    },
): CodexRuntime {
    return {
        fetch,
        clock: {
            nowMs: () => 1_700_000_000_000,
            nowDate: () => new Date("2026-01-01T00:00:00.000Z"),
        },
        idGenerator: { randomUUID: () => "00000000-0000-7000-8000-000000000001" },
        scheduler: {
            set(_delayMs, task) {
                const timer = setTimeout(task, 0);
                return { cancel: () => clearTimeout(timer) } satisfies ScheduledTask;
            },
        },
    };
}

type RenderContextOptions = {
    readonly expanded?: boolean;
    readonly showImages?: boolean;
};

type TestRenderContext<TState extends object, TArgs> = {
    args: TArgs;
    toolCallId: string;
    invalidate: () => void;
    lastComponent: undefined;
    state: TState;
    cwd: string;
    executionStarted: boolean;
    argsComplete: boolean;
    isPartial: boolean;
    expanded: boolean;
    showImages: boolean;
    isError: boolean;
};

export function renderComponent(component: { render(width: number): string[] }): string {
    return component.render(200).join("\n");
}

export function makeRenderContext<TArgs>(
    args: TArgs,
    state?: undefined,
    options?: RenderContextOptions,
): TestRenderContext<Record<string, never>, TArgs>;
export function makeRenderContext<TArgs, TState extends object>(
    args: TArgs,
    state: TState,
    options?: RenderContextOptions,
): TestRenderContext<TState, TArgs>;
export function makeRenderContext<TArgs, TState extends object>(
    args: TArgs,
    state: TState | undefined,
    options: RenderContextOptions = {},
): TestRenderContext<TState | Record<string, never>, TArgs> {
    return {
        args,
        toolCallId: "call-test",
        invalidate() {},
        lastComponent: undefined,
        state: state ?? {},
        cwd: process.cwd(),
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: options.expanded ?? false,
        showImages: options.showImages ?? true,
        isError: false,
    };
}

function makeTestTheme(): Theme {
    const theme = {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        italic: (text: string) => text,
        underline: (text: string) => text,
        inverse: (text: string) => text,
        strikethrough: (text: string) => text,
        getFgAnsi: () => "",
        getBgAnsi: () => "",
        getColorMode: () => "truecolor",
        getThinkingBorderColor: () => (text: string) => text,
        getBashModeBorderColor: () => (text: string) => text,
    };
    return testDouble<Theme>()(theme);
}

export function testDouble<TTarget>() {
    return <TValue>(value: TValue): TTarget => {
        // @ts-expect-error TS2352 -- Test fixtures intentionally implement only the host surface exercised by each test.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: The explicit fixture builders keep every implemented host member reviewable at the construction site.
        return value as TTarget;
    };
}

export function messageEntry<Message>(id: string, parentId: string | null, message: Message) {
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-01-01T00:00:00.000Z",
        message,
    };
}
