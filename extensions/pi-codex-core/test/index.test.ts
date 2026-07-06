import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import assert from "node:assert/strict";
import { test } from "vitest";

import {
    initTheme,
    type BuildSystemPromptOptions,
    type ExtensionAPI,
    type ExtensionContext,
    type SessionBeforeCompactEvent,
    type Skill,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";

import extension, { packageName, extensionName } from "../src/index.ts";
import { codexToolProviderHeaders, resolveCodexToolProvider } from "../src/codex-auth.ts";
import { registerCodexCommand } from "../src/codex-command.ts";
import { openCodexSettingsScreen } from "../src/codex-settings-ui.ts";
import { buildCodexCoreSystemPrompt } from "../src/prompt.ts";
import {
    CODEX_CURRENT_MODEL_SELECTION,
    DEFAULT_CODEX_CORE_CONFIG,
    DEFAULT_CODEX_CORE_CONFIG_JSON,
    codexCoreConfigJsonSchema,
    getCodexCoreConfigPath,
    getCodexCoreGlobalConfigSchemaPath,
    getCodexCoreProjectConfigPath,
    parseCodexCoreConfig,
    readCodexCoreConfig,
    resolveCodexRequestModel,
} from "../src/config.ts";
import {
    cancelScheduledCodexAutoCompaction,
    handleCodexNativeCompaction,
    NATIVE_COMPACTION_SHIM_SUMMARY,
    rewriteProviderRequestWithNativeCompaction,
    scheduleCodexAutoCompaction,
} from "../src/compaction.ts";
import {
    MAX_INPUT_IMAGE_BYTES,
    codexPromptImageTargetDimensions,
    loadImageContent,
    saveGeneratedImage,
} from "../src/image-content.ts";
import { createImagegenTool } from "../src/tools/imagegen.ts";
import {
    clearDeferredViewImagesForSession,
    createViewImageTool,
    rewriteProviderRequestWithDeferredViewImages,
} from "../src/tools/view-image.ts";
import { formatWebRunToolOutput } from "../src/tools/web-run-output.ts";
import { createWebRunTool } from "../src/tools/web-run.ts";
import { Redacted } from "../src/redacted.ts";
import type { CodexRuntime, ScheduledTask } from "../src/runtime.ts";
import {
    countCodexTextTokens,
    shutdownCodexTokenizer,
    truncateCodexTextToTokenBudget,
    warmCodexTokenizer,
} from "../src/tokenizer.ts";
import {
    fetchCodexUsage,
    formatCodexUsage,
    parseCodexRateLimitResetCreditsPayload,
    parseCodexUsagePayload,
} from "../src/usage.ts";

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

    // SAFETY: This fixture implements only extension registration members used during activation.
    const extensionApi = api as unknown as ExtensionAPI;
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

test("parses codex config with safe defaults", () => {
    const config = parseCodexCoreConfig({
        scope: { tools: "all" },
        tools: { webSearch: false, viewImageDescriptions: true },
        prompt: { mode: "codex" },
        compaction: { enabled: true, auto: false, thresholdPercent: 90 },
        openai: { verbosity: "high", compactionReasoning: "low" },
    });

    assert.equal(config.scope.tools, "all");
    assert.equal(config.tools.webSearch, false);
    assert.equal(config.tools.imageGeneration, DEFAULT_CODEX_CORE_CONFIG.tools.imageGeneration);
    assert.equal(config.tools.viewImageDescriptions, true);
    assert.equal(config.tools.applyPatch, "off");
    assert.equal(config.prompt.mode, "codex");
    assert.equal(config.compaction.enabled, true);
    assert.equal(config.compaction.auto, false);
    assert.equal(config.compaction.thresholdPercent, 90);
    assert.equal(parseCodexCoreConfig({}).compaction.thresholdPercent, 80);
    assert.equal(parseCodexCoreConfig({}).openai.compactionReasoning, "medium");
    assert.equal(
        parseCodexCoreConfig({ openai: { verbosity: "high" } }).openai.compactionModel,
        CODEX_CURRENT_MODEL_SELECTION,
    );
    assert.equal(config.openai.webSearchModel, CODEX_CURRENT_MODEL_SELECTION);
    assert.equal(config.openai.imageDescriptionModel, CODEX_CURRENT_MODEL_SELECTION);
    assert.equal(config.openai.compactionModel, CODEX_CURRENT_MODEL_SELECTION);
    assert.equal(config.openai.verbosity, "high");
    assert.equal(config.openai.compactionReasoning, "low");
});

test("reads codex config as optional defaults and scaffolds global files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-config-"));
    try {
        const agentDir = join(root, "agent");
        const config = readCodexCoreConfig({ agentDir });

        assert.deepEqual(config, DEFAULT_CODEX_CORE_CONFIG);
        assert.deepEqual(
            JSON.parse(await readFile(getCodexCoreConfigPath(agentDir), "utf8")),
            DEFAULT_CODEX_CORE_CONFIG_JSON,
        );
        assert.deepEqual(
            JSON.parse(await readFile(getCodexCoreGlobalConfigSchemaPath(agentDir), "utf8")),
            codexCoreConfigJsonSchema(),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("does not overwrite malformed existing codex config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-config-"));
    try {
        const agentDir = join(root, "agent");
        const configPath = getCodexCoreConfigPath(agentDir);
        await mkdir(join(configPath, ".."), { recursive: true });
        await writeFile(configPath, "{not json");

        const config = readCodexCoreConfig({ agentDir });

        assert.deepEqual(config, DEFAULT_CODEX_CORE_CONFIG);
        assert.equal(await readFile(configPath, "utf8"), "{not json");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("refreshes stale codex config schema without rewriting user config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-config-"));
    try {
        const agentDir = join(root, "agent");
        const configPath = getCodexCoreConfigPath(agentDir);
        const schemaPath = getCodexCoreGlobalConfigSchemaPath(agentDir);
        await mkdir(join(configPath, ".."), { recursive: true });
        await writeFile(configPath, "{not json");
        await writeFile(schemaPath, "{}\n");

        const config = readCodexCoreConfig({ agentDir });

        assert.deepEqual(config, DEFAULT_CODEX_CORE_CONFIG);
        assert.equal(await readFile(configPath, "utf8"), "{not json");
        assert.deepEqual(
            JSON.parse(await readFile(schemaPath, "utf8")),
            codexCoreConfigJsonSchema(),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("keeps codex config schema file aligned with TypeBox source", async () => {
    const schema = JSON.parse(await readFile("config.schema.json", "utf8"));

    assert.deepEqual(schema, codexCoreConfigJsonSchema());
});

test("merges project codex config over global config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-config-"));
    try {
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        const globalConfigPath = getCodexCoreConfigPath(agentDir);
        const projectConfigPath = getCodexCoreProjectConfigPath(cwd);
        await mkdir(join(globalConfigPath, ".."), { recursive: true });
        await mkdir(join(projectConfigPath, ".."), { recursive: true });
        await writeFile(globalConfigPath, JSON.stringify({ prompt: { mode: "codex" } }));
        await writeFile(projectConfigPath, JSON.stringify({ tools: { webSearch: false } }));

        const config = readCodexCoreConfig({ agentDir, cwd });

        assert.equal(config.prompt.mode, "codex");
        assert.equal(config.tools.webSearch, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("ignores project codex config when session cwd is untrusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-config-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const globalConfigPath = getCodexCoreConfigPath(agentDir);
        const projectConfigPath = getCodexCoreProjectConfigPath(cwd);
        await mkdir(join(globalConfigPath, ".."), { recursive: true });
        await mkdir(join(projectConfigPath, ".."), { recursive: true });
        await writeFile(globalConfigPath, JSON.stringify({ tools: { webSearch: true } }));
        await writeFile(projectConfigPath, JSON.stringify({ tools: { webSearch: false } }));

        const harness = makeExtensionHarness();
        extension(harness.api);
        await harness.startSession(makeExtensionContext(cwd, false));

        assert.ok(harness.activeTools.includes("web_run"));
        assert.equal(harness.activeTools.includes("apply_patch"), false);
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

test("codex command saves only changed global config values", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-command-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const globalConfigPath = getCodexCoreConfigPath(agentDir);
        const projectConfigPath = getCodexCoreProjectConfigPath(cwd);
        await mkdir(join(globalConfigPath, ".."), { recursive: true });
        await mkdir(join(projectConfigPath, ".."), { recursive: true });
        await writeFile(
            globalConfigPath,
            JSON.stringify({ tools: { webSearch: true }, prompt: { mode: "pi" } }),
        );
        await writeFile(projectConfigPath, JSON.stringify({ tools: { webSearch: false } }));

        const effectiveConfig = readCodexCoreConfig({ agentDir, cwd });
        let appliedConfig = effectiveConfig;
        const command = makeCodexCommandHarness();
        registerCodexCommand(command.api, {
            getConfig: () => appliedConfig,
            applyConfig: (config) => {
                appliedConfig = config;
            },
        });

        await command.run("prompt", makeExtensionContext(cwd, true));

        const savedConfig = JSON.parse(await readFile(globalConfigPath, "utf8")) as unknown;
        assert.ok(isRecord(savedConfig));
        assert.deepEqual(savedConfig.tools, {
            webSearch: true,
            imageGeneration: true,
            viewImage: true,
            viewImageDescriptions: false,
            applyPatch: "off",
        });
        assert.deepEqual(savedConfig.prompt, { mode: "codex" });
        assert.equal(appliedConfig.tools.webSearch, false);
        assert.equal(appliedConfig.prompt.mode, "codex");
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});

test("settings screen refreshes draft from effective config after save", async () => {
    const initialConfig = {
        ...DEFAULT_CODEX_CORE_CONFIG,
        tools: { ...DEFAULT_CODEX_CORE_CONFIG.tools, webSearch: false },
    };
    initTheme(undefined, false);
    let rendered = "";
    const ctx = {
        ui: {
            custom: async (
                factory: (
                    tui: unknown,
                    theme: Theme,
                    keybindings: unknown,
                    done: () => void,
                ) => {
                    readonly render: (width: number) => readonly string[];
                    readonly handleInput?: (data: string) => void;
                },
            ) => {
                const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
                component.handleInput?.("\t");
                component.handleInput?.(" ");
                rendered = component.render(120).join("\n");
            },
        },
    };

    await openCodexSettingsScreen(ctx as unknown as ExtensionContext, {
        initialConfig,
        onChange: (nextConfig) => {
            assert.equal(nextConfig.tools.webSearch, true);
            return { ok: true, effectiveConfig: initialConfig };
        },
    });

    const webSearchLine = rendered.split("\n").find((line) => line.includes("Web search"));
    assert.ok(webSearchLine);
    assert.ok(webSearchLine.includes("off"));
    assert.equal(webSearchLine.includes("on"), false);
});

test("resolves current Codex model selections", () => {
    assert.equal(resolveCodexRequestModel("current", "gpt-5.5"), "gpt-5.5");
    assert.equal(resolveCodexRequestModel(undefined, "gpt-5.5"), "gpt-5.5");
    assert.equal(resolveCodexRequestModel("", "gpt-5.5"), "gpt-5.5");
    assert.equal(resolveCodexRequestModel("gpt-5.4-mini", "gpt-5.5"), "gpt-5.4-mini");
});

test("codex prompt mode inherits structured Pi prompt sections", () => {
    const config = parseCodexCoreConfig({
        ...DEFAULT_CODEX_CORE_CONFIG,
        prompt: { mode: "codex" },
    });
    const skill: Skill = {
        name: "typescript",
        description: "TypeScript coding standards.",
        filePath: "/skills/typescript/SKILL.md",
        baseDir: "/skills/typescript",
        disableModelInvocation: false,
        sourceInfo: {
            path: "/skills/typescript/SKILL.md",
            source: "test",
            scope: "project",
            origin: "top-level",
            baseDir: "/skills/typescript",
        },
    };
    const options: BuildSystemPromptOptions = {
        cwd: "/workspace",
        selectedTools: ["read", "bash", "web_run", "imagegen", "view_image", "custom_tool"],
        toolSnippets: {
            read: "Read file contents",
            bash: "Execute shell commands",
            web_run: "Search or open the web through Codex-backed web access.",
            imagegen: "Generate or edit images through Codex image generation.",
            view_image: "View a local image file by path.",
        },
        promptGuidelines: ["Use read before editing files."],
        appendSystemPrompt: "Additional user-provided prompt rule.",
        contextFiles: [{ path: "/workspace/AGENTS.md", content: "Project instructions." }],
        skills: [skill],
    };
    const piPrompt = [
        "You are an expert coding assistant operating inside pi, a coding agent harness.",
        "Available tools:",
        "- read: Read file contents",
        "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
        "Current date: 2026-06-30",
        "Current working directory: /workspace",
    ].join("\n");

    const prompt = buildCodexCoreSystemPrompt(piPrompt, config, options);

    assert.match(prompt, /^You are an expert coding assistant operating inside pi/);
    assert.doesNotMatch(prompt, /Codex CLI/);
    assert.doesNotMatch(prompt, /Codex-style/);
    assert.doesNotMatch(prompt, /update_plan/);
    assert.doesNotMatch(prompt, /apply_patch/);
    assert.doesNotMatch(prompt, /Sandbox and approvals/);
    assert.doesNotMatch(prompt, /approval mode/);
    assert.doesNotMatch(prompt, /# Pi Context/);
    assert.doesNotMatch(prompt, /# Pi Codex Core/);
    assert.doesNotMatch(prompt, /Available Codex-compatible tools/);
    assert.doesNotMatch(prompt, /Codex tool scope/);
    assert.doesNotMatch(prompt, /following Pi-provided/);
    assert.match(prompt, /Available tools:\n- read: Read file contents/);
    assert.match(prompt, /- bash: Execute shell commands/);
    assert.match(prompt, /- web_run: Search or open the web through Codex-backed web access\./);
    assert.match(prompt, /- imagegen: Generate or edit images through Codex image generation\./);
    assert.match(prompt, /- view_image: View a local image file by path\./);
    assert.match(prompt, /- custom_tool: Available Pi tool\./);
    assert.match(prompt, /Pi documentation \(read only when the user asks about pi itself/);
    assert.match(prompt, /prompt templates \(docs\/prompt-templates\.md/);
    assert.match(prompt, /Guidelines:\n- Use bash for file operations like ls, rg, find/);
    assert.match(prompt, /Additional user-provided prompt rule\./);
    assert.match(
        prompt,
        /<project_instructions path="\/workspace\/AGENTS\.md">\nProject instructions\./,
    );
    assert.match(prompt, /<name>typescript<\/name>/);
    assert.match(prompt, /Current date: 2026-06-30/);
    assert.match(prompt, /Current working directory: \/workspace/);
    assert.doesNotMatch(
        prompt,
        /# Pi Context[\s\S]*You are an expert coding assistant operating inside pi/,
    );
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

test("formats Codex reset credit expiration metadata", () => {
    const explicitExpiration = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const grantedAt = new Date().toISOString();
    const credits = parseCodexRateLimitResetCreditsPayload({
        available_count: "2",
        credits: [
            {
                id: "RateLimitResetCredit_1",
                status: "available",
                granted_at: grantedAt,
                expires_at: explicitExpiration,
                redeem_started_at: null,
                redeemed_at: null,
            },
            {
                id: "RateLimitResetCredit_2",
                status: "available",
                granted_at: grantedAt,
                redeem_started_at: null,
                redeemed_at: null,
            },
            {
                id: "RateLimitResetCredit_3",
                status: "redeemed",
                granted_at: grantedAt,
                expires_at: new Date(Date.now() + 60_000).toISOString(),
                redeemed_at: new Date().toISOString(),
            },
        ],
    });

    assert.ok(credits);
    assert.equal(credits.credits.length, 3);
    const firstCredit = credits.credits[0];
    assert.ok(firstCredit);
    assert.equal(firstCredit.expiresAt, explicitExpiration);
    assert.equal(firstCredit.redeemStartedAt, undefined);
    const formatted = formatCodexUsage({ limits: [], resetCredits: credits, raw: {} });

    assert.match(
        formatted,
        /- Resets available: 2\n  - Reset 1: expires in ~5d \([^\n]+\)\n  - Reset 2: expires in ~30d \(/,
    );
    assert.doesNotMatch(formatted, /~1m/);
});

test("formats Codex reset credit expiration from granted time", () => {
    const grantedAt = new Date().toISOString();
    const credits = parseCodexRateLimitResetCreditsPayload({
        available_count: 1,
        credits: [
            {
                id: "RateLimitResetCredit_1",
                status: "available",
                granted_at: grantedAt,
                redeem_started_at: null,
                redeemed_at: null,
            },
        ],
    });

    assert.ok(credits);
    const formatted = formatCodexUsage({ limits: [], resetCredits: credits, raw: {} });

    assert.match(formatted, /- Resets available: 1\n  - Reset 1: expires in ~30d \(/);
});

test("fetches Codex usage from the selected provider base URL", async () => {
    const urls: string[] = [];
    const runtime = makeTestRuntime(async (input) => {
        urls.push(String(input));
        if (String(input).endsWith("/wham/usage")) {
            return new Response(
                JSON.stringify({ rate_limit_reset_credits: { available_count: 1 } }),
                { status: 200 },
            );
        }
        if (String(input).endsWith("/wham/rate-limit-reset-credits")) {
            return new Response(JSON.stringify({ available_count: 1, credits: [] }), {
                status: 200,
            });
        }
        return new Response("not found", { status: 404 });
    });

    const result = await fetchCodexUsage(makeUsageContext("https://proxy.example/backend-api"), {
        runtime,
    });

    assert.ok(result.isOk());
    assert.deepEqual(urls, [
        "https://proxy.example/backend-api/wham/usage",
        "https://proxy.example/backend-api/wham/rate-limit-reset-credits",
    ]);
});

test("Codex tool auth requires account ids and omits empty account headers", async () => {
    const headers = codexToolProviderHeaders({
        baseUrl: "https://chatgpt.com/backend-api/codex",
        model: "gpt-5.5",
        token: Redacted.of("token"),
        accountId: "",
    });
    assert.equal(headers.has("ChatGPT-Account-ID"), false);

    const result = await resolveCodexToolProvider(makeToolAuthContext({ apiKey: "token" }));

    assert.ok(result.isErr());
    assert.match(result.error.message, /account id is unavailable/);
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

test("Codex tokenizer worker restarts after shutdown", async () => {
    await shutdownCodexTokenizer();
    try {
        const text = "alpha beta gamma delta epsilon zeta eta theta";
        warmCodexTokenizer();
        const countBeforeShutdown = await countCodexTextTokens(text);
        const truncatedBeforeShutdown = await truncateCodexTextToTokenBudget(text, 3);

        await shutdownCodexTokenizer();

        const countAfterShutdown = await countCodexTextTokens(text);
        const truncatedAfterShutdown = await truncateCodexTextToTokenBudget(text, 3);

        assert.ok(countBeforeShutdown > 3);
        assert.equal(countAfterShutdown, countBeforeShutdown);
        assert.equal(truncatedAfterShutdown, truncatedBeforeShutdown);
        assert.ok(truncatedAfterShutdown.length < text.length);
    } finally {
        await shutdownCodexTokenizer();
    }
});

test("rejects invalid tool arguments before I/O", () => {
    const webRunTool = createWebRunTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(webRunTool.prepareArguments);
    assert.throws(
        () => webRunTool.prepareArguments?.({ search_query: [{ q: 42 }] }),
        /Invalid web_run arguments/,
    );
    assert.throws(() => webRunTool.prepareArguments?.({}), /web_run requires at least one/);
    assert.throws(
        () => webRunTool.prepareArguments?.({ response_length: "short" }),
        /at least one non-empty command/,
    );
    assert.throws(
        () =>
            webRunTool.prepareArguments?.({
                search_query: [],
                settings: { search_context_size: "low" },
            }),
        /at least one non-empty command/,
    );

    const imagegenTool = createImagegenTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(imagegenTool.prepareArguments);
    assert.throws(() => imagegenTool.prepareArguments?.({}), /non-empty prompt/);
    assert.throws(
        () => imagegenTool.prepareArguments?.({ prompt: "draw", referenced_image_paths: [123] }),
        /referenced_image_paths must be an array of strings/,
    );
    assert.deepEqual(
        imagegenTool.prepareArguments?.({
            prompt: "draw",
            referenced_image_paths: [],
            images: ["input.png"],
        }),
        { prompt: "draw", referenced_image_paths: ["input.png"] },
    );

    const viewImageTool = createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(viewImageTool.prepareArguments);
    assert.throws(() => viewImageTool.prepareArguments?.({ file_path: 123 }), /Invalid view_image/);
    assert.throws(() => viewImageTool.prepareArguments?.({}), /view_image requires a path/);
});

test("computes Codex prompt image target dimensions", () => {
    assert.deepEqual(codexPromptImageTargetDimensions(2304, 864), {
        width: 1280,
        height: 480,
    });
    assert.deepEqual(codexPromptImageTargetDimensions(1024, 4096), {
        width: 320,
        height: 1280,
    });
    assert.deepEqual(codexPromptImageTargetDimensions(2048, 2048), {
        width: 1280,
        height: 1280,
    });
});

test("reads image dimensions without full-buffer base64 conversion", async () => {
    const source = await readFile("src/image-content.ts", "utf8");
    const dimensionsBlock =
        /function imageDimensionsFromBytes[\s\S]*?function codexPromptImageDimensionsFit/.exec(
            source,
        );

    assert.ok(dimensionsBlock);
    assert.doesNotMatch(dimensionsBlock[0], /getImageDimensions|toString\("base64"\)/);
});

test("rejects oversized and mislabeled image files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-image-load-"));
    try {
        await writeFile(join(root, "fake.png"), "not actually an image");
        await assert.rejects(
            loadImageContent("fake.png", root),
            /Unsupported or invalid image file/,
        );

        const oversized = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.alloc(MAX_INPUT_IMAGE_BYTES),
        ]);
        await writeFile(join(root, "oversized.png"), oversized);
        await assert.rejects(loadImageContent("oversized.png", root), /Image is too large/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("view_image resizes default detail with Codex patch budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-view-image-"));
    try {
        const imagePath = join(root, "square.png");
        await writeFile(imagePath, solidPngBytes(2048, 2048, [40, 80, 120, 255]));
        const viewImageTool = createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
        const result = await viewImageTool.execute(
            "view-image-resize",
            { path: "square.png" },
            undefined,
            undefined,
            makeImageContext(root),
        );

        assert.doesNotMatch(JSON.stringify(result), /iVBOR|base64/);
        const marker = result.content.find(
            (item): item is { readonly type: "text"; readonly text: string } =>
                isRecord(item) && item.type === "text" && typeof item.text === "string",
        )?.text;
        assert.ok(marker);
        const rewritten = rewriteProviderRequestWithDeferredViewImages(
            {
                model: "gpt-5.5",
                input: [
                    { type: "function_call_output", call_id: "view-image-resize", output: marker },
                ],
            },
            makeImageContext(root),
        );
        assert.ok(isRecord(rewritten));
        assert.ok(Array.isArray(rewritten.input));
        const [toolOutput] = rewritten.input;
        assert.ok(isRecord(toolOutput));
        assert.ok(Array.isArray(toolOutput.output));
        const imagePart = toolOutput.output.find(
            (part) => isRecord(part) && typeof part.image_url === "string",
        );
        assert.ok(isRecord(imagePart));
        const imageUrl = String(imagePart.image_url);
        const imageData = imageUrl.replace(/^data:image\/png;base64,/, "");
        const dimensions = getImageDimensions(imageData, "image/png");
        assert.deepEqual(dimensions, { widthPx: 1280, heightPx: 1280 });
    } finally {
        clearDeferredViewImagesForSession("session/1");
        await rm(root, { recursive: true, force: true });
    }
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

test("renders non-inline view_image results without loading a preview file", () => {
    const viewImageTool = createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(viewImageTool.renderResult);
    const args = { path: "image.png" };
    const result = {
        content: [],
        details: {
            path: "image.png",
            absolutePath: "/tmp/image.png",
            described: true,
            mimeType: "image/png",
        },
    };
    const state = {};

    const rendered = renderComponent(
        viewImageTool.renderResult(
            result,
            { expanded: false, isPartial: false },
            TEST_THEME,
            makeRenderContext(args, state),
        ),
    );

    assert.equal(rendered.trimEnd(), "Image saved at image.png");
    assert.deepEqual(state, {});
});

test("renders viewed inline images when terminal images are available", () => {
    const viewImageTool = createViewImageTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
        capabilities: {
            getCapabilities: () => ({ images: "kitty", trueColor: true, hyperlinks: true }),
        },
        imageComponentFactory: () => ({
            invalidate() {},
            render: () => ["\u001B_Gfake-inline-image"],
        }),
    });
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
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        return new Response(JSON.stringify({ output: "1. Pi\n   URL: https://pi.dev/" }), {
            status: 200,
        });
    });

    try {
        await mkdir(cwd, { recursive: true });
        const webRunTool = createWebRunTool({
            getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
            runtime,
            agentDir,
        });
        const result = await webRunTool.execute(
            "call/1",
            { search_query: [{ q: "Pi docs" }], response_length: "short" },
            undefined,
            undefined,
            makeWebRunContext(cwd),
        );
        const rawOutputPath = join(agentDir, "pi-codex-core", "web-run", "session_1", "call_1.txt");

        assert.ok(isRecord(requestBody));
        assert.deepEqual(requestBody.commands, { search_query: [{ q: "Pi docs" }] });
        assert.equal(requestBody.response_length, "short");
        assert.equal(result.details.fullOutputPath, rawOutputPath);
        assert.equal(
            (await readFile(rawOutputPath)).toString("utf8"),
            "1. Pi\n   URL: https://pi.dev/",
        );
        await assert.rejects(readFile(join(cwd, ".pi", "codex-core-web-run", "call_1.txt")), {
            code: "ENOENT",
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("imagegen returns saved paths without inline generated images", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-imagegen-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const cwd = join(root, "workspace");
        const agentDir = join(root, "agent");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        await mkdir(cwd, { recursive: true });
        const base64 = Buffer.from("generated png bytes").toString("base64");
        const runtime = makeTestRuntime(
            async () =>
                new Response(JSON.stringify({ data: [{ b64_json: base64 }], size: "1024x1024" }), {
                    status: 200,
                }),
        );
        const imagegenTool = createImagegenTool({
            getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
            runtime,
        });

        const result = await imagegenTool.execute(
            "call/1",
            { prompt: "Draw a blue robot" },
            undefined,
            undefined,
            makeWebRunContext(cwd),
        );
        const imagePath = join(agentDir, "pi-codex-core", "imagegen", "session_1", "call_1.png");
        const latestPath = join(agentDir, "pi-codex-core", "imagegen", "session_1", "latest.png");

        assert.equal(result.content.length, 1);
        assert.deepEqual(result.content[0], {
            type: "text",
            text: [
                "Generated image output:",
                `- image: ${imagePath}`,
                `- latest image: ${latestPath}`,
                "- size=1024x1024",
            ].join("\n"),
        });
        assert.equal((await readFile(imagePath)).toString("utf8"), "generated png bytes");
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});

test("imagegen saves generated images sequentially", async () => {
    const base64A = Buffer.from("first generated png bytes").toString("base64");
    const base64B = Buffer.from("second generated png bytes").toString("base64");
    const runtime = makeTestRuntime(
        async () =>
            new Response(JSON.stringify({ data: [{ b64_json: base64A }, { b64_json: base64B }] }), {
                status: 200,
            }),
    );
    let activeSaves = 0;
    let maxActiveSaves = 0;
    const savedOrder: string[] = [];
    const imagegenTool = createImagegenTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
        runtime,
        async saveImage(args) {
            activeSaves += 1;
            maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
            await Promise.resolve();
            savedOrder.push(args.base64);
            activeSaves -= 1;
            return {
                path: `/tmp/${args.index}.png`,
                absolutePath: `/tmp/${args.index}.png`,
                latestPath: "/tmp/latest.png",
                latestAbsolutePath: "/tmp/latest.png",
            };
        },
    });

    await imagegenTool.execute(
        "call/1",
        { prompt: "Draw two robots" },
        undefined,
        undefined,
        makeWebRunContext("/workspace"),
    );

    assert.equal(maxActiveSaves, 1);
    assert.deepEqual(savedOrder, [base64A, base64B]);
});

test("imagegen edits recent generated image artifacts from tool details", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-imagegen-recent-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const cwd = join(root, "workspace");
        const agentDir = join(root, "agent");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const previousImagePath = join(root, "previous.png");
        await mkdir(cwd, { recursive: true });
        await writeFile(previousImagePath, solidPngBytes(1, 1, [0, 0, 255, 255]));
        const editedBase64 = Buffer.from("edited png bytes").toString("base64");
        let requestUrl = "";
        let requestBody: unknown;
        const runtime = makeTestRuntime(async (input, init) => {
            requestUrl = String(input);
            requestBody = JSON.parse(String(init?.body)) as unknown;
            return new Response(JSON.stringify({ data: [{ b64_json: editedBase64 }] }), {
                status: 200,
            });
        });
        const imagegenTool = createImagegenTool({
            getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
            runtime,
        });
        const ctx = makeWebRunContextWithBranch(cwd, [
            messageEntry("imagegen-result", null, {
                role: "toolResult",
                content: [
                    {
                        type: "text",
                        text: `Generated image output:\n- image: ${previousImagePath}`,
                    },
                ],
                details: {
                    images: [
                        {
                            path: previousImagePath,
                            absolutePath: previousImagePath,
                            latestPath: previousImagePath,
                            latestAbsolutePath: previousImagePath,
                        },
                    ],
                },
            }),
        ]);

        await imagegenTool.execute(
            "call/2",
            { prompt: "Make the recent image red", num_last_images_to_include: 1 },
            undefined,
            undefined,
            ctx,
        );

        assert.match(requestUrl, /\/images\/edits$/);
        assert.ok(isRecord(requestBody));
        assert.ok(Array.isArray(requestBody.images));
        const [editImage] = requestBody.images;
        assert.ok(isRecord(editImage));
        assert.equal(
            editImage.image_url,
            `data:image/png;base64,${solidPngBytes(1, 1, [0, 0, 255, 255]).toString("base64")}`,
        );
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});

test("saves generated images outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");

    try {
        await mkdir(cwd, { recursive: true });
        await writeFile(join(cwd, "latest.png"), "do not replace");
        const base64 = Buffer.from("not really a png").toString("base64");
        const saved = await saveGeneratedImage({
            sessionId: "session/1",
            toolCallId: "call*1",
            index: 0,
            base64,
            agentDir,
        });
        const imagePath = join(agentDir, "pi-codex-core", "imagegen", "session_1", "call_1.png");
        const latestPath = join(agentDir, "pi-codex-core", "imagegen", "session_1", "latest.png");

        assert.equal(saved.path, imagePath);
        assert.equal(saved.latestPath, latestPath);
        assert.equal((await readFile(saved.absolutePath)).toString("utf8"), "not really a png");
        assert.equal(
            (await readFile(saved.latestAbsolutePath)).toString("utf8"),
            "not really a png",
        );
        assert.equal((await readFile(join(cwd, "latest.png"))).toString("utf8"), "do not replace");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("allocates unique generated image artifact names on retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-imagegen-retry-"));
    const agentDir = join(root, "agent");

    try {
        const firstBase64 = Buffer.from("first png").toString("base64");
        const secondBase64 = Buffer.from("second png").toString("base64");
        const first = await saveGeneratedImage({
            sessionId: "session/1",
            toolCallId: "call/1",
            index: 0,
            base64: firstBase64,
            agentDir,
        });
        const second = await saveGeneratedImage({
            sessionId: "session/1",
            toolCallId: "call*1",
            index: 0,
            base64: secondBase64,
            agentDir,
        });

        assert.equal(
            first.path,
            join(agentDir, "pi-codex-core", "imagegen", "session_1", "call_1.png"),
        );
        assert.equal(
            second.path,
            join(agentDir, "pi-codex-core", "imagegen", "session_1", "call_1-2.png"),
        );
        assert.equal((await readFile(first.absolutePath)).toString("utf8"), "first png");
        assert.equal((await readFile(second.absolutePath)).toString("utf8"), "second png");
        assert.equal((await readFile(second.latestAbsolutePath)).toString("utf8"), "second png");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("creates native compaction using remote compaction v2", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    let requestAccountId: string | null = null;
    const runtime = makeTestRuntime(async (input, init) => {
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
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent(),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.equal(requestUrl, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(requestAccountId, "account");
    assert.ok(isRecord(requestBody));
    assert.equal(requestBody.model, "gpt-5.5");
    assert.deepEqual((requestBody.input as unknown[]).at(-1), {
        type: "compaction_trigger",
    });
    assert.deepEqual(requestBody.tools, [
        {
            type: "function",
            name: "read",
            description: "Read a file.",
            parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
            },
            strict: null,
        },
    ]);
    assert.equal(result?.compaction?.details.strategy, "pi-codex-core-remote-compaction-v2");
    assert.equal(result?.compaction?.details.model, "gpt-5.5");
    assert.deepEqual(result?.compaction?.details.compactedWindow, [
        {
            role: "user",
            content: [{ type: "input_text", text: "keep this request" }],
        },
        { type: "compaction", encrypted_content: "sealed" },
    ]);
    assert.equal(result?.compaction?.details.windowNumber, 1);
    assert.equal(result?.compaction?.details.firstWindowId, result?.compaction?.details.windowId);
    assert.equal(result?.compaction?.details.previousWindowId, undefined);
    assert.equal(Object.hasOwn(result?.compaction?.details ?? {}, "replacementInput"), false);
    assert.equal(result?.compaction?.details.worldState.cwd, "/workspace");
    assert.equal(result?.compaction?.details.worldState.model, "openai-codex/gpt-5.5");
    assert.deepEqual(result?.compaction?.details.worldState.activeToolNames, ["read"]);
});

test("streams remote compaction SSE without buffering response text", async () => {
    let textCalled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(
                encoder.encode(
                    [
                        "event: response.output_item.done",
                        'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"streamed"}}',
                        "",
                        "",
                    ].join("\n"),
                ),
            );
            controller.enqueue(
                encoder.encode(
                    [
                        "event: response.completed",
                        'data: {"type":"response.completed","response":{"id":"resp_stream","created_at":123}}',
                        "",
                        "",
                    ].join("\n"),
                ),
            );
            controller.close();
        },
    });
    const response = {
        ok: true,
        status: 200,
        body,
        text: async () => {
            textCalled = true;
            throw new Error("response text should not be buffered");
        },
    };
    const runtime = makeTestRuntime(async () => {
        // SAFETY: This fixture implements the Response members read by remote compaction streaming.
        return response as unknown as Response;
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent(),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.equal(textCalled, false);
    assert.deepEqual(result?.compaction?.details.compactedWindow.at(-1), {
        type: "compaction",
        encrypted_content: "streamed",
    });
});

test("cancels remote compaction streams with oversized pending SSE events", async () => {
    let streamCancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(`data: ${"x".repeat(1_000_001)}`));
        },
        cancel() {
            streamCancelled = true;
        },
    });
    const response = {
        ok: true,
        status: 200,
        body,
        text: async () => {
            throw new Error("response text should not be buffered");
        },
    };
    const runtime = makeTestRuntime(async () => {
        // SAFETY: This fixture implements the Response members read by remote compaction streaming.
        return response as unknown as Response;
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent(),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.equal(result, undefined);
    assert.equal(streamCancelled, true);
});

test("chains previous native compaction into the next remote v2 request", async () => {
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-new"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_2","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                nativeCompactionEntry({ id: "compact-1", firstKeptEntryId: "entry-old" }),
                messageEntry("entry-tail", "compact-1", userMessage("new live tail")),
            ],
            firstKeptEntryId: "entry-tail",
        }),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.ok(isRecord(requestBody));
    assert.deepEqual((requestBody.input as unknown[]).slice(0, 3), [
        { type: "compaction", encrypted_content: "opaque" },
        { role: "user", content: [{ type: "input_text", text: "new live tail" }] },
        { type: "compaction_trigger" },
    ]);
    assert.equal(result?.compaction?.details.requestMeta?.previousCompactionEntryId, "compact-1");
    assert.equal(result?.compaction?.details.windowNumber, 2);
    assert.equal(result?.compaction?.details.previousWindowId, "window-1");
    assert.equal(result?.compaction?.details.firstWindowId, "window-1");
    assert.equal(result?.compaction?.details.sourceCompactionEntryId, "compact-1");
    assert.deepEqual(result?.compaction?.details.compactedWindow, [
        { role: "user", content: [{ type: "input_text", text: "new live tail" }] },
        { type: "compaction", encrypted_content: "sealed-new" },
    ]);
});

test("native compaction inserts synthetic output for missing tool results", async () => {
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-missing-tool-result"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_missing_tool_result","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                messageEntry(
                    "assistant-tool",
                    null,
                    assistantMessage([
                        {
                            type: "toolCall",
                            id: "call/missing|item/missing",
                            name: "read",
                            arguments: { path: "missing.txt" },
                        },
                    ]),
                ),
                messageEntry("user-after-tool", "assistant-tool", userMessage("please continue")),
            ],
            firstKeptEntryId: "user-after-tool",
        }),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.ok(result?.compaction);
    assert.ok(isRecord(requestBody));
    const requestInput = responseInput(requestBody);
    const callIndex = requestInput.findIndex(
        (item) => isRecord(item) && item.type === "function_call",
    );
    const syntheticOutputIndex = requestInput.findIndex(
        (item) =>
            isRecord(item) &&
            item.type === "function_call_output" &&
            item.output === "No result provided",
    );
    const userIndex = requestInput.findIndex(
        (item) => isRecord(item) && textFromResponseItem(item) === "please continue",
    );

    assert.ok(callIndex >= 0);
    assert.ok(syntheticOutputIndex > callIndex);
    assert.ok(userIndex > syntheticOutputIndex);
    assert.deepEqual(requestInput[syntheticOutputIndex], {
        type: "function_call_output",
        call_id: "call_missing",
        output: "No result provided",
    });
});

test("preserves previous native compaction anchor while trimming next request", async () => {
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-after-trim"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_anchor_trim","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                nativeCompactionEntry({ id: "compact-1", firstKeptEntryId: "entry-old" }),
                messageEntry(
                    "entry-huge-tail",
                    "compact-1",
                    userMessage(`huge ${"x ".repeat(8_000)}`),
                ),
                messageEntry("entry-recent-tail", "entry-huge-tail", userMessage("new live tail")),
            ],
            firstKeptEntryId: "entry-huge-tail",
        }),
        makeNativeCompactionContext({ contextWindow: 2_000 }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.ok(isRecord(requestBody));
    const requestInput = responseInput(requestBody);
    assert.deepEqual(requestInput.at(0), { type: "compaction", encrypted_content: "opaque" });
    assert.doesNotMatch(JSON.stringify(requestInput), /huge x/);
    assert.equal(result?.compaction?.details.requestMeta?.previousCompactionEntryId, "compact-1");
});

