import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { once } from "node:events";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "vitest";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import {
    createEventBus,
    type BuildSystemPromptOptions,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerSystemPromptPreparation } from "@zigai/pi-extension-internals/prompt-preparation";
import { buildSystemPrompt } from "./pi-system-prompt.ts";
import extension, { packageName, extensionName } from "../src/index.ts";
import { DEFAULT_CODEX_CORE_CONFIG_JSON, getCodexCoreConfigPath } from "../src/config/config.ts";
import { JsonObjectDecoder } from "../src/compaction/responses-input.ts";
import type { JsonObject } from "../src/compaction/types.ts";
import { CODEX_RESPONSES_LITE_HEADER } from "../src/codex/responses-compat.ts";
import { getProviderRequestTemplate } from "../src/compaction/provider-request-template.ts";
import {
    DEFAULT_TEST_EXTENSION_MODEL,
    TEST_THEME,
    makeExtensionHarness,
    makeExtensionContext,
    testDouble,
} from "./helpers.ts";

test("exports extension metadata", () => {
    assert.equal(packageName, "pi-codex-core");
    assert.equal(extensionName, "Pi Codex Core");
});

test("registers extension handlers once per Pi API", () => {
    let registeredTools = 0;
    let registeredCommands = 0;
    let registeredRenderers = 0;
    let registeredHandlers = 0;
    const api = {
        events: createEventBus(),
        registerTool() {
            registeredTools += 1;
        },
        registerCommand() {
            registeredCommands += 1;
        },
        registerMessageRenderer() {
            registeredRenderers += 1;
        },
        on() {
            registeredHandlers += 1;
        },
        getActiveTools: () => [],
        setActiveTools() {},
        getAllTools: () => [],
    };

    const extensionApi = testDouble<ExtensionAPI>(api);
    extension(extensionApi);
    assert.ok(registeredTools > 0, "first activation registers tools");
    assert.ok(registeredCommands > 0, "first activation registers commands");
    assert.ok(registeredRenderers > 0, "first activation registers message renderers");
    assert.ok(registeredHandlers > 0, "first activation registers event handlers");
    const countsAfterFirstActivation = {
        registeredTools,
        registeredCommands,
        registeredRenderers,
        registeredHandlers,
    };

    extension(extensionApi);

    assert.deepEqual(
        { registeredTools, registeredCommands, registeredRenderers, registeredHandlers },
        countsAfterFirstActivation,
    );
});

test("model selection resynchronizes tool activation for the newly selected model", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-model-select-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const configPath = getCodexCoreConfigPath(agentDir);
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, JSON.stringify({ tools: { applyPatch: "openai" } }));
        const harness = makeExtensionHarness(["edit"]);
        extension(harness.api);
        const ctx = makeExtensionContext("/workspace", false, {
            ...DEFAULT_TEST_EXTENSION_MODEL,
            provider: "anthropic",
            api: "anthropic-messages",
            id: "claude-sonnet-4",
        });

        await harness.startSession(ctx);
        assert.deepEqual(harness.activeTools, ["edit"]);

        Object.defineProperty(ctx, "model", {
            configurable: true,
            value: DEFAULT_TEST_EXTENSION_MODEL,
        });
        await harness.selectModel(ctx);
        assert.deepEqual(harness.activeTools, ["web_run", "imagegen", "view_image", "apply_patch"]);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});

test("input lifecycle holds follow-ups and merges them into the next manual message", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-input-recovery-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const configPath = getCodexCoreConfigPath(agentDir);
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(
            configPath,
            JSON.stringify({
                compaction: { auto: false },
                recovery: { batchFollowUps: true },
            }),
        );
        const harness = makeExtensionHarness();
        extension(harness.api);
        const ctx = makeExtensionContext("/workspace", false);
        Object.defineProperty(ctx, "mode", { configurable: true, value: "tui" });
        await harness.startSession(ctx);

        const held = await harness.submitInput(
            {
                type: "input",
                source: "user",
                text: "  inspect the logs  ",
                images: [],
                streamingBehavior: "followUp",
            },
            ctx,
        );
        await harness.endMessage(
            {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: "invalid api key",
                timestamp: 0,
            },
            ctx,
        );
        await harness.settleAgent(ctx);
        await harness.endAgent([], ctx);
        const merged = await harness.submitInput(
            {
                type: "input",
                source: "user",
                text: "Continue",
                images: [],
                streamingBehavior: undefined,
            },
            ctx,
        );
        assert.deepEqual(held, { action: "handled" });
        assert.deepEqual(merged, {
            action: "transform",
            text: "Apply these previously queued updates together, in order:\n\n1. inspect the logs\n\nLatest user message:\n\nContinue",
        });
        assert.equal(harness.appendedEntries.length, 3);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});

