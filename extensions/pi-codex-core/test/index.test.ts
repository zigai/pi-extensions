import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import type {
    ExtensionContext,
    SessionBeforeCompactEvent,
    Theme,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";

import { packageName, extensionName } from "../src/index.ts";
import {
    CODEX_CURRENT_MODEL_SELECTION,
    DEFAULT_CODEX_CORE_CONFIG,
    parseCodexCoreConfig,
    resolveCodexRequestModel,
} from "../src/config.ts";
import {
    handleCodexNativeCompaction,
    NATIVE_COMPACTION_SHIM_SUMMARY,
    rewriteProviderRequestWithNativeCompaction,
} from "../src/compaction.ts";
import { saveGeneratedImage } from "../src/image-content.ts";
import { createImagegenTool } from "../src/tools/imagegen.ts";
import { createViewImageTool } from "../src/tools/view-image.ts";
import { formatWebRunToolOutput } from "../src/tools/web-run-output.ts";
import { createWebRunTool } from "../src/tools/web-run.ts";
import { formatCodexUsage, parseCodexUsagePayload } from "../src/usage.ts";

test("exports extension metadata", () => {
    assert.equal(packageName, "pi-codex-core");
    assert.equal(extensionName, "Pi Codex Core");
});

test("parses codex config with safe defaults", () => {
    const config = parseCodexCoreConfig({
        scope: { tools: "all" },
        tools: { webSearch: false, viewImageDescriptions: true },
        prompt: { mode: "codex" },
        compaction: { enabled: true },
        openai: { verbosity: "high", compactionReasoning: "low" },
    });

    assert.equal(config.scope.tools, "all");
    assert.equal(config.tools.webSearch, false);
    assert.equal(config.tools.imageGeneration, DEFAULT_CODEX_CORE_CONFIG.tools.imageGeneration);
    assert.equal(config.tools.viewImageDescriptions, true);
    assert.equal(config.prompt.mode, "codex");
    assert.equal(config.compaction.enabled, true);
    assert.equal(config.openai.webSearchModel, CODEX_CURRENT_MODEL_SELECTION);
    assert.equal(config.openai.compactionModel, CODEX_CURRENT_MODEL_SELECTION);
    assert.equal(config.openai.verbosity, "high");
    assert.equal(config.openai.compactionReasoning, "low");
});

test("resolves current Codex model selections", () => {
    assert.equal(resolveCodexRequestModel("current", "gpt-5.5"), "gpt-5.5");
    assert.equal(resolveCodexRequestModel("gpt-5.4-mini", "gpt-5.5"), "gpt-5.4-mini");
});

test("formats codex usage payloads", () => {
    const resetBase = Math.floor(Date.now() / 1000);
    const snapshot = parseCodexUsagePayload({
        plan_type: "pro",
        rate_limit_reset_credits: { available_count: 2 },
        rate_limit: {
            primary_window: {
                used_percent: 25,
                limit_window_seconds: 18_000,
                resets_at: resetBase + 10_800,
            },
            secondary_window: {
                used_percent: 1,
                window_minutes: 10_080,
                resets_at: resetBase + 604_800,
            },
        },
        additional_rate_limits: [
            {
                metered_feature: "gpt-5.3-codex-spark",
                limit_name: "gpt-5.3-codex-spark",
                rate_limit: {
                    primary_window: {
                        used_percent: 0,
                        limit_window_seconds: 18_000,
                        resets_at: resetBase + 10_800,
                    },
                    secondary_window: {
                        used_percent: 0,
                        window_minutes: 10_080,
                        resets_at: resetBase + 604_800,
                    },
                },
            },
        ],
    });

    assert.equal(snapshot.planType, "pro");
    assert.equal(snapshot.resetCredits?.availableCount, 2);
    assert.equal(snapshot.limits.length, 2);
    const formatted = formatCodexUsage(snapshot);
    const lines = formatted.split("\n");
    assert.equal(lines[0], "Codex usage (Pro):");
    assert.match(formatCodexUsage({ ...snapshot, planType: "plus" }), /^Codex usage \(Plus\):/);
    assert.match(lines[1] ?? "", /^- Codex: {15}5h: 75% left {2}\(/);
    assert.match(lines[2] ?? "", /^- GPT-5\.3-Codex-Spark: 5h: 100% left \(/);
    assert.equal(lines.at(-1), "- Resets available: 2");
    assert.doesNotMatch(formatted, /\b300m\b|\b10080m\b/);
});

test("renders compact invocation summaries for Codex tools", () => {
    const webRunTool = createWebRunTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(webRunTool.renderCall);
    const webRunArgs = {
        search_query: [{ q: "official TypeScript documentation handbook" }],
        response_length: "short" as const,
        settings: { search_context_size: "low" as const },
    };
    assert.match(
        renderComponent(
            webRunTool.renderCall(webRunArgs, TEST_THEME, makeRenderContext(webRunArgs)),
        ),
        /web_run search "official TypeScript documentation handbook" • length=short • context=low/,
    );

    const imagegenTool = createImagegenTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(imagegenTool.renderCall);
    const imagegenArgs = {
        prompt: "Make a compact blue robot icon with enough descriptive words to prove the prompt is not truncated early",
        referenced_image_paths: ["input.png"],
        action: "edit",
    };
    const renderedImagegenCall = renderComponent(
        imagegenTool.renderCall(imagegenArgs, TEST_THEME, makeRenderContext(imagegenArgs)),
    );
    assert.match(renderedImagegenCall, /imagegen "Make a compact blue robot icon/);
    assert.match(renderedImagegenCall, /not truncated early"/);
    assert.doesNotMatch(renderedImagegenCall, /…/);
    assert.match(renderedImagegenCall, /refs=1 • action=edit/);

    const viewImageTool = createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(viewImageTool.renderCall);
    const viewImageArgs = {
        path: "/tmp/pi-agent/pi-codex-core/imagegen/session/latest.png",
        detail: "high" as const,
    };
    assert.match(
        renderComponent(
            viewImageTool.renderCall(viewImageArgs, TEST_THEME, makeRenderContext(viewImageArgs)),
        ),
        /view_image \/tmp\/pi-agent\/pi-codex-core\/imagegen\/session\/latest\.png • detail=high/,
    );
});

test("renders compact web_run results until expanded", () => {
    const webRunTool = createWebRunTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(webRunTool.renderResult);
    const rawOutputPath = "/tmp/pi-agent/pi-codex-core/web-run/session/call.txt";
    const output = [
        "web_run results (3 sources, compact view)",
        `Full raw Codex search output: ${rawOutputPath}`,
        "",
        "1. Extensions · Docs · Pi",
        "   URL: https://pi.dev/docs/latest/extensions",
        "   Key lines:",
        "   - Tools can provide renderCall and renderResult for custom TUI display.",
        "",
        "2. Pi Coding Agent",
        "   URL: https://pi.dev/",
        "   Key lines:",
        "   - Build a custom workflow extension.",
        "",
        "3. GitHub Docs",
        "   URL: https://github.com/earendil-works/pi",
    ].join("\n");
    const result = {
        content: [{ type: "text" as const, text: output }],
        details: {
            fullOutputPath: rawOutputPath,
            outputCharacters: output.length,
            sourceCount: 3,
        },
    };

    const compact = renderComponent(
        webRunTool.renderResult(
            result,
            { expanded: false, isPartial: false },
            TEST_THEME,
            makeRenderContext({}),
        ),
    );
    assert.match(compact, /3 sources/);
    assert.match(compact, /Extensions · Docs · Pi/);
    assert.match(compact, /https:\/\/pi\.dev\/docs\/latest\/extensions/);
    assert.match(compact, /… 1 more/);
    assert.doesNotMatch(compact, /Key lines/);

    const expanded = renderComponent(
        webRunTool.renderResult(
            result,
            { expanded: true, isPartial: false },
            TEST_THEME,
            makeRenderContext({}, undefined, { expanded: true }),
        ),
    );
    assert.match(expanded, /Key lines/);
});

test("renders viewed image fallback when inline images are hidden", () => {
    const viewImageTool = createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(viewImageTool.renderResult);
    const args = { path: "image.png" };
    const result = {
        content: [
            {
                type: "image" as const,
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
                mimeType: "image/png",
            },
        ],
        details: {
            path: "image.png",
            absolutePath: "/tmp/image.png",
            described: false,
            mimeType: "image/png",
        },
    };

    const rendered = renderComponent(
        viewImageTool.renderResult(
            result,
            { expanded: false, isPartial: false },
            TEST_THEME,
            makeRenderContext(args, { preview: null }, { showImages: false }),
        ),
    );

    assert.doesNotMatch(rendered, /Viewing image\.png/);
    assert.match(rendered, /\[Image: image\.png \[image\/png\] 1x1\]/);
});

test("renders viewed inline images when terminal images are available", () => {
    const previousCapabilities = getCapabilities();
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

    try {
        const viewImageTool = createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
        assert.ok(viewImageTool.renderResult);
        const args = { path: "image.png" };
        const result = {
            content: [
                {
                    type: "image" as const,
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
                    mimeType: "image/png",
                },
            ],
            details: {
                path: "image.png",
                absolutePath: "/tmp/image.png",
                described: false,
                mimeType: "image/png",
            },
        };

        const rendered = renderComponent(
            viewImageTool.renderResult(
                result,
                { expanded: false, isPartial: false },
                TEST_THEME,
                makeRenderContext(args, { preview: null }),
            ),
        );

        assert.ok(rendered.includes("\u001B_G"));
    } finally {
        setCapabilities(previousCapabilities);
    }
});

test("formats web_run output without Codex citation markers", () => {
    const rawOutput = [
        "Claude and Codex now available - GitHub Changelog (https://github.blog/example)",
        'citeturn1view1 [wordlim: 200] Content type: text/html; Source: open({"ref_id":"turn0search2"}); Total lines: 232',
        "L0: cite0† Skip to content ",
        "L39: Claude by Anthropic and OpenAI Codex are now available as coding agents for Copilot Business and Copilot Pro customers.",
        "L41: You can run Claude, Codex, and Copilot directly inside github.com, GitHub Mobile, and VS Code.",
    ].join("\n");

    const rawOutputPath = "/tmp/pi-agent/pi-codex-core/web-run/session/call.txt";
    const formatted = formatWebRunToolOutput(rawOutput, rawOutputPath);

    assert.equal(formatted.sourceCount, 1);
    assert.doesNotMatch(formatted.text, /cite/);
    assert.match(
        formatted.text,
        /Full raw Codex search output: \/tmp\/pi-agent\/pi-codex-core\/web-run\/session\/call\.txt/,
    );
    assert.match(formatted.text, /URL: https:\/\/github\.blog\/example/);
    assert.match(formatted.text, /L39: Claude by Anthropic/);
    assert.doesNotMatch(formatted.text, /Skip to content/);
});

test("saves web_run raw output outside workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousFetch = globalThis.fetch;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    globalThis.fetch = async () =>
        new Response(JSON.stringify({ output: "1. Pi\n   URL: https://pi.dev/" }), {
            status: 200,
        });

    try {
        await mkdir(cwd, { recursive: true });
        const webRunTool = createWebRunTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
        const result = await webRunTool.execute(
            "call/1",
            { search_query: [{ q: "Pi docs" }] },
            undefined,
            undefined,
            makeWebRunContext(cwd),
        );
        const rawOutputPath = join(agentDir, "pi-codex-core", "web-run", "session_1", "call_1.txt");

        assert.equal(result.details.fullOutputPath, rawOutputPath);
        assert.equal(
            (await readFile(rawOutputPath)).toString("utf8"),
            "1. Pi\n   URL: https://pi.dev/",
        );
        await assert.rejects(readFile(join(cwd, ".pi", "codex-core-web-run", "call_1.txt")), {
            code: "ENOENT",
        });
    } finally {
        globalThis.fetch = previousFetch;
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});

test("saves generated images outside workspace and to Codex-style archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
        await mkdir(cwd, { recursive: true });
        const base64 = Buffer.from("not really a png").toString("base64");
        const saved = await saveGeneratedImage({
            sessionId: "session/1",
            toolCallId: "call*1",
            index: 0,
            base64,
        });

        assert.equal(
            saved.path,
            join(agentDir, "pi-codex-core", "imagegen", "session_1", "call_1.png"),
        );
        assert.equal(
            saved.latestPath,
            join(agentDir, "pi-codex-core", "imagegen", "session_1", "latest.png"),
        );
        assert.equal(
            saved.archivePath,
            join(agentDir, "generated_images", "session_1", "call_1.png"),
        );
        assert.equal((await readFile(saved.absolutePath)).toString("utf8"), "not really a png");
        assert.equal(
            (await readFile(saved.latestAbsolutePath)).toString("utf8"),
            "not really a png",
        );
        assert.equal(
            (await readFile(saved.archiveAbsolutePath)).toString("utf8"),
            "not really a png",
        );
        await assert.rejects(readFile(join(cwd, "output", "imagegen", "call_1.png")), {
            code: "ENOENT",
        });
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});

test("creates native compaction using remote compaction v2", async () => {
    const previousFetch = globalThis.fetch;
    let requestUrl = "";
    let requestBody: unknown;
    let requestAccountId: string | null = null;
    globalThis.fetch = async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body)) as unknown;
        requestAccountId = new Headers(init?.headers).get("ChatGPT-Account-ID");
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_1","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    };

    try {
        const result = await handleCodexNativeCompaction(
            makeBeforeCompactEvent(),
            makeNativeCompactionContext(),
            { ...DEFAULT_CODEX_CORE_CONFIG, compaction: { enabled: true } },
        );

        assert.equal(requestUrl, "https://chatgpt.com/backend-api/codex/responses");
        assert.equal(requestAccountId, "account");
        assert.ok(isRecord(requestBody));
        assert.equal(requestBody.model, "gpt-5.5");
        assert.deepEqual((requestBody.input as unknown[]).at(-1), {
            type: "compaction_trigger",
        });
        assert.equal(result?.compaction?.details.strategy, "pi-codex-core-remote-compaction-v2");
        assert.equal(result?.compaction?.details.model, "gpt-5.5");
        assert.deepEqual(result?.compaction?.details.compactedWindow, [
            {
                role: "user",
                content: [{ type: "input_text", text: "keep this request" }],
            },
            { type: "compaction", encrypted_content: "sealed" },
        ]);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test("rewrites responses payload with native compaction window", async () => {
    const ctx = makeCompactionContext();
    const payload = {
        model: "gpt-5.4-mini",
        input: [
            { role: "developer", content: "system" },
            {
                role: "user",
                content: [{ type: "input_text", text: NATIVE_COMPACTION_SHIM_SUMMARY }],
            },
            { role: "user", content: [{ type: "input_text", text: "kept" }] },
        ],
    };

    const rewritten = await rewriteProviderRequestWithNativeCompaction(payload, ctx, {
        ...DEFAULT_CODEX_CORE_CONFIG,
        compaction: { enabled: true },
    });

    assert.deepEqual(rewritten, {
        model: "gpt-5.4-mini",
        input: [
            { role: "developer", content: "system" },
            { type: "compaction", encrypted_content: "opaque" },
            { role: "user", content: [{ type: "input_text", text: "kept" }] },
        ],
    });
});

const TEST_THEME = makeTestTheme();

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

function renderComponent(component: { render(width: number): string[] }): string {
    return component.render(200).join("\n");
}

function makeRenderContext<TArgs, TState extends object = Record<string, never>>(
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

function makeBeforeCompactEvent(): SessionBeforeCompactEvent {
    const event = {
        type: "session_before_compact",
        branchEntries: [
            {
                type: "message",
                id: "entry-1",
                parentId: null,
                timestamp: "2026-01-01T00:00:00.000Z",
                message: {
                    role: "user",
                    content: "keep this request",
                    timestamp: 0,
                },
            },
        ],
        preparation: {
            firstKeptEntryId: "entry-1",
            messagesToSummarize: [],
            turnPrefixMessages: [],
            isSplitTurn: false,
            tokensBefore: 123,
            fileOps: { readFiles: [], modifiedFiles: [] },
            settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 },
        },
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
    };
    // SAFETY: This fixture supplies the fields read by handleCodexNativeCompaction.
    return event as unknown as SessionBeforeCompactEvent;
}

function makeWebRunContext(cwd: string): ExtensionContext {
    const ctx = {
        cwd,
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.5",
            baseUrl: "https://chatgpt.com/backend-api",
        },
        modelRegistry: {
            getApiKeyAndHeaders: async () => ({
                ok: true,
                apiKey: "token",
                headers: { "chatgpt-account-id": "account" },
            }),
        },
        sessionManager: {
            getSessionId: () => "session/1",
            getBranch: () => [],
        },
    };
    // SAFETY: This test exercises web_run execution fields only.
    return ctx as unknown as ExtensionContext;
}

function makeCodexJwtAccountToken(accountId: string): string {
    const payload = Buffer.from(
        JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: accountId },
        }),
    ).toString("base64url");
    return `header.${payload}.signature`;
}

