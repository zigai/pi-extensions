import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
    formatSkillsForPrompt,
    getDocsPath,
    getExamplesPath,
    getReadmePath,
    type BuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";

import type { CodexCoreConfig } from "./config.ts";
import { supportsCodexPromptPersonality } from "./codex-personality.ts";
import { defaultCodexRuntime, type Clock } from "./runtime.ts";

const FALLBACK_CODEX_PROMPT_PATH = fileURLToPath(
    new URL("./prompt/codex-fallback-prompt.md", import.meta.url),
);
const GPT_5_5_CODEX_PROMPT_PATH = fileURLToPath(
    new URL("./prompt/codex-gpt-5.5.md", import.meta.url),
);
const GPT_5_6_SOL_CODEX_PROMPT_PATH = fileURLToPath(
    new URL("./prompt/codex-gpt-5.6-sol.md", import.meta.url),
);
const GPT_5_6_TERRA_LUNA_CODEX_PROMPT_PATH = fileURLToPath(
    new URL("./prompt/codex-gpt-5.6-terra-luna.md", import.meta.url),
);
const GPT_5_5_FRIENDLY_PERSONALITY_PATH = fileURLToPath(
    new URL("./prompt/codex-gpt-5.5-personality-friendly.md", import.meta.url),
);
const GPT_5_5_PRAGMATIC_PERSONALITY_PATH = fileURLToPath(
    new URL("./prompt/codex-gpt-5.5-personality-pragmatic.md", import.meta.url),
);
const CODEX_PROMPT_PATHS_BY_MODEL: Readonly<Record<string, string>> = {
    "gpt-5.5": GPT_5_5_CODEX_PROMPT_PATH,
    "gpt-5.6-sol": GPT_5_6_SOL_CODEX_PROMPT_PATH,
    "gpt-5.6-terra": GPT_5_6_TERRA_LUNA_CODEX_PROMPT_PATH,
    "gpt-5.6-luna": GPT_5_6_TERRA_LUNA_CODEX_PROMPT_PATH,
};
const cachedCodexPromptsByPath = new Map<string, string>();
const CODEX_PERSONALITY_PLACEHOLDER = "{{ personality }}";

const DEFAULT_PI_TOOLS: readonly string[] = ["read", "bash", "edit", "write"];

/** Runtime values used to select and render the active model's Codex prompt. */
export type CodexSystemPromptContext = {
    readonly modelId?: string | undefined;
    readonly clock?: Clock | undefined;
};

/** Builds either Pi's original prompt or the active GPT model's Pi-adapted Codex prompt. */
export function buildCodexCoreSystemPrompt(
    basePrompt: string,
    config: CodexCoreConfig,
    options?: BuildSystemPromptOptions,
    context: CodexSystemPromptContext = {},
): string {
    if (config.prompt.mode !== "codex" || !isGptPromptModel(context.modelId)) return basePrompt;

    const tools = options ? selectedTools(options) : DEFAULT_PI_TOOLS;
    const codexPrompt = adaptCodexPromptForPi(
        renderCodexPrompt(context.modelId, config.prompt.personality),
        tools,
    );
    const piContext = buildPiCodexContext(
        basePrompt,
        options,
        context.clock ?? defaultCodexRuntime.clock,
    );
    return [codexPrompt, piContext].filter((section) => section.length > 0).join("\n\n");
}

function isGptPromptModel(modelId: string | undefined): boolean {
    return modelId?.trim().toLowerCase().startsWith("gpt-") ?? false;
}

function readCodexPrompt(modelId: string | undefined): string {
    const normalizedModelId = modelId?.trim().toLowerCase();
    const promptPath =
        (normalizedModelId ? CODEX_PROMPT_PATHS_BY_MODEL[normalizedModelId] : undefined) ??
        FALLBACK_CODEX_PROMPT_PATH;
    return readPromptFile(promptPath);
}

function renderCodexPrompt(
    modelId: string | undefined,
    personality: CodexCoreConfig["prompt"]["personality"],
): string {
    const prompt = readCodexPrompt(modelId);
    if (!supportsCodexPromptPersonality(modelId)) return prompt;
    const personalityPrompt =
        personality === "friendly"
            ? readPromptFile(GPT_5_5_FRIENDLY_PERSONALITY_PATH)
            : personality === "pragmatic"
              ? readPromptFile(GPT_5_5_PRAGMATIC_PERSONALITY_PATH)
              : "";
    return prompt.replace(CODEX_PERSONALITY_PLACEHOLDER, personalityPrompt).trim();
}