test("shrinks oversized tool outputs before remote v2 compaction", async () => {
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_3","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                messageEntry(
                    "assistant-tool",
                    null,
                    assistantMessage([
                        {
                            type: "toolCall",
                            id: "call/1|item/1",
                            name: "read",
                            arguments: { path: "big.txt" },
                        },
                    ]),
                ),
                messageEntry(
                    "tool-result",
                    "assistant-tool",
                    toolResultMessage("call/1|item/1", "x ".repeat(2_000)),
                ),
                messageEntry("user-after-tool", "tool-result", userMessage("please continue")),
            ],
            firstKeptEntryId: "user-after-tool",
        }),
        makeNativeCompactionContext({ contextWindow: 600 }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.ok(isRecord(requestBody));
    const callItem = (requestBody.input as unknown[]).find(
        (item) => isRecord(item) && item.type === "function_call",
    );
    assert.deepEqual(callItem, {
        type: "function_call",
        id: "fc_item_1",
        call_id: "call_1",
        name: "read",
        arguments: JSON.stringify({ path: "big.txt" }),
    });
    const outputItem = (requestBody.input as unknown[]).find(
        (item) => isRecord(item) && item.type === "function_call_output",
    );
    assert.ok(isRecord(outputItem));
    assert.equal(outputItem.output, "[truncated]");
    assert.equal(result?.compaction?.details.requestMeta?.rewrittenToolOutputs, 1);
});