test.each(["new", "resume", "fork"] as const)(
    "delegates tool policy after a non-final %s session shutdown and start",
    async (reason) => {
        const root = await mkdtemp(join(tmpdir(), "pi-codex-core-coordination-lifecycle-"));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const ctx = makeExtensionContext(join(root, "project"), false);
        const harness = makeExtensionHarness(["read", "edit"]);
        try {
            const agentDir = join(root, "agent");
            process.env.PI_CODING_AGENT_DIR = agentDir;
            const configPath = getCodexCoreConfigPath(agentDir);
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(
                configPath,
                JSON.stringify({
                    tools: { applyPatch: "openai" },
                    compaction: { enabled: false },
                }),
            );
            const proposals: unknown[] = [];
            harness.events.on("pi-toggles:set-activation-proposal", (value) => {
                proposals.push(value);
                harness.events.emit("pi-toggles:activation-proposal-accepted", {
                    version: 1,
                    sessionId: ctx.sessionManager.getSessionId(),
                    owner: packageName,
                });
            });

            extension(harness.api);
            harness.events.emit("pi-toggles:activation-ready", {
                version: 1,
                sessionId: ctx.sessionManager.getSessionId(),
            });
            await harness.startSession(ctx);
            assert.deepEqual(harness.activeTools, ["read", "edit"]);
            assert.equal(proposals.length, 1);
            await harness.shutdownSession(reason, ctx);
            harness.events.emit("pi-toggles:activation-ready", {
                version: 1,
                sessionId: ctx.sessionManager.getSessionId(),
            });

            assert.equal(proposals.length, 1, "shutdown clears the prior session proposal");
            await harness.startSession(ctx);
            assert.deepEqual(harness.activeTools, ["read", "edit"]);
            assert.equal(proposals.length, 2);
        } finally {
            await harness.shutdownSession("quit", ctx);

            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

            await rm(root, { recursive: true, force: true });
        }
    },
);

test("session shutdown releases Pi Toggles lifecycle subscriptions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-shutdown-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = join(root, "agent");
        const harness = makeExtensionHarness();
        let proposals = 0;
        harness.events.on("pi-toggles:set-activation-proposal", () => {
            proposals += 1;
        });

        extension(harness.api);
        const ctx = makeExtensionContext("/workspace", false);
        await harness.startSession(ctx);
        harness.events.emit("pi-toggles:activation-ready", {
            version: 1,
            sessionId: "extension-session",
        });

        assert.equal(proposals, 1);
        await harness.shutdownSession("quit", ctx);
        harness.events.emit("pi-toggles:activation-ready", {
            version: 1,
            sessionId: "extension-session",
        });

        assert.equal(proposals, 1);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});

test("apply_patch replaces edit when enabled for OpenAI-like models", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-tools-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const globalConfigPath = getCodexCoreConfigPath(agentDir);
        await mkdir(join(globalConfigPath, ".."), { recursive: true });
        await writeFile(globalConfigPath, JSON.stringify({ tools: { applyPatch: "openai" } }));

        const harness = makeExtensionHarness(["read", "edit", "bash"]);
        extension(harness.api);
        await harness.startSession(makeExtensionContext(cwd, true));
        assert.ok(harness.activeTools.includes("apply_patch"));
        assert.equal(harness.activeTools.includes("edit"), false);
        await writeFile(globalConfigPath, JSON.stringify({ tools: { applyPatch: "off" } }));
        await harness.startSession(makeExtensionContext(cwd, true));
        assert.equal(harness.activeTools.includes("apply_patch"), false);
        assert.ok(harness.activeTools.includes("edit"));
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});

