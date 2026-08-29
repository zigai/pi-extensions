import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "vitest";
import {
    createEventBus,
    type BuildSystemPromptOptions,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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

    const extensionApi = testDouble<ExtensionAPI>()(api);
    extension(extensionApi);
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
                    "Fast mode is enabled: supported Codex calls can deliver up to 1.5x faster token velocity, with higher credit usage that varies by model and pricing.",
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
    return testDouble<ExtensionContext>()(context);
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
            id: "gpt-5.6-terra",
        });
        await harness.startSession(gptContext);

        const rewritten = await harness.rewriteProviderRequest(
            {
                model: "gpt-5.6-terra",
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
        const gpt55Prompt = await harness.prepareSystemPrompt(
            "Pi system prompt",
            options,
            makeExtensionContext("/workspace", true),
        );

        assert.match(terraPrompt, /^You are Codex, an agent based on GPT-5/);
        assert.doesNotMatch(terraPrompt, /## Engineering judgment/);
        assert.match(gpt55Prompt, /## Engineering judgment/);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});

test("warns once when an earlier extension fully replaces the system prompt", async () => {
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
        const options: BuildSystemPromptOptions = { cwd: "/workspace" };
        const replacedPrompt =
            "Earlier extension replacement.\nCurrent working directory: /workspace";

        await harness.prepareSystemPrompt(replacedPrompt, options, ctx);
        await harness.prepareSystemPrompt(replacedPrompt, options, ctx);

        assert.equal(notifications.length, 1);
        assert.equal(notifications[0]?.type, "warning");
        assert.match(notifications[0]?.message ?? "", /could not safely merge/);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});