test("rewrites multiple oversized tool outputs before serializing remote v2 compaction", async () => {
    let requestBodyText = "";
    const firstHugeOutput = `first huge output ${"a ".repeat(3_000)}`;
    const secondHugeOutput = `second huge output ${"b ".repeat(3_000)}`;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBodyText = String(init?.body);
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-multi-tool"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_multi_tool","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                messageEntry(
                    "assistant-tool-1",
                    null,
                    assistantMessage([
                        {
                            type: "toolCall",
                            id: "call/1|item/1",
                            name: "read",
                            arguments: { path: "first.txt" },
                        },
                    ]),
                ),
                messageEntry(
                    "tool-result-1",
                    "assistant-tool-1",
                    toolResultMessage("call/1|item/1", firstHugeOutput),
                ),
                messageEntry("user-after-tool-1", "tool-result-1", userMessage("continue 1")),
                messageEntry(
                    "assistant-tool-2",
                    "user-after-tool-1",
                    assistantMessage([
                        {
                            type: "toolCall",
                            id: "call/2|item/2",
                            name: "read",
                            arguments: { path: "second.txt" },
                        },
                    ]),
                ),
                messageEntry(
                    "tool-result-2",
                    "assistant-tool-2",
                    toolResultMessage("call/2|item/2", secondHugeOutput),
                ),
                messageEntry("user-after-tool-2", "tool-result-2", userMessage("continue 2")),
            ],
            firstKeptEntryId: "user-after-tool-2",
        }),
        makeNativeCompactionContext({ contextWindow: 1_000 }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.ok(result?.compaction);
    assert.equal(result.compaction.details.requestMeta?.rewrittenToolOutputs, 2);
    assert.doesNotMatch(requestBodyText, /first huge output/);
    assert.doesNotMatch(requestBodyText, /second huge output/);
    const requestInput = responseInput(JSON.parse(requestBodyText) as unknown);
    const outputItems = requestInput.filter(
        (item) => isRecord(item) && item.type === "function_call_output",
    );
    assert.equal(outputItems.length, 2);
    assert.deepEqual(
        outputItems.map((item) => (isRecord(item) ? item.output : undefined)),
        ["[truncated]", "[truncated]"],
    );
});