test("delegates tool activation defaults to Pi Toggles without mutating active tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-toggles-activation-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const globalConfigPath = getCodexCoreConfigPath(agentDir);
        await mkdir(dirname(globalConfigPath), { recursive: true });
        await writeFile(globalConfigPath, JSON.stringify({ tools: { applyPatch: "openai" } }));

        const harness = makeExtensionHarness(["read", "edit", "bash"]);
        const proposals: unknown[] = [];
        harness.events.on("pi-toggles:set-activation-proposal", (value) => {
            proposals.push(value);
            harness.events.emit("pi-toggles:activation-proposal-accepted", {
                version: 1,
                sessionId: "extension-session",
                owner: packageName,
            });
        });

        extension(harness.api);
        harness.events.emit("pi-toggles:activation-ready", {
            version: 1,
            sessionId: "extension-session",
        });

        await harness.startSession(makeExtensionContext(cwd, true));
        assert.deepEqual(harness.activeTools, ["read", "edit", "bash"]);
        assert.equal(proposals.length, 1);
        const proposal = proposals[0];
        assert.ok(isRecord(proposal));
        assert.equal(proposal.owner, packageName);
        assert.ok(Array.isArray(proposal.decisions));
        assert.ok(
            proposal.decisions.some(
                (decision) =>
                    JSON.stringify(decision) ===
                    JSON.stringify({
                        target: { kind: "tool", name: "apply_patch" },
                        state: "on",
                    }),
            ),
        );
        assert.ok(
            proposal.decisions.some(
                (decision) =>
                    JSON.stringify(decision) ===
                    JSON.stringify({ target: { kind: "tool", name: "edit" }, state: "off" }),
            ),
        );
    } finally {
        if (previousAgentDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }

        await rm(root, { recursive: true, force: true });
    }
});

test("apply_patch all mode replaces edit for non-OpenAI models", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-all-tools-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const globalConfigPath = getCodexCoreConfigPath(agentDir);
        await mkdir(join(globalConfigPath, ".."), { recursive: true });
        await writeFile(globalConfigPath, JSON.stringify({ tools: { applyPatch: "all" } }));

        const harness = makeExtensionHarness(["read", "edit", "bash"]);
        extension(harness.api);
        await harness.startSession(
            makeExtensionContext(cwd, true, {
                provider: "anthropic",
                api: "anthropic-messages",
                id: "claude-sonnet",
                baseUrl: "https://api.anthropic.com",
                input: ["text"],
            }),
        );

        assert.ok(harness.activeTools.includes("apply_patch"));
        assert.equal(harness.activeTools.includes("edit"), false);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});

test("shows a scrollable startup warning when fast mode is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-fast-warning-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const configPath = getCodexCoreConfigPath(agentDir);
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(
            configPath,
            JSON.stringify({
                ...DEFAULT_CODEX_CORE_CONFIG_JSON,
                openai: { ...DEFAULT_CODEX_CORE_CONFIG_JSON.openai, fast: true },
            }),
        );

        const notifications: Array<{ readonly message: string; readonly type: string }> = [];
        const ctx = makeStartupWarningContext((message, type) => {
            notifications.push({ message, type });
        });
        const harness = makeExtensionHarness();
        extension(harness.api);

        await harness.startSession(ctx);

        assert.deepEqual(notifications, [
            {
                message:
                    "Fast mode is enabled: supported Codex calls prioritize speed, with higher credit usage that varies by model and pricing.",
                type: "warning",
            },
        ]);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});

function isRecord<Value>(value: Value): value is Value & JsonObject {
    return JsonObjectDecoder.decode(value) !== undefined;
}

function makeStartupWarningContext(
    onNotify: (message: string, type: string) => void,
): ExtensionContext {
    const baseContext = makeExtensionContext("/workspace", true);
    const context = {
        ...baseContext,
        hasUI: true,
        mode: "tui",
        ui: {
            theme: TEST_THEME,
            setStatus() {},
            notify: onNotify,
        },
    };

    return testDouble<ExtensionContext>(context);
}

