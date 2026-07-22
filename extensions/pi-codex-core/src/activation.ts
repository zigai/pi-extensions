import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatCodexModelSelection, type CodexCoreConfig } from "./config/config.ts";
import { supportsCodexPromptPersonality } from "./prompt/personality.ts";
import { APPLY_PATCH_TOOL_NAME } from "./tools/apply-patch/tool.ts";
import { IMAGEGEN_TOOL_NAME } from "./tools/imagegen.ts";
import { VIEW_IMAGE_TOOL_NAME } from "./tools/view-image/tool.ts";
import { WEB_RUN_TOOL_NAME } from "./tools/web-run/tool.ts";
import { modelSupportsImages } from "./images/codex-prompt.ts";
import type { ToolActivationDecision } from "./toggles-activation.ts";

export const CODEX_CORE_TOOL_NAMES = [
    WEB_RUN_TOOL_NAME,
    IMAGEGEN_TOOL_NAME,
    VIEW_IMAGE_TOOL_NAME,
    APPLY_PATCH_TOOL_NAME,
] as const;

export type CodexCoreToolName = (typeof CODEX_CORE_TOOL_NAMES)[number];

const editSuppressedByApplyPatchByApi = new WeakMap<ExtensionAPI, boolean>();

export function syncCodexCoreTools(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    options?: { readonly activation: "standalone" | "delegated" },
): void {
    const enabledTools = enabledCodexToolNames(ctx, config);
    const applyPatchEnabled = enabledTools.includes(APPLY_PATCH_TOOL_NAME);
    let activeTools = pi.getActiveTools().filter((toolName) => !isCodexCoreToolName(toolName));
    const editSuppressedByApplyPatch = editSuppressedByApplyPatchByApi.get(pi) ?? false;

    if ((options?.activation ?? "standalone") === "standalone") {
        if (applyPatchEnabled) {
            editSuppressedByApplyPatchByApi.set(
                pi,
                editSuppressedByApplyPatch || activeTools.includes("edit"),
            );
            activeTools = activeTools.filter((toolName) => toolName !== "edit");
        } else if (editSuppressedByApplyPatch && !activeTools.includes("edit")) {
            activeTools = [...activeTools, "edit"];
            editSuppressedByApplyPatchByApi.set(pi, false);
        } else if (!applyPatchEnabled) {
            editSuppressedByApplyPatchByApi.set(pi, false);
        }

        pi.setActiveTools([...activeTools, ...enabledTools]);
    }
    setCodexStatus(ctx, config);
}

/** Activation defaults proposed to Pi Toggles when it owns tool policy. */
export function codexCoreActivationDecisions(
    ctx: ExtensionContext,
    config: CodexCoreConfig,
): readonly ToolActivationDecision[] {
    const enabled = new Set(enabledCodexToolNames(ctx, config));
    return [
        ...CODEX_CORE_TOOL_NAMES.map((name) => ({
            target: { kind: "tool" as const, name },
            state: enabled.has(name) ? ("on" as const) : ("off" as const),
        })),
        {
            target: { kind: "tool", name: "edit" },
            state: enabled.has(APPLY_PATCH_TOOL_NAME) ? "off" : "on",
        },
    ];
}

export function enabledCodexToolNames(
    ctx: ExtensionContext,
    config: CodexCoreConfig,
): CodexCoreToolName[] {
    const toolNames: CodexCoreToolName[] = [];
    if (shouldExposeCodexTools(ctx, config)) {
        if (config.tools.webSearch) toolNames.push(WEB_RUN_TOOL_NAME);
        if (config.tools.imageGeneration) toolNames.push(IMAGEGEN_TOOL_NAME);
        if (
            config.tools.viewImage &&
            (modelSupportsImages(ctx.model) || config.tools.viewImageDescriptions)
        )
            toolNames.push(VIEW_IMAGE_TOOL_NAME);
    }
    if (shouldExposeApplyPatch(ctx, config)) toolNames.push(APPLY_PATCH_TOOL_NAME);
    return toolNames;
}

export function shouldExposeCodexTools(ctx: ExtensionContext, config: CodexCoreConfig): boolean {
    return config.scope.tools === "all" || isCodexLikeModel(ctx.model);
}

export function shouldExposeApplyPatch(ctx: ExtensionContext, config: CodexCoreConfig): boolean {
    if (config.tools.applyPatch === "off") return false;
    if (config.tools.applyPatch === "all") return true;
    return isCodexLikeModel(ctx.model);
}

export function isCodexLikeModel(model: ExtensionContext["model"]): boolean {
    if (!model) return false;
    const provider = model.provider.toLowerCase();
    const api = typeof model.api === "string" ? model.api.toLowerCase() : "";
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
        config.prompt.mode === "codex" && supportsCodexPromptPersonality(ctx.model?.id)
            ? config.prompt.personality
            : undefined,
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
    return isOneOf(CODEX_CORE_TOOL_NAMES, toolName);
}

function isOneOf<const TValue extends string>(
    allowed: readonly TValue[],
    value: string,
): value is TValue {
    return allowed.some((candidate) => candidate === value);
}
