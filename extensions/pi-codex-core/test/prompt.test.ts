import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "vitest";
import type { BuildSystemPromptOptions, Skill } from "@earendil-works/pi-coding-agent";
import { supportsCodexPromptPersonality } from "../src/prompt/personality.ts";
import {
    buildCodexCoreSystemPrompt,
    buildCodexCoreSystemPromptResult,
} from "../src/prompt/system-prompt.ts";
import { DEFAULT_CODEX_CORE_CONFIG, parseCodexCoreConfig } from "../src/config/config.ts";

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

    const prompt = buildCodexCoreSystemPrompt(piPrompt, config, options, {
        modelId: "gpt-5.6-sol",
    });

    assert.match(prompt, /^You are Codex, an agent based on GPT-5/);
    assert.match(prompt, /# Destructive Actions/);
    assert.match(prompt, /Never repurpose `\$HOME`, `\$home`, or `\$CODEX_HOME`/);
    assert.doesNotMatch(prompt, /You are an expert coding assistant operating inside pi/);
    assert.doesNotMatch(prompt, /Codex CLI/);
    assert.doesNotMatch(prompt, /Codex-style/);
    assert.doesNotMatch(prompt, /update_plan/);
    assert.doesNotMatch(prompt, /apply_patch/);
    assert.doesNotMatch(prompt, /exec_command/);
    assert.doesNotMatch(prompt, /multi_tool_use\.parallel/);
    assert.doesNotMatch(prompt, /skills\.(?:list|read)/);
    assert.doesNotMatch(prompt, /subagents?/i);
    assert.doesNotMatch(prompt, /Sandbox and approvals/);
    assert.doesNotMatch(prompt, /approval mode/);
    assert.doesNotMatch(prompt, /# Pi Context/);
    assert.doesNotMatch(prompt, /# Pi Codex Core/);
    assert.doesNotMatch(prompt, /Available Codex-compatible tools/);
    assert.doesNotMatch(prompt, /Codex tool scope/);
    assert.doesNotMatch(prompt, /following Pi-provided/);
    assert.match(prompt, /Available tools:\n- read: Read file contents/);
    assert.equal(prompt.split("Available tools:").length - 1, 1);
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

test("preserves append-style system instructions from earlier extensions", () => {
    const config = parseCodexCoreConfig({ prompt: { mode: "codex" } });
    const options: BuildSystemPromptOptions = {
        cwd: "/workspace",
        selectedTools: ["read"],
        toolSnippets: { read: "Read files." },
    };
    const sentinel = "Earlier extension sentinel: retain this instruction.";
    const result = buildCodexCoreSystemPromptResult(
        `You are an expert coding assistant operating inside pi, a coding agent harness.\nCurrent working directory: /workspace\n\n${sentinel}`,
        config,
        options,
        { modelId: "gpt-5.6-sol" },
    );

    assert.equal(result.interop, "preserved-append");
    assert.equal(result.prompt.split(sentinel).length - 1, 1);
    assert.doesNotMatch(
        result.prompt,
        /You are an expert coding assistant operating inside pi, a coding agent harness/,
    );
});

test("reports earlier full system-prompt replacements that cannot be merged safely", () => {
    const result = buildCodexCoreSystemPromptResult(
        "A completely replaced prompt.\nCurrent working directory: /workspace",
        parseCodexCoreConfig({ prompt: { mode: "codex" } }),
        { cwd: "/workspace" },
        { modelId: "gpt-5.6-sol" },
    );

    assert.equal(result.interop, "unrecognized-replacement");
    assert.doesNotMatch(result.prompt, /A completely replaced prompt/);
});

test("selects Codex prompts by active GPT model and preserves Pi mode", () => {
    const codexConfig = parseCodexCoreConfig({
        ...DEFAULT_CODEX_CORE_CONFIG,
        prompt: { mode: "codex" },
    });
    const piConfig = parseCodexCoreConfig({
        ...DEFAULT_CODEX_CORE_CONFIG,
        prompt: { mode: "pi" },
    });
    const piPrompt = "Pi system prompt";
    const options: BuildSystemPromptOptions = {
        cwd: "/workspace",
        selectedTools: ["read", "bash", "edit"],
        toolSnippets: {
            read: "Read files.",
            bash: "Run shell commands.",
            edit: "Edit files.",
        },
    };
    const sol = buildCodexCoreSystemPrompt(piPrompt, codexConfig, options, {
        modelId: "gpt-5.6-sol",
    });
    const terra = buildCodexCoreSystemPrompt(piPrompt, codexConfig, options, {
        modelId: "gpt-5.6-terra",
    });
    const luna = buildCodexCoreSystemPrompt(piPrompt, codexConfig, options, {
        modelId: "gpt-5.6-luna",
    });
    const gpt55 = buildCodexCoreSystemPrompt(piPrompt, codexConfig, options, {
        modelId: "gpt-5.5",
    });

    assert.equal(sol, terra);
    assert.equal(terra, luna);
    assert.match(sol, /# Destructive Actions/);
    assert.match(gpt55, /## Engineering judgment/);
    assert.match(gpt55, /You are a deeply pragmatic, effective software engineer/);
    assert.match(gpt55, /# Using skills/);
    assert.match(gpt55, /read that skill's `SKILL\.md` completely before acting/);
    assert.equal(sol.split("# Using skills").length - 1, 1);
    assert.equal(gpt55.split("# Using skills").length - 1, 1);
    assert.match(sol, /Use `edit` for local file edits/);
    assert.match(gpt55, /Use `edit` for manual code edits/);
    assert.doesNotMatch(
        `${sol}\n${terra}\n${gpt55}`,
        /`apply_patch`|exec_command|multi_tool_use\.parallel|skills\.(?:list|read)|subagents?/i,
    );
    assert.equal(
        buildCodexCoreSystemPrompt(piPrompt, codexConfig, options, { modelId: "claude-sonnet" }),
        piPrompt,
    );
    assert.equal(buildCodexCoreSystemPrompt(piPrompt, codexConfig, options), piPrompt);
    assert.equal(
        buildCodexCoreSystemPrompt(piPrompt, piConfig, options, { modelId: "gpt-5.6-sol" }),
        piPrompt,
    );
});

test("renders Codex personality variants only for supported bundled prompts", () => {
    const options: BuildSystemPromptOptions = {
        cwd: "/workspace",
        selectedTools: ["read", "bash", "edit"],
        toolSnippets: { read: "Read files.", bash: "Run shell commands.", edit: "Edit files." },
    };
    const build = (personality: "friendly" | "pragmatic" | "none", modelId = "gpt-5.5") =>
        buildCodexCoreSystemPrompt(
            "Pi system prompt",
            parseCodexCoreConfig({ prompt: { mode: "codex", personality } }),
            options,
            { modelId },
        );

    const friendly = build("friendly");
    const pragmatic = build("pragmatic");
    const none = build("none");
    assert.match(friendly, /You have a vivid inner life as Codex/);
    assert.doesNotMatch(friendly, /You are a deeply pragmatic, effective software engineer/);
    assert.match(pragmatic, /You are a deeply pragmatic, effective software engineer/);
    assert.doesNotMatch(pragmatic, /You have a vivid inner life as Codex/);
    assert.doesNotMatch(none, /# Personality|\{\{ personality \}\}/);
    assert.match(none, /# General/);

    assert.equal(build("friendly", "gpt-5.6-sol"), build("none", "gpt-5.6-sol"));
    assert.equal(supportsCodexPromptPersonality("GPT-5.5"), true);
    assert.equal(supportsCodexPromptPersonality("gpt-5.6-sol"), false);
    assert.equal(supportsCodexPromptPersonality("gpt-5.4"), false);
});

test("removes unavailable shell and editing assumptions from Codex prompts", () => {
    const config = parseCodexCoreConfig({
        ...DEFAULT_CODEX_CORE_CONFIG,
        prompt: { mode: "codex" },
    });
    const readOnlyPrompt = buildCodexCoreSystemPrompt(
        "Pi system prompt",
        config,
        {
            cwd: "/workspace",
            selectedTools: ["read"],
            toolSnippets: { read: "Read files." },
        },
        { modelId: "gpt-5.6-sol" },
    );
    const toolLessPrompt = buildCodexCoreSystemPrompt(
        "Pi system prompt",
        config,
        { cwd: "/workspace", selectedTools: [], toolSnippets: {} },
        { modelId: "gpt-5.5" },
    );

    assert.doesNotMatch(readOnlyPrompt, /exec_command|`bash`|file-editing tool|git reset|`rg`/);
    assert.doesNotMatch(
        toolLessPrompt,
        /exec_command|`bash`|file-editing tool|git reset|multi_tool_use\.parallel|`rg`/,
    );
    assert.match(readOnlyPrompt, /Available tools:\n- read: Read files\./);
    assert.match(toolLessPrompt, /Available tools:\n\(none\)/);
});

test("adapts Astra code-mode and question guidance to active Pi capabilities", () => {
    const config = parseCodexCoreConfig({ prompt: { mode: "codex" } });
    const render = (selectedTools: string[]) =>
        buildCodexCoreSystemPrompt(
            "Pi prompt",
            config,
            {
                cwd: "/workspace",
                selectedTools,
                appendSystemPrompt: "Custom functions.exec instruction must survive.",
            },
            { modelId: "gpt-6-astra" },
        );
    const questionPrompt = render(["read", "bash", "ask_user_question"]);
    assert.match(questionPrompt, /^You are Codex, an agent based on GPT-6\./);
    assert.match(questionPrompt, /Use `ask_user_question` with its declared schema/);
    assert.match(questionPrompt, /This tool waits for the user's response/);
    assert.match(questionPrompt, /Elapsed time is not an answer or approval/);
    assert.match(questionPrompt, /Batch independent searches and reads using Pi's tool interface/);
    assert.match(questionPrompt, /`command` argument/);
    assert.doesNotMatch(
        questionPrompt,
        /functions\.request_user_input_async|Promise\.allSettled|When calling `functions\.exec`|exec_command/,
    );
    assert.equal(questionPrompt.split("functions.exec").length - 1, 1);
    assert.doesNotMatch(questionPrompt, /skills\.(?:list|read)|tool_search|codex_apps|# Plugins/);
    const asyncPrompt = render(["read", "request_user_input_async"]);
    assert.match(asyncPrompt, /`request_user_input_async` tool/);
    assert.match(
        asyncPrompt,
        /continue useful work that does not depend on the answer while waiting/,
    );
    assert.match(asyncPrompt, /Elapsed time is not an answer or approval/);
    assert.doesNotMatch(asyncPrompt, /ask_user_question|exec_command/);
    const noQuestionTool = render([]);
    assert.match(noQuestionTool, /Ask the user directly for missing information/);
    assert.match(noQuestionTool, /Elapsed time is not an answer or approval/);
    assert.doesNotMatch(
        noQuestionTool,
        /request_user_input_async|ask_user_question|exec_command|`rg`/,
    );
    assert.equal(supportsCodexPromptPersonality("gpt-6-astra"), false);
});

test("bundled Codex prompts match the pinned upstream content", async () => {
    const prompts = [
        [
            new URL("../src/prompt/codex-gpt-6-astra.md", import.meta.url),
            "152dfaeeb552876190962be1c12c93d426840ff12691f648261554a7675a6698",
        ],
        [
            new URL("../src/prompt/codex-gpt-5.6-sol.md", import.meta.url),
            "cbefa6b0bede0e332d957fca70ccacf9f12f4c0ecdf81b819e5cbe1a3b16e265",
        ],
        [
            new URL("../src/prompt/codex-gpt-5.6-terra-luna.md", import.meta.url),
            "cbefa6b0bede0e332d957fca70ccacf9f12f4c0ecdf81b819e5cbe1a3b16e265",
        ],
        [
            new URL("../src/prompt/codex-gpt-5.5.md", import.meta.url),
            "c13cc50bc068912608769224bf2c5ffcb5f534856fd631f3df0ef72a8a3108a4",
        ],
        [
            new URL("../src/prompt/codex-gpt-5.5-personality-friendly.md", import.meta.url),
            "534873b3132a3e1db9782ffe8de56e64b2c74eb7e190aa2d0e7a0335fac09d50",
        ],
        [
            new URL("../src/prompt/codex-gpt-5.5-personality-pragmatic.md", import.meta.url),
            "5ef72df6e1e414b4373b05c7db0340fa2e8254859b4551ae4441043da7ceac81",
        ],
    ] as const;

    for (const [promptUrl, expectedHash] of prompts) {
        const prompt = await readFile(promptUrl);
        assert.equal(createHash("sha256").update(prompt).digest("hex"), expectedHash);
    }
});