test("trims oversized non-tool input before remote v2 compaction", async () => {
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-trimmed"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_trimmed","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                messageEntry("old", null, userMessage(`old ${"x ".repeat(6_000)}`)),
                messageEntry("recent", "old", userMessage("please keep working")),
            ],
            firstKeptEntryId: "old",
        }),
        makeNativeCompactionContext({ contextWindow: 700 }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.ok(isRecord(requestBody));
    assert.doesNotMatch(JSON.stringify(requestBody.input), /old x/);
    const requestMeta = result?.compaction?.details.requestMeta;
    assert.ok(requestMeta?.budgetTokens);
    assert.ok(requestMeta.estimatedTokensAfter <= requestMeta.budgetTokens);
});

test("does not send remote v2 compaction when protected input cannot fit", async () => {
    let fetchCalls = 0;
    const runtime = makeTestRuntime(async () => {
        fetchCalls += 1;
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"should-not-send"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_too_large","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                messageEntry(
                    "assistant-huge-call",
                    null,
                    assistantMessage([
                        {
                            type: "toolCall",
                            id: "call/huge|item/huge",
                            name: "read",
                            arguments: { path: `${"huge/".repeat(8_000)}file.txt` },
                        },
                    ]),
                ),
            ],
            firstKeptEntryId: "assistant-huge-call",
        }),
        makeNativeCompactionContext({ contextWindow: 180 }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.equal(fetchCalls, 0);
    assert.equal(result, undefined);
});