test("applies GPT-5.6 Responses Lite compatibility through extension hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-responses-lite-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = join(root, "agent");
        const harness = makeExtensionHarness();
        extension(harness.api);
        const ctx = makeExtensionContext(
            "/workspace",
            true,
            {
                ...DEFAULT_TEST_EXTENSION_MODEL,
                id: "gpt-5.6-terra",
                contextWindow: 240_000,
            },
            { agentActive: true },
        );

        const headers: Record<string, string | null> = {};

        await harness.startSession(ctx);
        await harness.prepareProviderHeaders(headers, ctx);
        const rewritten = await harness.rewriteProviderRequest(
            {
                model: "gpt-5.6-terra",
                instructions: "Pi system prompt",
                input: [{ role: "user", content: "hello" }],
            },
            ctx,
        );

        assert.equal(headers[CODEX_RESPONSES_LITE_HEADER], "true");
        assert.equal(ctx.model?.contextWindow, 240_000);
        assert.ok(isRecord(rewritten));
        assert.equal(Object.hasOwn(rewritten, "instructions"), false);
        assert.equal(rewritten.parallel_tool_calls, false);
        assert.deepEqual(rewritten.reasoning, { effort: "medium", context: "all_turns" });
        const template = getProviderRequestTemplate(
            "extension-session",
            "gpt-5.6-terra",
            "responses-lite",
        );
        assert.equal(template?.instructions, "Pi system prompt");
        assert.equal(JSON.stringify(template).includes("hello"), false);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});

test("does not opt Pi internal summarization into Responses Lite", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-responses-summary-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const configPath = getCodexCoreConfigPath(agentDir);
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(
            configPath,
            JSON.stringify({
                ...DEFAULT_CODEX_CORE_CONFIG_JSON,
                compaction: { ...DEFAULT_CODEX_CORE_CONFIG_JSON.compaction, enabled: false },
            }),
        );
        const harness = makeExtensionHarness();
        extension(harness.api);
        const ctx = makeExtensionContext("/workspace", true, {
            ...DEFAULT_TEST_EXTENSION_MODEL,
            id: "gpt-5.6-sol",
        });

        const headers: Record<string, string | null> = {};

        await harness.startSession(ctx);
        await harness.beginCompaction(ctx);
        await harness.prepareProviderHeaders(headers, ctx);
        assert.equal(headers[CODEX_RESPONSES_LITE_HEADER], undefined);
        await harness.finishCompaction(ctx);
        await harness.prepareProviderHeaders(headers, ctx);
        assert.equal(headers[CODEX_RESPONSES_LITE_HEADER], "true");
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});

test("clears Pi fallback request policy after a cancelled compaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-compaction-cancel-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = join(root, "agent");
        const configPath = getCodexCoreConfigPath();
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, JSON.stringify({ compaction: { enabled: false } }));
        const harness = makeExtensionHarness();
        extension(harness.api);
        const ctx = makeExtensionContext(root, false, {
            ...DEFAULT_TEST_EXTENSION_MODEL,
            id: "gpt-5.6-sol",
        });
        await harness.startSession(ctx);
        await harness.beginCompaction(ctx);
        await harness.failCompaction(ctx);
        const headers: Record<string, string | null> = {};
        await harness.prepareProviderHeaders(headers, ctx);
        assert.equal(headers[CODEX_RESPONSES_LITE_HEADER], "true");
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});

test("routes unexpected native compaction failures through Pi fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-compaction-error-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = join(root, "agent");
        const harness = makeExtensionHarness();
        extension(harness.api);
        const ctx = makeExtensionContext(root, false, {
            ...DEFAULT_TEST_EXTENSION_MODEL,
            id: "gpt-5.6-sol",
            contextWindow: 372_000,
        });

        await harness.startSession(ctx);
        const result = await harness.beginCompaction(ctx);

        const headers: Record<string, string | null> = {};
        await harness.prepareProviderHeaders(headers, ctx);
        assert.equal(result, undefined);
        assert.equal(headers[CODEX_RESPONSES_LITE_HEADER], undefined);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});

