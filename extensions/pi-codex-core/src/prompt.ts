import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { formatCodexModelSelection, type CodexCoreConfig } from "./config.ts";
import { IMAGEGEN_TOOL_NAME } from "./tools/imagegen.ts";
import { VIEW_IMAGE_TOOL_NAME } from "./tools/view-image.ts";
import { WEB_RUN_TOOL_NAME } from "./tools/web-run.ts";

const CODEX_BASE_PROMPT_PATH = fileURLToPath(
    new URL("./prompt/codex-base-prompt.md", import.meta.url),
);
let cachedCodexBasePrompt: string | undefined;

export function buildCodexCoreSystemPrompt(basePrompt: string, config: CodexCoreConfig): string {
    const notes = buildPiRuntimeNotes(config);
    if (config.prompt.mode === "codex") {
        return [
            readCodexBasePrompt(),
            notes,
            "# Pi Context",
            "The following Pi-provided context, project instructions, tools, and skills also apply.",
            basePrompt,
        ].join("\n\n");
    }
    return insertBeforeTrailingContext(basePrompt, notes);
}

function readCodexBasePrompt(): string {
    cachedCodexBasePrompt ??= readFileSync(CODEX_BASE_PROMPT_PATH, "utf8").trim();
    return cachedCodexBasePrompt;
}

function buildPiRuntimeNotes(config: CodexCoreConfig): string {
    const lines = [
        "# Pi Codex Core",
        "Pi is providing a native tool surface with selected Codex-compatible tools.",
        "Use Pi's built-in file and shell tools normally; use the Codex tools only for capabilities Pi does not already provide.",
    ];

    const activeTools: string[] = [];
    if (config.tools.webSearch)
        activeTools.push(
            `${WEB_RUN_TOOL_NAME}: Codex-backed web search/open/click/find/current-info access.`,
        );
    if (config.tools.imageGeneration)
        activeTools.push(`${IMAGEGEN_TOOL_NAME}: Codex-backed image generation and image edits.`);
    if (config.tools.viewImage)
        activeTools.push(`${VIEW_IMAGE_TOOL_NAME}: local image inspection by path.`);
    if (activeTools.length > 0) {
        lines.push("Available Codex-compatible tools:");
        for (const tool of activeTools) lines.push(`- ${tool}`);
    }

    lines.push(
        `Codex tool scope: ${config.scope.tools === "all" ? "available on all models via OpenAI Codex sidecar auth" : "available on Codex-like models only"}.`,
    );
    if (config.compaction.enabled) {
        lines.push(
            `Codex native compaction is enabled with ${formatCodexModelSelection(config.openai.compactionModel)}.`,
        );
    }
    return lines.join("\n");
}

function insertBeforeTrailingContext(prompt: string, section: string): string {
    const currentDateIndex = prompt.lastIndexOf("\nCurrent date:");
    if (currentDateIndex !== -1)
        return `${prompt.slice(0, currentDateIndex)}\n\n${section}${prompt.slice(currentDateIndex)}`;
    return `${prompt}\n\n${section}`;
}