test("retained image-only messages consume compaction budget", async () => {
    const runtime = makeTestRuntime(async () => {
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-images"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_images","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const branchEntries = Array.from({ length: 80 }, (_unused, index) =>
        messageEntry(
            `image-${index}`,
            index === 0 ? null : `image-${index - 1}`,
            imageOnlyUserMessage(index),
        ),
    );
    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({ branchEntries, firstKeptEntryId: "image-79" }),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    const compactedWindow = result?.compaction?.details.compactedWindow ?? [];
    const retainedImageUrls = compactedWindow.flatMap(imageUrlsFromResponseItem);
    const retainedImagePlaceholders = compactedWindow.filter((item) =>
        /image omitted from retained compacted window/.test(textFromResponseItem(item)),
    );
    assert.equal(retainedImageUrls.length, 0);
    assert.ok(retainedImagePlaceholders.length > 0);
    assert.ok(retainedImagePlaceholders.length < 80);
});

test("retained native compaction window truncates huge text and omits over-budget image", async () => {
    const hugeText = `retained-start ${"x ".repeat(90_000)}retained-end`;
    const runtime = makeTestRuntime(async () => {
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-retained-truncated"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_retained_truncated","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                messageEntry("retained", null, {
                    role: "user",
                    content: [
                        { type: "text", text: hugeText },
                        {
                            type: "image",
                            mimeType: "image/png",
                            data: Buffer.from("retained-image").toString("base64"),
                        },
                    ],
                    timestamp: 0,
                }),
            ],
            firstKeptEntryId: "retained",
        }),
        makeNativeCompactionContext({ contextWindow: 300_000 }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    const compactedWindow = result?.compaction?.details.compactedWindow ?? [];
    assert.deepEqual(compactedWindow.at(-1), {
        type: "compaction",
        encrypted_content: "sealed-retained-truncated",
    });
    const retainedItem = compactedWindow.find((item) => isRecord(item) && item.role === "user");
    assert.ok(retainedItem);
    const retainedText = textFromResponseItem(retainedItem);
    assert.match(retainedText, /^retained-start/);
    assert.match(retainedText, /retained-end$/);
    assert.ok(retainedText.length < hugeText.length);
    assert.equal(imageUrlsFromResponseItem(retainedItem).length, 0);
});