test.each([
    {
        modelId: "gpt-6.1-sol",
        provider: "openai-codex",
        api: "openai-codex-responses",
        fast: true,
        expectedTier: "priority",
    },
    {
        modelId: "gpt-5.5",
        provider: "openai-codex",
        api: "openai-codex-responses",
        fast: true,
        expectedTier: "priority",
    },
    {
        modelId: "gpt-5.4-mini",
        provider: "openai-codex",
        api: "openai-codex-responses",
        fast: true,
        expectedTier: undefined,
    },
    {
        modelId: "gpt-5.5",
        provider: "openai-codex",
        api: "openai-codex-responses",
        fast: false,
        expectedTier: undefined,
    },
    {
        modelId: "gpt-6.1-sol",
        provider: "openai",
        api: "openai-responses",
        fast: true,
        expectedTier: "priority",
    },
    {
        modelId: "other-model",
        provider: "other",
        api: "openai-responses",
        fast: true,
        expectedTier: undefined,
    },
])(
    "applies Fast mode to supported ordinary $provider/$modelId requests when enabled=$fast",
    async ({ modelId, provider, api, fast, expectedTier }) => {
        const root = await mkdtemp(join(tmpdir(), "pi-codex-core-fast-"));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        try {
            const agentDir = join(root, "agent");
            process.env.PI_CODING_AGENT_DIR = agentDir;
            const configPath = getCodexCoreConfigPath(agentDir);
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(configPath, JSON.stringify({ openai: { fast } }));
            const harness = makeExtensionHarness();
            extension(harness.api);
            const ctx = testDouble<ExtensionContext>({
                ...makeExtensionContext("/workspace", true, {
                    ...DEFAULT_TEST_EXTENSION_MODEL,
                    id: modelId,
                    provider,
                    api,
                }),
                ui: { notify() {} },
            });
            await harness.startSession(ctx);
            const payload = {
                model: modelId,
                instructions: "system instructions",
                input: [{ role: "user", content: "hello" }],
                reasoning: { effort: "high" },
            };
            const rewritten = await harness.rewriteProviderRequest(payload, ctx);
            assert.equal(rewritten?.service_tier, expectedTier);
            const effective = rewritten ?? payload;
            assert.equal(JsonObjectDecoder.decode(effective.reasoning)?.effort, "high");
        } finally {
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

            await rm(root, { recursive: true, force: true });
        }
    },
);

test.each(["default", undefined, "flex"])(
    "Fast mode prices ordinary Codex requests using the requested tier when response tier is %s",
    async (responseTier) => {
        const root = await mkdtemp(join(tmpdir(), "pi-codex-core-fast-pricing-"));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const harness = makeExtensionHarness();
        const provider = openaiCodexProvider();
        const originalStream = Object.getOwnPropertyDescriptor(provider, "stream");
        const originalSimple = Object.getOwnPropertyDescriptor(provider, "streamSimple");
        const catalogModel = provider.getModels().find((model) => model.id === "gpt-5.5");
        assert.ok(catalogModel);
        const model = {
            ...catalogModel,
            cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 2 },
        };
        const ctx = testDouble<ExtensionContext>({
            ...makeExtensionContext(root, false, model),
            modelRegistry: { getProvider: () => provider },
        });
        try {
            process.env.PI_CODING_AGENT_DIR = join(root, "agent");
            const configPath = getCodexCoreConfigPath();
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(
                configPath,
                JSON.stringify({
                    compaction: { enabled: false },
                    openai: { fast: true },
                }),
            );
            extension(harness.api);
            await harness.startSession(ctx);
            await harness.selectModel(ctx);
            const options = {
                apiKey: `header.${Buffer.from(
                    JSON.stringify({
                        "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
                    }),
                ).toString("base64url")}.signature`,
                transport: "sse" as const,
                onPayload: async (payload) =>
                    harness.rewriteProviderRequest(JsonObjectDecoder.Parse(payload), ctx),
                fetch: async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                    const bytes = Buffer.from(testDouble<Uint8Array>(init?.body));
                    const payload = JsonObjectDecoder.Parse(
                        JSON.parse(zstdDecompressSync(bytes).toString()),
                    );
                    assert.equal(payload.service_tier, "priority");
                    return new Response(
                        `data: ${JSON.stringify({
                            type: "response.completed",
                            response: {
                                status: "completed",
                                output: [],
                                service_tier: responseTier,
                                usage: {
                                    input_tokens: 1000,
                                    output_tokens: 100,
                                    input_tokens_details: { cached_tokens: 200 },
                                },
                            },
                        })}\n\n`,
                        { headers: { "content-type": "text/event-stream" } },
                    );
                },
            } satisfies SimpleStreamOptions;
            const result = await provider
                .streamSimple(
                    model,
                    normalizeContext({
                        messages: [{ role: "user", content: "hello", timestamp: 0 }],
                    }),
                    options,
                )
                .result();
            assert.equal(result.stopReason, "stop", result.errorMessage);
            let expected = { input: 0.002, output: 0.001, cacheRead: 0.00005, cacheWrite: 0 };
            if (responseTier === "flex")
                expected = { input: 0.0004, output: 0.0002, cacheRead: 0.00001, cacheWrite: 0 };

            for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const)
                assert.ok(
                    Math.abs(result.usage.cost[field] - expected[field]) < 1e-12,
                    `${field}: ${result.usage.cost[field]} instead of ${expected[field]}`,
                );

            assert.ok(
                Math.abs(
                    result.usage.cost.total -
                        (expected.input + expected.output + expected.cacheRead),
                ) < 1e-12,
            );
            assert.equal(Object.hasOwn(options, "serviceTier"), false);
        } finally {
            await harness.shutdownSession("quit", ctx);

            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

            await rm(root, { recursive: true, force: true });
            assert.deepEqual(Object.getOwnPropertyDescriptor(provider, "stream"), originalStream);
            assert.deepEqual(
                Object.getOwnPropertyDescriptor(provider, "streamSimple"),
                originalSimple,
            );
        }
    },
);