function makeNativeCompactionContext(): ExtensionContext {
    const ctx = {
        hasUI: false,
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.5",
            baseUrl: "https://chatgpt.com/backend-api",
        },
        modelRegistry: {
            getApiKeyAndHeaders: async () => ({
                ok: true,
                apiKey: makeCodexJwtAccountToken("account"),
                headers: {},
            }),
        },
        sessionManager: {
            getSessionId: () => "session-1",
        },
        getSystemPrompt: () => "system prompt",
    };
    // SAFETY: This test exercises a function that only reads these context fields.
    return ctx as unknown as ExtensionContext;
}

function makeCompactionContext(): ExtensionContext {
    const ctx = {
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.4-mini",
            baseUrl: "https://chatgpt.com/backend-api",
        },
        sessionManager: {
            getBranch: () => [
                {
                    type: "compaction",
                    details: {
                        strategy: "pi-codex-core-remote-compaction-v2",
                        provider: "openai-codex",
                        api: "openai-codex-responses",
                        model: "gpt-5.4-mini",
                        baseUrl: "https://chatgpt.com/backend-api/codex",
                        compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
                        createdAt: "2026-01-01T00:00:00.000Z",
                    },
                },
            ],
        },
    };
    // SAFETY: This test exercises a function that only reads model and sessionManager.getBranch.
    return ctx as unknown as ExtensionContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
