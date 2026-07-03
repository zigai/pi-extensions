import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import assert from "node:assert/strict";
import { test } from "vitest";

import type {
    BuildSystemPromptOptions,
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
    Skill,
    Theme,
} from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";

import { packageName, extensionName } from "../src/index.ts";
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
    handleCodexNativeCompaction,
    NATIVE_COMPACTION_SHIM_SUMMARY,
    rewriteProviderRequestWithNativeCompaction,
    scheduleCodexAutoCompaction,
} from "../src/compaction.ts";
import { codexPromptImageTargetDimensions, saveGeneratedImage } from "../src/image-content.ts";
import { createImagegenTool } from "../src/tools/imagegen.ts";
import { createViewImageTool } from "../src/tools/view-image.ts";
import { formatWebRunToolOutput } from "../src/tools/web-run-output.ts";
import { createWebRunTool } from "../src/tools/web-run.ts";
import type { CodexRuntime, ScheduledTask } from "../src/runtime.ts";
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
        compaction: { enabled: true, auto: false, thresholdPercent: 90 },
        openai: { verbosity: "high", compactionReasoning: "low" },
    });

    assert.equal(config.scope.tools, "all");
    assert.equal(config.tools.webSearch, false);
    assert.equal(config.tools.imageGeneration, DEFAULT_CODEX_CORE_CONFIG.tools.imageGeneration);
    assert.equal(config.tools.viewImageDescriptions, true);
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

test("computes Codex prompt image target dimensions", () => {
    assert.deepEqual(codexPromptImageTargetDimensions(2304, 864), {
        width: 2048,
        height: 768,
    });
    assert.deepEqual(codexPromptImageTargetDimensions(1024, 4096), {
        width: 512,
        height: 2048,
    });
    assert.deepEqual(codexPromptImageTargetDimensions(2048, 2048), {
        width: 1600,
        height: 1600,
    });
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

        const image = result.content.find(
            (
                item,
            ): item is {
                readonly type: "image";
                readonly data: string;
                readonly mimeType: string;
            } =>
                isRecord(item) &&
                item.type === "image" &&
                typeof item.data === "string" &&
                typeof item.mimeType === "string",
        );
        assert.ok(image);
        const dimensions = getImageDimensions(image.data, image.mimeType);
        assert.deepEqual(dimensions, { widthPx: 1600, heightPx: 1600 });
    } finally {
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
    const runtime = makeTestRuntime(
        async () =>
            new Response(JSON.stringify({ output: "1. Pi\n   URL: https://pi.dev/" }), {
                status: 200,
            }),
    );

    try {
        await mkdir(cwd, { recursive: true });
        const webRunTool = createWebRunTool({
            getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
            runtime,
            agentDir,
        });
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
        await rm(root, { recursive: true, force: true });
    }
});

test("saves generated images at the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-"));
    const cwd = join(root, "workspace");

    try {
        await mkdir(cwd, { recursive: true });
        const base64 = Buffer.from("not really a png").toString("base64");
        const saved = await saveGeneratedImage({
            cwd,
            toolCallId: "call*1",
            index: 0,
            base64,
        });

        assert.equal(saved.path, join(cwd, "call_1.png"));
        assert.equal(saved.latestPath, join(cwd, "latest.png"));
        assert.equal((await readFile(saved.absolutePath)).toString("utf8"), "not really a png");
        assert.equal(
            (await readFile(saved.latestAbsolutePath)).toString("utf8"),
            "not really a png",
        );
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
    assert.deepEqual(result?.compaction?.details.replacementInput.slice(0, 2), [
        {
            role: "user",
            content: [{ type: "input_text", text: "keep this request" }],
        },
        { type: "compaction", encrypted_content: "sealed" },
    ]);
    const worldState = result?.compaction?.details.replacementInput.at(2);
    assert.ok(isRecord(worldState));
    assert.match(worldStateText(worldState), /<codex_core_world_state>/);
    assert.match(worldStateText(worldState), /cwd: \/workspace/);
    assert.match(worldStateText(worldState), /model: openai-codex\/gpt-5\.5/);
    assert.match(worldStateText(worldState), /active tools: read/);
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
        makeNativeCompactionContext({ contextWindow: 180 }),
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

    const retainedImageUrls = (result?.compaction?.details.compactedWindow ?? []).flatMap(
        imageUrlsFromResponseItem,
    );
    assert.ok(retainedImageUrls.length > 0);
    assert.ok(retainedImageUrls.length < 80);
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
    };
    // SAFETY: This test only exercises cwd and model image support.
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
    options: { readonly contextWindow?: number } = {},
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
            getSessionId: () => "session-1",
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
    options: { readonly warnings?: string[]; readonly sessionId?: string } = {},
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
            getBranch: () => [
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