test.each([
    { level: "minimal", mapped: "low", active: false },
    { level: "minimal", mapped: "high", active: false },
    { level: "off", mapped: "low", active: true },
    { level: undefined, mapped: "medium", active: false },
])(
    "compaction role maps $level through the selected model to $mapped (active=$active)",
    async ({ level, mapped, active }) => {
        const root = await mkdtemp(join(tmpdir(), "pi-codex-core-role-reasoning-"));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        let request: JsonObject | undefined;
        const notices: string[] = [];
        const server = createServer((incoming, response) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
            });

            incoming.on("end", () => {
                const bytes = Buffer.concat(chunks);
                let text = bytes.toString();
                if (incoming.headers["content-encoding"] === "zstd")
                    text = zstdDecompressSync(bytes).toString();

                request = JsonObjectDecoder.Parse(JSON.parse(text));
                response.end(
                    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"compacted"}}\n\n',
                );
            });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = Compile(
            Type.Object({ port: Type.Number() }, { additionalProperties: true }),
        ).Parse(server.address());
        const harness = makeExtensionHarness();
        const targetModel = {
            ...DEFAULT_TEST_EXTENSION_MODEL,
            id: "gpt-5.4",
            baseUrl: `http://127.0.0.1:${address.port}`,
            reasoning: true,
            thinkingLevelMap: { minimal: mapped, off: "low" },
        };
        let model = { ...targetModel, id: "gpt-5.5" };
        if (active) model = targetModel;

        const ctx = testDouble<ExtensionContext>({
            ...makeExtensionContext(root, false, model),
            getSystemPrompt: () => "System instructions",
            hasUI: true,
            ui: {
                notify: (message: string) => {
                    notices.push(message);
                },
            },
            modelRegistry: {
                getProvider: () => undefined,
                find: (_provider: string, id: string) => {
                    if (id === targetModel.id) return targetModel;
                    return undefined;
                },
                getApiKeyAndHeaders: async () => ({
                    ok: true,
                    apiKey: "test-key",
                    headers: { "chatgpt-account-id": "test-account" },
                }),
            },
        });
        try {
            process.env.PI_CODING_AGENT_DIR = join(root, "agent");
            harness.events.on("pi-toggles:model-role", (value) => {
                const request = Compile(
                    Type.Object(
                        { accept: Type.Function([Type.Unknown()], Type.Void()) },
                        { additionalProperties: true },
                    ),
                ).Parse(value);
                request.accept({
                    status: "resolved",
                    model: {
                        provider: "openai-codex",
                        modelId: targetModel.id,
                        thinkingLevel: level,
                    },
                });
            });

            extension(harness.api);
            await harness.startSession(ctx);
            const result = await harness.beginCompaction(ctx);
            assert.ok(result?.compaction, JSON.stringify({ result, notices, request }));
            assert.ok(request);
            assert.equal(request.model, targetModel.id);
            assert.equal(JsonObjectDecoder.Parse(request.reasoning).effort, mapped);
        } finally {
            await harness.shutdownSession("quit", ctx);
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
                server.close((cause) => {
                    if (cause) reject(cause);
                    else resolve();
                });
            });

            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

            await rm(root, { recursive: true, force: true });
        }
    },
);

