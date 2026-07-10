import assert from "node:assert/strict";
import {
    type BuildSystemPromptOptions,
    type ExtensionAPI,
    type ExtensionContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import type { CodexRuntime, ScheduledTask } from "../src/runtime.ts";

export const TEST_THEME = makeTestTheme();

type ExtensionEventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type ExtensionHarness = {
    readonly api: ExtensionAPI;
    readonly activeTools: readonly string[];
    readonly startSession: (ctx: ExtensionContext) => Promise<void>;
    readonly prepareProviderHeaders: (
        headers: Record<string, string | null>,
        ctx: ExtensionContext,
    ) => Promise<void>;
    readonly rewriteProviderRequest: (payload: unknown, ctx: ExtensionContext) => Promise<unknown>;
    readonly prepareSystemPrompt: (
        systemPrompt: string,
        options: BuildSystemPromptOptions,
        ctx: ExtensionContext,
    ) => Promise<string>;
};

export function makeExtensionHarness(initialActiveTools: readonly string[] = []): ExtensionHarness {
    let activeTools: string[] = [...initialActiveTools];
    let sessionStart: ExtensionEventHandler | undefined;
    let beforeProviderHeaders: ExtensionEventHandler | undefined;
    let beforeProviderRequest: ExtensionEventHandler | undefined;
    let beforeAgentStart: ExtensionEventHandler | undefined;
    const api = {
        registerTool() {},
        registerCommand() {},
        registerMessageRenderer() {},
        on(eventName: string, handler: ExtensionEventHandler) {
            if (eventName === "session_start") sessionStart = handler;
            if (eventName === "before_provider_headers") beforeProviderHeaders = handler;
            if (eventName === "before_provider_request") beforeProviderRequest = handler;
            if (eventName === "before_agent_start") beforeAgentStart = handler;
        },
        getActiveTools: () => activeTools,
        setActiveTools(tools: readonly string[]) {
            activeTools = [...tools];
        },
        getAllTools: () => [],
    };
    return {
        // SAFETY: This fixture implements the ExtensionAPI members exercised during extension registration and session_start.
        api: api as unknown as ExtensionAPI,
        get activeTools() {
            return activeTools;
        },
        async startSession(ctx: ExtensionContext): Promise<void> {
            assert.ok(sessionStart);
            await sessionStart({ type: "session_start" }, ctx);
        },
        async prepareProviderHeaders(
            headers: Record<string, string | null>,
            ctx: ExtensionContext,
        ): Promise<void> {
            assert.ok(beforeProviderHeaders);
            await beforeProviderHeaders({ type: "before_provider_headers", headers }, ctx);
        },
        async rewriteProviderRequest(payload: unknown, ctx: ExtensionContext): Promise<unknown> {
            assert.ok(beforeProviderRequest);
            return beforeProviderRequest({ type: "before_provider_request", payload }, ctx);
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
            assert.ok(isRecord(result));
            if (typeof result.systemPrompt !== "string") {
                assert.fail("before_agent_start did not return a system prompt");
            }
            return result.systemPrompt;
        },
    };
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
): ExtensionContext {
    const ctx = {
        cwd,
        hasUI: false,
        isProjectTrusted: () => trusted,
        model,
        sessionManager: {
            getSessionId: () => "extension-session",
            getBranch: () => [],
        },
    };
    // SAFETY: This fixture supplies the fields read by session_start tool synchronization.
    return ctx as unknown as ExtensionContext;
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
        idGenerator: { randomUUID: () => "test-uuid" },
        scheduler: {
            set(_delayMs, task) {
                task();
                return { cancel() {} } satisfies ScheduledTask;
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

export function makeRenderContext<TArgs, TState extends object = Record<string, never>>(
    args: TArgs,
    state?: TState,
    options: RenderContextOptions = {},
): TestRenderContext<TState, TArgs> {
    // SAFETY: Tests omit renderer state only for renderers that do not read custom state.
    const renderState = state ?? ({} as TState);
    return {
        args,
        toolCallId: "call-test",
        invalidate() {},
        lastComponent: undefined,
        state: renderState,
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
    // SAFETY: Renderer tests exercise only Theme's styling methods and do not rely on Theme identity.
    return theme as unknown as Theme;
}

export function messageEntry(
    id: string,
    parentId: string | null,
    message: unknown,
): Record<string, unknown> {
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-01-01T00:00:00.000Z",
        message,
    };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
