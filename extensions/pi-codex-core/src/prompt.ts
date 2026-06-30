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

const CODEX_BASE_PROMPT_PATH = fileURLToPath(
    new URL("./prompt/codex-base-prompt.md", import.meta.url),
);
let cachedCodexBasePrompt: string | undefined;

const DEFAULT_PI_TOOLS: readonly string[] = ["read", "bash", "edit", "write"];

export function buildCodexCoreSystemPrompt(
    basePrompt: string,
    config: CodexCoreConfig,
    options?: BuildSystemPromptOptions,
): string {
    if (config.prompt.mode === "codex") {
        return [readCodexBasePrompt(), buildPiCodexContext(basePrompt, options)]
            .filter((section) => section.length > 0)
            .join("\n\n");
    }
    return basePrompt;
}

function readCodexBasePrompt(): string {
    cachedCodexBasePrompt ??= readFileSync(CODEX_BASE_PROMPT_PATH, "utf8").trim();
    return cachedCodexBasePrompt;
}

function buildPiCodexContext(
    basePrompt: string,
    options: BuildSystemPromptOptions | undefined,
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
        buildPiRuntimeContextSection(basePrompt, options),
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
): string {
    const dateLine = findLastLineStartingWith(basePrompt, "Current date:") ?? currentDateLine();
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

function currentDateLine(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `Current date: ${year}-${month}-${day}`;
}