test("suppresses reasoning traces only for GPT Responses models", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-reasoning-traces-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const configPath = getCodexCoreConfigPath(agentDir);
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(
            configPath,
            JSON.stringify({
                ...DEFAULT_CODEX_CORE_CONFIG_JSON,
                openai: {
                    ...DEFAULT_CODEX_CORE_CONFIG_JSON.openai,
                    showReasoningTraces: false,
                },
            }),
        );

        const harness = makeExtensionHarness();
        extension(harness.api);
        const gptContext = makeExtensionContext("/workspace", true, {
            ...DEFAULT_TEST_EXTENSION_MODEL,
            id: "gpt-6-astra",
        });
        await harness.startSession(gptContext);
        const headers: Record<string, string | null> = {};
        await harness.prepareProviderHeaders(headers, gptContext);
        assert.equal(headers[CODEX_RESPONSES_LITE_HEADER], "true");

        const rewritten = await harness.rewriteProviderRequest(
            {
                model: "gpt-6-astra",
                input: [{ role: "user", content: "hello" }],
                reasoning: { effort: "high", summary: "auto" },
            },
            gptContext,
        );

        assert.ok(isRecord(rewritten));
        assert.deepEqual(rewritten.reasoning, { effort: "high", context: "all_turns" });

        const nonGptContext = makeExtensionContext("/workspace", true, {
            ...DEFAULT_TEST_EXTENSION_MODEL,
            id: "o3",
        });
        await harness.startSession(nonGptContext);
        assert.equal(
            await harness.rewriteProviderRequest(
                {
                    model: "o3",
                    input: [{ role: "user", content: "hello" }],
                    reasoning: { effort: "high", summary: "auto" },
                },
                nonGptContext,
            ),
            undefined,
        );
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});

test.each(["active", "replaced", "shutdown"] as const)(
    "prompt preparation rejection cancels only its %s session owner",
    async (owner) => {
        const root = await mkdtemp(join(tmpdir(), "pi-codex-core-preparation-"));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const harness = makeExtensionHarness();
        const ctx = makeExtensionContext("/workspace", false);
        let cancellations = 0;
        Object.defineProperty(ctx, "abort", {
            value: () => {
                cancellations += 1;
            },
        });
        let enter!: () => void;
        let rejectPreparation!: (cause: Error) => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        const preparation = new Promise<void>((_resolve, reject) => {
            rejectPreparation = reject;
        });
        const cause = new Error("Preparation rejected");
        const unregister = registerSystemPromptPreparation(harness.events, async () => {
            enter();
            return preparation;
        });
        try {
            process.env.PI_CODING_AGENT_DIR = join(root, "agent");
            const configPath = getCodexCoreConfigPath();
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(configPath, JSON.stringify({ compaction: { enabled: false } }));
            extension(harness.api);
            await harness.startSession(ctx);
            const operation = harness.prepareSystemPrompt("Initial prompt", { cwd: ctx.cwd }, ctx);
            const rejected = assert.rejects(operation, (error) => error === cause);
            await entered;

            if (owner === "replaced") await harness.startSession(ctx);
            if (owner === "shutdown") await harness.shutdownSession("quit", ctx);
            rejectPreparation(cause);
            await rejected;
            assert.equal(cancellations, owner === "active" ? 1 : 0);
        } finally {
            unregister();
            await harness.shutdownSession("quit", ctx);

            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

            await rm(root, { recursive: true, force: true });
        }
    },
);

test("does not publish a prompt from preparation completed after session replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-preparation-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const harness = makeExtensionHarness();
    const ctx = makeExtensionContext("/workspace", false);
    let enter!: () => void;
    let finishPreparation!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    const preparation = new Promise<void>((resolve) => {
        finishPreparation = resolve;
    });
    const unregister = registerSystemPromptPreparation(harness.events, async () => {
        enter();
        return preparation;
    });
    try {
        process.env.PI_CODING_AGENT_DIR = join(root, "agent");
        const configPath = getCodexCoreConfigPath();
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, JSON.stringify({ compaction: { enabled: false } }));
        extension(harness.api);
        await harness.startSession(ctx);
        const operation = harness.prepareSystemPrompt("Initial prompt", { cwd: ctx.cwd }, ctx);
        await entered;
        await harness.startSession(ctx);
        finishPreparation();
        assert.equal(await operation, "Initial prompt");
    } finally {
        unregister();
        await harness.shutdownSession("quit", ctx);

        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});