test("preserves previous native window when falling back to Pi compaction", async () => {
    const runtime = makeTestRuntime(async () => new Response("limit", { status: 429 }));
    const ctx = makeNativeCompactionContext();

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                nativeCompactionEntry({ id: "compact-1", firstKeptEntryId: "entry-old" }),
                messageEntry("entry-tail", "compact-1", userMessage("new live tail")),
            ],
            firstKeptEntryId: "entry-tail",
        }),
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );
    assert.equal(result, undefined);

    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        {
            model: "gpt-5.5",
            instructions: "compact this conversation",
            input: [
                { role: "developer", content: "summarize compact" },
                {
                    role: "user",
                    content: [{ type: "input_text", text: "<conversation>tail</conversation>" }],
                },
            ],
        },
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    const rewrittenInput = responseInput(rewritten);
    assert.deepEqual(rewrittenInput.slice(0, 2), [
        { role: "developer", content: "summarize compact" },
        { type: "compaction", encrypted_content: "opaque" },
    ]);
    assert.match(worldStateText(rewrittenInput[2]), /<codex_core_world_state>/);
    assert.deepEqual(rewrittenInput.slice(3), [
        {
            role: "user",
            content: [{ type: "input_text", text: "<conversation>tail</conversation>" }],
        },
    ]);
});

test("keeps pending Pi fallback windows isolated by session", async () => {
    const runtime = makeTestRuntime(async () => new Response("limit", { status: 429 }));
    const sessionA = makeNativeCompactionContext({ sessionId: "session-a" });
    const sessionB = makeNativeCompactionContext({ sessionId: "session-b" });
    const config = {
        ...DEFAULT_CODEX_CORE_CONFIG,
        compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
    };

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                nativeCompactionEntry({ id: "compact-1", firstKeptEntryId: "entry-old" }),
                messageEntry("entry-tail", "compact-1", userMessage("new live tail")),
            ],
            firstKeptEntryId: "entry-tail",
        }),
        sessionA,
        config,
        makeCompactionApi(),
        runtime,
    );
    assert.equal(result, undefined);

    const fallbackPayload = {
        model: "gpt-5.5",
        instructions: "compact this conversation",
        input: [
            { role: "developer", content: "summarize compact" },
            {
                role: "user",
                content: [{ type: "input_text", text: "<conversation>tail</conversation>" }],
            },
        ],
    };

    const sessionBRewrite = await rewriteProviderRequestWithNativeCompaction(
        fallbackPayload,
        sessionB,
        config,
        makeCompactionApi(),
        runtime,
    );
    assert.equal(sessionBRewrite, undefined);

    const sessionARewrite = await rewriteProviderRequestWithNativeCompaction(
        fallbackPayload,
        sessionA,
        config,
        makeCompactionApi(),
        runtime,
    );
    const rewrittenInput = responseInput(sessionARewrite);
    assert.deepEqual(rewrittenInput.slice(0, 2), [
        { role: "developer", content: "summarize compact" },
        { type: "compaction", encrypted_content: "opaque" },
    ]);
});

test("expires pending Pi fallback windows", async () => {
    cancelScheduledCodexAutoCompaction();
    let nowMs = 1_000;
    const runtime = {
        ...makeTestRuntime(async () => new Response("limit", { status: 429 })),
        clock: {
            nowMs: () => nowMs,
            nowDate: () => new Date("2026-01-01T00:00:00.000Z"),
        },
    } satisfies CodexRuntime;
    const ctx = makeNativeCompactionContext({ sessionId: "expires-pending" });
    const config = {
        ...DEFAULT_CODEX_CORE_CONFIG,
        compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
    };

    await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                nativeCompactionEntry({ id: "compact-1", firstKeptEntryId: "entry-old" }),
                messageEntry("entry-tail", "compact-1", userMessage("new live tail")),
            ],
            firstKeptEntryId: "entry-tail",
        }),
        ctx,
        config,
        makeCompactionApi(),
        runtime,
    );

    nowMs += 5 * 60 * 1000 + 1;
    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        {
            model: "gpt-5.5",
            instructions: "compact this conversation",
            input: [{ role: "developer", content: "summarize compact" }],
        },
        ctx,
        config,
        makeCompactionApi(),
        runtime,
    );

    assert.equal(rewritten, undefined);
    cancelScheduledCodexAutoCompaction();
});

test("skips provider payload parsing when no native compaction state exists", async () => {
    cancelScheduledCodexAutoCompaction();
    const payload = { model: "gpt-5.4-mini" };
    Object.defineProperty(payload, "input", {
        get() {
            throw new Error("provider payload should not be parsed");
        },
    });

    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        payload,
        makeCompactionContext({ branchEntries: [] }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );

    assert.equal(rewritten, undefined);
});

test("native replay matching does not JSON-stringify provider items", async () => {
    const ctx = makeCompactionContext();
    const poisonReplayItem = {
        role: "user",
        content: [{ type: "input_text", text: "inserted context" }],
        toJSON() {
            throw new Error("provider item should not be JSON-stringified");
        },
    };

    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        {
            model: "gpt-5.4-mini",
            input: [
                { role: "developer", content: "system" },
                {
                    role: "user",
                    content: [{ type: "input_text", text: NATIVE_COMPACTION_SHIM_SUMMARY }],
                },
                poisonReplayItem,
                { role: "user", content: [{ type: "input_text", text: "pre kept" }] },
                { role: "user", content: [{ type: "input_text", text: "post tail" }] },
            ],
        },
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );

    const rewrittenInput = responseInput(rewritten);
    assert.deepEqual(rewrittenInput.slice(0, 2), [
        { role: "developer", content: "system" },
        { type: "compaction", encrypted_content: "opaque" },
    ]);
    const rewrittenText = rewrittenInput.map(textFromResponseItem).join("\n");
    assert.match(rewrittenText, /inserted context/);
    assert.doesNotMatch(rewrittenText, /pre kept/);
});

test("auto compaction defers until Pi is idle after agent_end", async () => {
    const compactCalls: unknown[] = [];
    const idle = { value: false };
    const ctx = makeAutoCompactionContext(compactCalls, idle);
    const scheduledTasks: Array<() => void> = [];
    const runtime = {
        ...makeTestRuntime(),
        scheduler: {
            set(_delayMs: number, task: () => void): ScheduledTask {
                scheduledTasks.push(task);
                return { cancel() {} };
            },
        },
    } satisfies CodexRuntime;
    const config = {
        ...DEFAULT_CODEX_CORE_CONFIG,
        compaction: {
            ...DEFAULT_CODEX_CORE_CONFIG.compaction,
            enabled: true,
            auto: true,
            thresholdPercent: DEFAULT_CODEX_CORE_CONFIG.compaction.thresholdPercent,
        },
    };

    assert.equal(scheduleCodexAutoCompaction(ctx, config, runtime), true);
    assert.equal(compactCalls.length, 0);
    idle.value = true;
    scheduledTasks.shift()?.();
    assert.equal(compactCalls.length, 1);
    assert.equal(scheduleCodexAutoCompaction(ctx, config, runtime), true);
    scheduledTasks.shift()?.();
    assert.equal(compactCalls.length, 1);
});

test("auto compaction skips after assistant errors so Pi retry can continue", async () => {
    const compactCalls: unknown[] = [];
    const idle = { value: true };
    const ctx = makeAutoCompactionContext(compactCalls, idle);
    const scheduledTasks: Array<() => void> = [];
    const runtime = {
        ...makeTestRuntime(),
        scheduler: {
            set(_delayMs: number, task: () => void): ScheduledTask {
                scheduledTasks.push(task);
                return { cancel() {} };
            },
        },
    } satisfies CodexRuntime;
    const config = {
        ...DEFAULT_CODEX_CORE_CONFIG,
        compaction: {
            ...DEFAULT_CODEX_CORE_CONFIG.compaction,
            enabled: true,
            auto: true,
            thresholdPercent: DEFAULT_CODEX_CORE_CONFIG.compaction.thresholdPercent,
        },
    };

    assert.equal(
        scheduleCodexAutoCompaction(ctx, config, runtime, {
            completedMessages: [{ role: "assistant", stopReason: "error" }],
        }),
        false,
    );
    assert.equal(scheduledTasks.length, 0);
    assert.equal(compactCalls.length, 0);
});