function readPromptFile(promptPath: string): string {
    const cachedPrompt = cachedCodexPromptsByPath.get(promptPath);
    if (cachedPrompt !== undefined) return cachedPrompt;
    const prompt = readFileSync(promptPath, "utf8").trim();
    cachedCodexPromptsByPath.set(promptPath, prompt);
    return prompt;
}

function adaptCodexPromptForPi(prompt: string, tools: readonly string[]): string {
    const hasShellTool = tools.includes("bash");
    const editTool = tools.includes("apply_patch")
        ? "`apply_patch`"
        : tools.includes("edit")
          ? "`edit`"
          : tools.includes("write")
            ? "`write`"
            : undefined;
    let adaptedPrompt = prompt;
    if (hasShellTool) {
        adaptedPrompt = adaptedPrompt
            .replaceAll("`exec_command`", "`bash`")
            .replaceAll("exec_command", "`bash`");
    } else {
        adaptedPrompt = removeLineContaining(adaptedPrompt, "exec_command calls").replace(
            " Do not end your turn while `exec_command` sessions needed for the user’s request are still running.",
            "",
        );
        adaptedPrompt = removeLineContaining(adaptedPrompt, "reach first for `rg`");
        adaptedPrompt = removeLineContaining(adaptedPrompt, "When you search for text or files");
        adaptedPrompt = removeLineContaining(adaptedPrompt, "Do not chain shell commands");
        adaptedPrompt = removeLineContaining(adaptedPrompt, "You parallelize tool calls whenever");
    }
    if (editTool) {
        adaptedPrompt = adaptedPrompt.replaceAll("`apply_patch`", editTool);
    } else {
        adaptedPrompt = adaptedPrompt
            .replace(
                "Use `apply_patch` for local file edits.",
                "Do not edit files unless an active Pi file-editing tool is available.",
            )
            .replace(
                "Use `apply_patch` for manual code edits.",
                "Do not edit files unless an active Pi file-editing tool is available.",
            )
            .replaceAll("`apply_patch`", "an active Pi file-editing tool");
    }
    if (!hasShellTool && !editTool) {
        adaptedPrompt = removeMarkdownSection(
            adaptedPrompt,
            "## File editing constraints",
            "## Autonomy and persistence",
        );
        adaptedPrompt = removeMarkdownSection(
            adaptedPrompt,
            "## Editing constraints",
            "## Special user requests",
        );
    }
    adaptedPrompt = adaptedPrompt.replace(
        "You use `multi_tool_use.parallel` for that parallelism, and only that.",
        "Use Pi's parallel tool interface for that parallelism when it is available.",
    );
    const skillsHeading = "\n# Using skills";
    const skillsIndex = adaptedPrompt.indexOf(skillsHeading);
    if (skillsIndex < 0) return adaptedPrompt;
    const promptWithoutCodexSkills = adaptedPrompt.slice(0, skillsIndex).trimEnd();
    if (!tools.includes("read")) return promptWithoutCodexSkills;
    return [promptWithoutCodexSkills, buildPiSkillUsageGuidance()].join("\n\n");
}

function removeLineContaining(prompt: string, marker: string): string {
    return prompt
        .split("\n")
        .filter((line) => !line.includes(marker))
        .join("\n");
}

function removeMarkdownSection(prompt: string, heading: string, nextHeading: string): string {
    const sectionStart = prompt.indexOf(`${heading}\n`);
    if (sectionStart < 0) return prompt;
    const nextSectionStart = prompt.indexOf(`${nextHeading}\n`, sectionStart);
    if (nextSectionStart < 0) return prompt.slice(0, sectionStart).trimEnd();
    return `${prompt.slice(0, sectionStart).trimEnd()}\n\n${prompt.slice(nextSectionStart)}`;
}

function buildPiSkillUsageGuidance(): string {
    return [
        "# Using skills",
        "",
        "Pi may provide specialized skills in the available-skills catalog below.",
        "",
        "- When the user names a listed skill, or the task clearly matches its description, read that skill's `SKILL.md` completely before acting.",
        "- Resolve relative references from the directory containing `SKILL.md`, and read every referenced instruction needed for the task.",
        "- Do not delegate reading or interpreting skill instructions. Prefer provided scripts, assets, and templates when applicable.",
        "- If a requested skill is unavailable or cannot be read, say so briefly and continue with the best available approach.",
    ].join("\n");
}

