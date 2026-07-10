export type CodexModelRequestProfile = {
    readonly useResponsesLite: boolean;
    readonly defaultReasoningEffort?: string | undefined;
    readonly effectiveContextWindow?: number | undefined;
    readonly supportsPriorityServiceTier: boolean;
    readonly supportsImageDetailOriginal: boolean;
};

const GPT_5_6_EFFECTIVE_CONTEXT_WINDOW = 353_400;

const CODEX_MODEL_REQUEST_PROFILES: Readonly<Record<string, CodexModelRequestProfile>> = {
    "gpt-5.6-sol": {
        useResponsesLite: true,
        defaultReasoningEffort: "low",
        effectiveContextWindow: GPT_5_6_EFFECTIVE_CONTEXT_WINDOW,
        supportsPriorityServiceTier: true,
        supportsImageDetailOriginal: true,
    },
    "gpt-5.6-terra": {
        useResponsesLite: true,
        defaultReasoningEffort: "medium",
        effectiveContextWindow: GPT_5_6_EFFECTIVE_CONTEXT_WINDOW,
        supportsPriorityServiceTier: true,
        supportsImageDetailOriginal: true,
    },
    "gpt-5.6-luna": {
        useResponsesLite: true,
        defaultReasoningEffort: "medium",
        effectiveContextWindow: GPT_5_6_EFFECTIVE_CONTEXT_WINDOW,
        supportsPriorityServiceTier: true,
        supportsImageDetailOriginal: true,
    },
    "gpt-5.5": {
        useResponsesLite: false,
        defaultReasoningEffort: "medium",
        supportsPriorityServiceTier: true,
        supportsImageDetailOriginal: true,
    },
    "gpt-5.4": {
        useResponsesLite: false,
        defaultReasoningEffort: "medium",
        supportsPriorityServiceTier: true,
        supportsImageDetailOriginal: true,
    },
    "gpt-5.4-mini": {
        useResponsesLite: false,
        defaultReasoningEffort: "medium",
        supportsPriorityServiceTier: false,
        supportsImageDetailOriginal: true,
    },
};

/** Current text models surfaced by the Codex settings UI, newest first. */
export const CODEX_TEXT_MODEL_CHOICES = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
] as const;

/** Returns the checked-in request contract for a known Codex model. */
export function codexModelRequestProfile(
    modelId: string | undefined,
): CodexModelRequestProfile | undefined {
    const normalizedModelId = modelId?.trim().toLowerCase();
    return normalizedModelId ? CODEX_MODEL_REQUEST_PROFILES[normalizedModelId] : undefined;
}

/** Maps Codex client-only reasoning modes to the value accepted by Responses. */
export function codexReasoningEffortForRequest(effort: string): string {
    return effort.trim().toLowerCase() === "ultra" ? "max" : effort.trim();
}

/** Applies authoritative Codex context metadata to Pi's mutable runtime model entry. */
export function applyCodexModelMetadataCompatibility(model: Model<Api> | undefined): void {
    if (
        model?.provider.trim().toLowerCase() !== "openai-codex" ||
        !String(model.api).toLowerCase().includes("responses")
    ) {
        return;
    }
    const effectiveContextWindow = codexModelRequestProfile(model.id)?.effectiveContextWindow;
    if (effectiveContextWindow !== undefined) model.contextWindow = effectiveContextWindow;
}
import type { Api, Model } from "@earendil-works/pi-ai";