test("rewrites responses payload with native compaction replay matching", async () => {
    const ctx = makeCompactionContext();
    const payload = {
        model: "gpt-5.4-mini",
        input: [
            { role: "developer", content: "system" },
            {
                role: "user",
                content: [{ type: "input_text", text: NATIVE_COMPACTION_SHIM_SUMMARY }],
            },
            { role: "user", content: [{ type: "input_text", text: "pre kept" }] },
            { role: "user", content: [{ type: "input_text", text: "post tail" }] },
            { role: "user", content: [{ type: "input_text", text: "current payload tail" }] },
        ],
    };

    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        payload,
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );

    const rewrittenInput = responseInput(rewritten);
    assert.deepEqual(rewrittenInput.slice(0, 2), [
        { role: "developer", content: "system" },
        { type: "compaction", encrypted_content: "opaque" },
    ]);
    assert.match(worldStateText(rewrittenInput[2]), /<codex_core_world_state>/);
    assert.match(worldStateText(rewrittenInput[2]), /window: 1/);
    assert.deepEqual(rewrittenInput.slice(3), [
        { role: "user", content: [{ type: "input_text", text: "post tail" }] },
        { role: "user", content: [{ type: "input_text", text: "current payload tail" }] },
    ]);
});

test("rewrites native compaction replay in long payloads", async () => {
    const keptEntries = Array.from({ length: 80 }, (_unused, index) =>
        messageEntry(
            `pre-${index}`,
            index === 0 ? null : `pre-${index - 1}`,
            userMessage(`pre kept ${index}`),
        ),
    );
    const branchEntries = [
        ...keptEntries,
        nativeCompactionEntry({
            id: "compact-long",
            parentId: "pre-79",
            firstKeptEntryId: "pre-0",
            model: "gpt-5.4-mini",
        }),
        messageEntry("tail", "compact-long", userMessage("post tail")),
    ];
    const ctx = makeCompactionContext({ branchEntries });
    const filler = Array.from({ length: 120 }, (_unused, index) => ({
        role: "user",
        content: [{ type: "input_text", text: `inserted context ${index}` }],
    }));
    const keptReplay = keptEntries.map((_entry, index) => ({
        role: "user",
        content: [{ type: "input_text", text: `pre kept ${index}` }],
    }));
    const payload = {
        model: "gpt-5.4-mini",
        input: [
            { role: "developer", content: "system" },
            {
                role: "user",
                content: [{ type: "input_text", text: NATIVE_COMPACTION_SHIM_SUMMARY }],
            },
            ...filler,
            ...keptReplay,
            { role: "user", content: [{ type: "input_text", text: "current payload tail" }] },
        ],
    };

    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        payload,
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );

    const rewrittenInput = responseInput(rewritten);
    assert.deepEqual(rewrittenInput.slice(0, 2), [
        { role: "developer", content: "system" },
        { type: "compaction", encrypted_content: "opaque" },
    ]);
    assert.doesNotMatch(JSON.stringify(rewrittenInput), /pre kept 0/);
    assert.match(JSON.stringify(rewrittenInput), /inserted context 119/);
});

test("handles native replay fallback mismatch silently", async () => {
    const warnings: string[] = [];
    const ctx = makeCompactionContext({ warnings, sessionId: "mismatch-session" });
    const payload = {
        model: "gpt-5.4-mini",
        input: [
            { role: "developer", content: "system" },
            {
                role: "user",
                content: [{ type: "input_text", text: NATIVE_COMPACTION_SHIM_SUMMARY }],
            },
            { role: "user", content: [{ type: "input_text", text: "different replay" }] },
            { role: "user", content: [{ type: "input_text", text: "current payload tail" }] },
        ],
    };

    await rewriteProviderRequestWithNativeCompaction(
        payload,
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );
    await rewriteProviderRequestWithNativeCompaction(
        payload,
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );

    assert.deepEqual(warnings, []);
});

test("rewrites native compaction replay when new-session context is inserted", async () => {
    const ctx = makeCompactionContext();
    const environmentContext = {
        role: "user",
        content: [
            {
                type: "input_text",
                text: "<environment_context>\ncwd: /workspace\n</environment_context>",
            },
        ],
    };
    const payload = {
        model: "gpt-5.4-mini",
        input: [
            { role: "developer", content: "system" },
            {
                role: "user",
                content: [{ type: "input_text", text: NATIVE_COMPACTION_SHIM_SUMMARY }],
            },
            environmentContext,
            { role: "user", content: [{ type: "input_text", text: "pre kept" }] },
            { role: "user", content: [{ type: "input_text", text: "post tail" }] },
            { role: "user", content: [{ type: "input_text", text: "current payload tail" }] },
        ],
    };

    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        payload,
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );

    const rewrittenInput = responseInput(rewritten);
    assert.deepEqual(rewrittenInput.slice(0, 2), [
        { role: "developer", content: "system" },
        { type: "compaction", encrypted_content: "opaque" },
    ]);
    assert.match(worldStateText(rewrittenInput[2]), /<codex_core_world_state>/);
    assert.deepEqual(rewrittenInput.slice(3), [
        environmentContext,
        { role: "user", content: [{ type: "input_text", text: "post tail" }] },
        { role: "user", content: [{ type: "input_text", text: "current payload tail" }] },
    ]);
});

const TEST_THEME = makeTestTheme();

type ExtensionSessionStartHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

type ExtensionHarness = {
    readonly api: ExtensionAPI;
    readonly activeTools: readonly string[];
    readonly startSession: (ctx: ExtensionContext) => Promise<void>;
};

function makeExtensionHarness(initialActiveTools: readonly string[] = []): ExtensionHarness {
    let activeTools: string[] = [...initialActiveTools];
    let sessionStart: ExtensionSessionStartHandler | undefined;
    const api = {
        registerTool() {},
        registerCommand() {},
        registerMessageRenderer() {},
        on(eventName: string, handler: ExtensionSessionStartHandler) {
            if (eventName === "session_start") sessionStart = handler;
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
    };
}

type CodexCommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

type CodexCommandHarness = {
    readonly api: ExtensionAPI;
    readonly run: (args: string, ctx: ExtensionContext) => Promise<void>;
};

function makeCodexCommandHarness(): CodexCommandHarness {
    let handler: CodexCommandHandler | undefined;
    const api = {
        registerCommand(name: string, command: { readonly handler: CodexCommandHandler }) {
            if (name === "codex") handler = command.handler;
        },
    };
    return {
        // SAFETY: This fixture implements the ExtensionAPI member exercised by registerCodexCommand.
        api: api as unknown as ExtensionAPI,
        async run(args: string, ctx: ExtensionContext): Promise<void> {
            assert.ok(handler);
            await handler(args, ctx);
        },
    };
}

type TestExtensionModel = {
    readonly provider: string;
    readonly api: string;
    readonly id: string;
    readonly baseUrl: string;
    readonly input: readonly string[];
};

const DEFAULT_TEST_EXTENSION_MODEL: TestExtensionModel = {
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5.5",
    baseUrl: "https://chatgpt.com/backend-api",
    input: ["text", "image"],
};

function makeExtensionContext(
    cwd: string,
    trusted: boolean,
    model: TestExtensionModel = DEFAULT_TEST_EXTENSION_MODEL,
): ExtensionContext {
    const ctx = {
        cwd,
        hasUI: false,
        isProjectTrusted: () => trusted,
        model,
    };
    // SAFETY: This fixture supplies the fields read by session_start tool synchronization.
    return ctx as unknown as ExtensionContext;
}

function makeTestRuntime(
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

function makeBeforeCompactEvent(
    options: {
        readonly branchEntries?: readonly unknown[];
        readonly firstKeptEntryId?: string;
    } = {},
): SessionBeforeCompactEvent {
    const branchEntries = options.branchEntries ?? [
        messageEntry("entry-1", null, userMessage("keep this request")),
    ];
    const event = {
        type: "session_before_compact",
        branchEntries,
        preparation: {
            firstKeptEntryId: options.firstKeptEntryId ?? "entry-1",
            messagesToSummarize: [],
            turnPrefixMessages: [],
            isSplitTurn: false,
            tokensBefore: 123,
            fileOps: {
                read: new Set<string>(),
                written: new Set<string>(),
                edited: new Set<string>(),
            },
            settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 },
        },
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
    };
    // SAFETY: This fixture supplies the fields read by handleCodexNativeCompaction.
    return event as unknown as SessionBeforeCompactEvent;
}

function messageEntry(
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

function nativeCompactionEntry(options: {
    readonly id: string;
    readonly parentId?: string | null;
    readonly firstKeptEntryId: string;
    readonly model?: string;
}): Record<string, unknown> {
    const worldState = worldStateInput("window: 1");
    return {
        type: "compaction",
        id: options.id,
        parentId: options.parentId ?? null,
        timestamp: "2026-01-01T00:00:00.000Z",
        summary: NATIVE_COMPACTION_SHIM_SUMMARY,
        firstKeptEntryId: options.firstKeptEntryId,
        tokensBefore: 123,
        details: {
            strategy: "pi-codex-core-remote-compaction-v2",
            provider: "openai-codex",
            api: "openai-codex-responses",
            model: options.model ?? "gpt-5.5",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
            replacementInput: [{ type: "compaction", encrypted_content: "opaque" }, worldState],
            windowNumber: 1,
            windowId: "window-1",
            firstWindowId: "window-1",
            worldState: {
                cwd: "/workspace",
                model: `openai-codex/${options.model ?? "gpt-5.5"}`,
                activeToolNames: ["read"],
                readFiles: [],
                modifiedFiles: [],
                capturedAt: "2026-01-01T00:00:00.000Z",
            },
            createdAt: "2026-01-01T00:00:00.000Z",
        },
    };
}

function worldStateInput(extraLine = ""): Record<string, unknown> {
    return {
        role: "user",
        content: [
            {
                type: "input_text",
                text: [
                    "<codex_core_world_state>",
                    "Fresh Pi context after Codex native compaction.",
                    "cwd: /workspace",
                    "model: openai-codex/gpt-5.5",
                    "active tools: read",
                    extraLine,
                    "</codex_core_world_state>",
                ]
                    .filter(Boolean)
                    .join("\n"),
            },
        ],
    };
}

function userMessage(text: string): Record<string, unknown> {
    return { role: "user", content: text, timestamp: 0 };
}

function imageOnlyUserMessage(index: number): Record<string, unknown> {
    return {
        role: "user",
        content: [
            {
                type: "image",
                mimeType: "image/png",
                data: Buffer.from(`image-${index}`).toString("base64"),
            },
        ],
        timestamp: 0,
    };
}

function imageUrlsFromResponseItem(item: unknown): string[] {
    if (!isRecord(item) || !Array.isArray(item.content)) return [];
    return item.content.flatMap((part) =>
        isRecord(part) && part.type === "input_image" && typeof part.image_url === "string"
            ? [part.image_url]
            : [],
    );
}

function assistantMessage(content: readonly unknown[]): Record<string, unknown> {
    return {
        role: "assistant",
        provider: "openai-codex",
        api: "openai-codex-responses",
        model: "gpt-5.5",
        content,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
        stopReason: "toolUse",
        timestamp: 0,
    };
}

function toolResultMessage(toolCallId: string, text: string): Record<string, unknown> {
    return {
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: 0,
    };
}

function makeImageContext(cwd: string): ExtensionContext {
    const ctx = {
        cwd,
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.5",
            baseUrl: "https://chatgpt.com/backend-api",
            input: ["text", "image"],
        },
        sessionManager: {
            getSessionId: () => "session/1",
        },
    };
    // SAFETY: This test only exercises cwd, model image support, and session id lookup.
    return ctx as unknown as ExtensionContext;
}

function makeUsageContext(modelBaseUrl: string): ExtensionContext {
    const ctx = {
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.5",
            baseUrl: modelBaseUrl,
            headers: {},
        },
        modelRegistry: {
            getApiKeyAndHeaders: async () => ({
                ok: true,
                apiKey: "usage-token",
                headers: { "chatgpt-account-id": "usage-account" },
            }),
        },
    };
    // SAFETY: This test context supplies the model and auth fields read by Codex usage.
    return ctx as unknown as ExtensionContext;
}

