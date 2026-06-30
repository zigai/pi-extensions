import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatCodexModelSelection, type CodexCoreConfig } from "./config.ts";
import { IMAGEGEN_TOOL_NAME } from "./tools/imagegen.ts";
import { VIEW_IMAGE_TOOL_NAME } from "./tools/view-image.ts";
import { WEB_RUN_TOOL_NAME } from "./tools/web-run.ts";
import { modelSupportsImages } from "./image-content.ts";

export const CODEX_CORE_TOOL_NAMES = [
    WEB_RUN_TOOL_NAME,
    IMAGEGEN_TOOL_NAME,
    VIEW_IMAGE_TOOL_NAME,
] as const;

export type CodexCoreToolName = (typeof CODEX_CORE_TOOL_NAMES)[number];

export function syncCodexCoreTools(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    config: CodexCoreConfig,
): void {
    const activeTools = pi.getActiveTools().filter((toolName) => !isCodexCoreToolName(toolName));
    pi.setActiveTools([...activeTools, ...enabledCodexToolNames(ctx, config)]);
    setCodexStatus(ctx, config);
}

export function enabledCodexToolNames(
    ctx: ExtensionContext,
    config: CodexCoreConfig,
): CodexCoreToolName[] {
    if (!shouldExposeCodexTools(ctx, config)) return [];
    const toolNames: CodexCoreToolName[] = [];
    if (config.tools.webSearch) toolNames.push(WEB_RUN_TOOL_NAME);
    if (config.tools.imageGeneration) toolNames.push(IMAGEGEN_TOOL_NAME);
    if (
        config.tools.viewImage &&
        (modelSupportsImages(ctx.model) || config.tools.viewImageDescriptions)
    )
        toolNames.push(VIEW_IMAGE_TOOL_NAME);
    return toolNames;
}

export function shouldExposeCodexTools(ctx: ExtensionContext, config: CodexCoreConfig): boolean {
    return config.scope.tools === "all" || isCodexLikeModel(ctx.model);
}

export function isCodexLikeModel(model: ExtensionContext["model"]): boolean {
    if (!model) return false;
    const provider = model.provider.toLowerCase();
    const api = String(model.api).toLowerCase();
    const id = model.id.toLowerCase();
    if (provider.includes("codex")) return true;
    if (api.includes("codex")) return true;
    if (id.includes("codex")) return true;
    return provider.includes("openai") && id.includes("gpt");
}

function setCodexStatus(ctx: ExtensionContext, config: CodexCoreConfig): void {
    if (!ctx.hasUI) return;
    const tools = enabledCodexToolNames(ctx, config);
    if (tools.length === 0 && !config.compaction.enabled && config.prompt.mode === "pi") {
        ctx.ui.setStatus("pi-codex-core", undefined);
        return;
    }
    const suffixes = [
        tools.length > 0 ? tools.join(", ") : undefined,
        config.scope.tools === "all" ? "all models" : undefined,
        config.prompt.mode === "codex" ? "codex prompt" : undefined,
        config.compaction.enabled
            ? `compact ${formatCodexModelSelection(config.openai.compactionModel)}`
            : undefined,
        config.openai.fast ? "fast" : undefined,
    ].filter((item): item is string => Boolean(item));
    ctx.ui.setStatus(
        "pi-codex-core",
        `${ctx.ui.theme.fg("accent", "Codex core")}${suffixes.length > 0 ? ctx.ui.theme.fg("dim", ` • ${suffixes.join(" • ")}`) : ""}`,
    );
}

function isCodexCoreToolName(toolName: string): toolName is CodexCoreToolName {
    return (CODEX_CORE_TOOL_NAMES as readonly string[]).includes(toolName);
}