test("extension prompt hook follows the selected GPT model", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-model-prompt-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = join(root, "agent");
        const configPath = getCodexCoreConfigPath();
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(
            configPath,
            JSON.stringify({
                ...DEFAULT_CODEX_CORE_CONFIG_JSON,
                prompt: { mode: "codex" },
            }),
        );
        const harness = makeExtensionHarness();
        extension(harness.api);
        const options: BuildSystemPromptOptions = {
            cwd: "/workspace",
            selectedTools: ["read", "bash", "edit"],
            toolSnippets: {
                read: "Read files.",
                bash: "Run shell commands.",
                edit: "Edit files.",
            },
        };
        const terraPrompt = await harness.prepareSystemPrompt(
            "Pi system prompt",
            options,
            makeExtensionContext("/workspace", true, {
                ...DEFAULT_TEST_EXTENSION_MODEL,
                id: "gpt-5.6-terra",
            }),
        );
        const solPrompt = await harness.prepareSystemPrompt(
            "Pi system prompt",
            options,
            makeExtensionContext("/workspace", true, {
                ...DEFAULT_TEST_EXTENSION_MODEL,
                id: "gpt-6-sol",
            }),
        );
        const lunaPrompt = await harness.prepareSystemPrompt(
            "Pi system prompt",
            options,
            makeExtensionContext("/workspace", true, {
                ...DEFAULT_TEST_EXTENSION_MODEL,
                id: "gpt-6-luna",
            }),
        );
        const gpt55Prompt = await harness.prepareSystemPrompt(
            "Pi system prompt",
            options,
            makeExtensionContext("/workspace", true),
        );

        assert.match(terraPrompt, /^You are Codex, an agent based on GPT-5/);
        assert.doesNotMatch(terraPrompt, /## Engineering judgment/);
        assert.match(solPrompt, /^You are Codex, an agent based on GPT-6/);
        assert.match(solPrompt, /Once evidence in a session supports authorization/);
        assert.match(lunaPrompt, /^You are Codex, an agent based on GPT-6/);
        assert.match(lunaPrompt, /Do not add or run tests unless the user asks/);
        assert.match(gpt55Prompt, /## Engineering judgment/);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});

test("warns only once for a replacement, never for Pi's structured prompt or an append", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-prompt-conflict-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = join(root, "agent");
        const configPath = getCodexCoreConfigPath();
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(
            configPath,
            JSON.stringify({
                ...DEFAULT_CODEX_CORE_CONFIG_JSON,
                prompt: { ...DEFAULT_CODEX_CORE_CONFIG_JSON.prompt, mode: "codex" },
            }),
        );
        const notifications: Array<{ readonly message: string; readonly type: string }> = [];
        const ctx = makeStartupWarningContext((message, type) => {
            notifications.push({ message, type });
        });
        const harness = makeExtensionHarness();
        extension(harness.api);
        await harness.startSession(ctx);
        const baseOptions: BuildSystemPromptOptions = {
            cwd: "/workspace",
            selectedTools: ["read"],
            toolGuidelines: { read: ["Read the relevant files first."] },
            sections: { workflow: "Keep workflow instructions." },
        };
        const basePrompt = buildSystemPrompt(baseOptions);
        const prepared = await harness.prepareSystemPrompt(basePrompt, baseOptions, ctx);
        assert.match(prepared, /Read the relevant files first/);
        assert.match(prepared, /Keep workflow instructions/);
        const appended = `${basePrompt}\n\nEarlier extension append.`;
        const appendedResult = await harness.prepareSystemPrompt(
            appended,
            { ...baseOptions, forceSystemPrompt: appended },
            ctx,
        );
        assert.match(appendedResult, /Earlier extension append/);
        assert.equal(notifications.length, 0);
        const replacedPrompt = "Earlier extension replacement.";
        const options: BuildSystemPromptOptions = {
            cwd: "/workspace",
            forceSystemPrompt: replacedPrompt,
        };

        await harness.prepareSystemPrompt(replacedPrompt, options, ctx);
        await harness.prepareSystemPrompt(replacedPrompt, options, ctx);
        assert.equal(notifications.length, 1);
        const notification = notifications[0];
        assert.ok(notification);
        assert.equal(notification.type, "warning");
        assert.match(notification.message, /could not safely merge/);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

        await rm(root, { recursive: true, force: true });
    }
});