function makeToolAuthContext(auth: {
    readonly apiKey?: string | undefined;
    readonly headers?: Record<string, string> | undefined;
}): ExtensionContext {
    const ctx = {
        cwd: "/workspace",
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.5",
            baseUrl: "https://chatgpt.com/backend-api",
        },
        modelRegistry: {
            getApiKeyAndHeaders: async () => ({
                ok: true,
                apiKey: auth.apiKey,
                headers: auth.headers ?? {},
            }),
        },
    };
    // SAFETY: This test context supplies only the model registry fields read by Codex auth.
    return ctx as unknown as ExtensionContext;
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

function makeWebRunContextWithBranch(
    cwd: string,
    branchEntries: readonly Record<string, unknown>[],
): ExtensionContext {
    const base = makeWebRunContext(cwd);
    const ctx = {
        ...base,
        sessionManager: {
            getSessionId: () => "session/1",
            getBranch: () => branchEntries,
        },
    };
    // SAFETY: This test context changes only the session branch fixture used by image lookup.
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

function makeCompactionApi(): ExtensionAPI {
    const api = {
        getActiveTools: () => ["read"],
        getAllTools: () => [
            {
                name: "read",
                description: "Read a file.",
                parameters: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: ["path"],
                },
                promptGuidelines: [],
                sourceInfo: { type: "extension", name: "test" },
            },
            {
                name: "write",
                description: "Write a file.",
                parameters: { type: "object", properties: {} },
                promptGuidelines: [],
                sourceInfo: { type: "extension", name: "test" },
            },
        ],
    };
    // SAFETY: Compaction tests only exercise getActiveTools and getAllTools.
    return api as unknown as ExtensionAPI;
}

function makeNativeCompactionContext(
    options: { readonly contextWindow?: number; readonly sessionId?: string } = {},
): ExtensionContext {
    const ctx = {
        hasUI: false,
        cwd: "/workspace",
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.5",
            baseUrl: "https://chatgpt.com/backend-api",
            input: ["text", "image"],
            contextWindow: options.contextWindow ?? 200_000,
        },
        modelRegistry: {
            getApiKeyAndHeaders: async () => ({
                ok: true,
                apiKey: makeCodexJwtAccountToken("account"),
                headers: {},
            }),
        },
        sessionManager: {
            getSessionId: () => options.sessionId ?? "session-1",
            getBranch: () => [],
        },
        getSystemPrompt: () => "system prompt",
    };
    // SAFETY: This test exercises a function that only reads these context fields.
    return ctx as unknown as ExtensionContext;
}

function makeAutoCompactionContext(
    compactCalls: unknown[],
    idle: { readonly value: boolean },
): ExtensionContext {
    const ctx = {
        hasUI: false,
        cwd: "/workspace",
        isIdle: () => idle.value,
        getContextUsage: () => ({ tokens: 90, contextWindow: 100, percent: 90 }),
        compact: (options: unknown) => {
            compactCalls.push(options);
            if (isRecord(options) && typeof options.onComplete === "function") {
                options.onComplete({ summary: "ok", firstKeptEntryId: "entry", tokensBefore: 90 });
            }
        },
        sessionManager: {
            getSessionId: () => "auto-session-1",
            getBranch: () => [{ type: "message", id: "entry-auto" }],
        },
    };
    // SAFETY: This test exercises only fields read by scheduleCodexAutoCompaction.
    return ctx as unknown as ExtensionContext;
}

function makeCompactionContext(
    options: {
        readonly warnings?: string[];
        readonly sessionId?: string;
        readonly branchEntries?: readonly Record<string, unknown>[];
    } = {},
): ExtensionContext {
    const ctx = {
        hasUI: Boolean(options.warnings),
        ...(options.warnings
            ? {
                  ui: {
                      notify: (message: string) => {
                          options.warnings?.push(message);
                      },
                  },
              }
            : {}),
        cwd: "/workspace",
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.4-mini",
            baseUrl: "https://chatgpt.com/backend-api",
            input: ["text", "image"],
            contextWindow: 200_000,
        },
        sessionManager: {
            getSessionId: () => options.sessionId ?? "session-1",
            getBranch: () =>
                options.branchEntries ?? [
                    messageEntry("pre", null, userMessage("pre kept")),
                    nativeCompactionEntry({
                        id: "compact",
                        parentId: "pre",
                        firstKeptEntryId: "pre",
                        model: "gpt-5.4-mini",
                    }),
                    messageEntry("tail", "compact", userMessage("post tail")),
                ],
        },
    };
    // SAFETY: This test exercises a function that only reads model, UI notification, and sessionManager fields.
    return ctx as unknown as ExtensionContext;
}

function responseInput(value: unknown): unknown[] {
    assert.ok(isRecord(value));
    assert.ok(Array.isArray(value.input));
    return value.input;
}

function worldStateText(item: unknown): string {
    if (!isRecord(item) || !Array.isArray(item.content)) return "";
    return item.content
        .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
        .join("\n");
}

function textFromResponseItem(item: unknown): string {
    if (!isRecord(item)) return "";
    if (typeof item.content === "string") return item.content;
    if (!Array.isArray(item.content)) return "";
    return item.content
        .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
        .join("\n");
}

function solidPngBytes(
    width: number,
    height: number,
    rgba: readonly [number, number, number, number],
): Buffer {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let pixelOffset = 1; pixelOffset < row.length; pixelOffset += 4) {
        row[pixelOffset] = rgba[0];
        row[pixelOffset + 1] = rgba[1];
        row[pixelOffset + 2] = rgba[2];
        row[pixelOffset + 3] = rgba[3];
    }
    const raw = Buffer.alloc(row.length * height);
    for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
        row.copy(raw, rowIndex * row.length);
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    header[10] = 0;
    header[11] = 0;
    header[12] = 0;

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBytes = Buffer.from(type, "ascii");
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
    return Buffer.concat([length, typeBytes, data, checksum]);
}

const CRC32_TABLE = makeCrc32Table();

function makeCrc32Table(): Uint32Array {
    const table = new Uint32Array(256);
    for (let tableIndex = 0; tableIndex < table.length; tableIndex += 1) {
        let value = tableIndex;
        for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[tableIndex] = value;
    }
    return table;
}

function crc32(bytes: Buffer): number {
    let value = 0xffffffff;
    for (const byte of bytes) {
        value = (value >>> 8) ^ (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0);
    }
    return Uint32Array.of(value ^ 0xffffffff)[0] ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