function buildPiCodexContext(
    basePrompt: string,
    options: BuildSystemPromptOptions | undefined,
    clock: Clock,
): string {
    if (!options) return basePrompt;

    return [
        buildPiToolsSection(options),
        buildPiGuidelinesSection(options),
        buildPiDocumentationSection(),
        buildPiCustomPromptSection(options),
        buildPiAppendPromptSection(options),
        buildPiProjectContextSection(options),
        buildPiSkillsSection(options),
        buildPiRuntimeContextSection(basePrompt, options, clock),
    ]
        .filter((section) => section.length > 0)
        .join("\n\n");
}

function buildPiToolsSection(options: BuildSystemPromptOptions): string {
    const tools = selectedTools(options);
    const snippets = options.toolSnippets ?? {};
    const lines = ["Available tools:"];

    if (tools.length === 0) {
        lines.push("(none)");
    } else {
        for (const toolName of tools) {
            const snippet = snippets[toolName]?.trim();
            lines.push(
                `- ${toolName}: ${snippet && snippet.length > 0 ? snippet : "Available Pi tool."}`,
            );
        }
    }

    lines.push(
        "",
        "In addition to the tools above, you may have access to other custom tools depending on the project.",
    );
    return lines.join("\n");
}

function buildPiGuidelinesSection(options: BuildSystemPromptOptions): string {
    const tools = selectedTools(options);
    const guidelines: string[] = [];
    const seenGuidelines = new Set<string>();
    const addGuideline = (guideline: string): void => {
        const normalized = guideline.trim();
        if (normalized.length === 0 || seenGuidelines.has(normalized)) return;
        seenGuidelines.add(normalized);
        guidelines.push(normalized);
    };

    if (
        tools.includes("bash") &&
        !tools.includes("grep") &&
        !tools.includes("find") &&
        !tools.includes("ls")
    ) {
        addGuideline("Use bash for file operations like ls, rg, find");
    }
    for (const guideline of options.promptGuidelines ?? []) addGuideline(guideline);
    addGuideline("Be concise in your responses");
    addGuideline("Show file paths clearly when working with files");

    if (guidelines.length === 0) return "";
    return ["Guidelines:", ...guidelines.map((guideline) => `- ${guideline}`)].join("\n");
}

function buildPiDocumentationSection(): string {
    return [
        "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
        `- Main documentation: ${getReadmePath()}`,
        `- Additional docs: ${getDocsPath()}`,
        `- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)`,
        "- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
        "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
        "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
        "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
    ].join("\n");
}

function buildPiCustomPromptSection(options: BuildSystemPromptOptions): string {
    const customPrompt = options.customPrompt?.trim();
    if (!customPrompt) return "";
    return ["Additional system instructions:", customPrompt].join("\n");
}

function buildPiAppendPromptSection(options: BuildSystemPromptOptions): string {
    const appendSystemPrompt = options.appendSystemPrompt?.trim();
    if (!appendSystemPrompt) return "";
    return appendSystemPrompt;
}

function buildPiProjectContextSection(options: BuildSystemPromptOptions): string {
    const contextFiles = options.contextFiles ?? [];
    if (contextFiles.length === 0) return "";

    const lines = ["<project_context>", "", "Project-specific instructions and guidelines:", ""];
    for (const { path: filePath, content } of contextFiles) {
        lines.push(
            `<project_instructions path="${filePath}">`,
            content,
            "</project_instructions>",
            "",
        );
    }
    lines.push("</project_context>");
    return lines.join("\n");
}

function buildPiSkillsSection(options: BuildSystemPromptOptions): string {
    if (!selectedTools(options).includes("read")) return "";
    const skills = options.skills ?? [];
    if (skills.length === 0) return "";
    return formatSkillsForPrompt(skills);
}

function buildPiRuntimeContextSection(
    basePrompt: string,
    options: BuildSystemPromptOptions,
    clock: Clock,
): string {
    const dateLine =
        findLastLineStartingWith(basePrompt, "Current date:") ?? currentDateLine(clock);
    const cwdLine =
        findLastLineStartingWith(basePrompt, "Current working directory:") ??
        `Current working directory: ${options.cwd.replace(/\\/g, "/")}`;
    return [dateLine, cwdLine].join("\n");
}

function selectedTools(options: BuildSystemPromptOptions): readonly string[] {
    return options.selectedTools ?? DEFAULT_PI_TOOLS;
}

function findLastLineStartingWith(text: string, prefix: string): string | undefined {
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (line !== undefined && line.startsWith(prefix)) return line;
    }
    return undefined;
}

function currentDateLine(clock: Clock): string {
    const now = clock.nowDate();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `Current date: ${year}-${month}-${day}`;
}
