export type CodexModelRequestProfile = {
    readonly useResponsesLite: boolean;
    readonly defaultReasoningEffort?: string | undefined;
    readonly compHash?: string | undefined;
    readonly supportsPriorityServiceTier: boolean;
    readonly supportsImageDetailOriginal: boolean;
    readonly supportedReasoningEfforts: readonly string[];
    readonly multiAgentReasoningEffort?: string | undefined;
};

/** Current text models surfaced by the Codex settings UI, newest first. */
export const CODEX_TEXT_MODEL_CHOICES = [
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
] as const;

type CodexTextModel = (typeof CODEX_TEXT_MODEL_CHOICES)[number];

const CODEX_MODEL_REQUEST_PROFILES = {
    "gpt-6-astra": {
        useResponsesLite: true,
        defaultReasoningEffort: "low",
        compHash: "3000",
        supportsPriorityServiceTier: true,
        supportsImageDetailOriginal: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        multiAgentReasoningEffort: "xhigh",
    },
    "gpt-5.6-sol": {
        useResponsesLite: true,
        defaultReasoningEffort: "low",
        compHash: "3000",
        supportsPriorityServiceTier: true,
        supportsImageDetailOriginal: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    "gpt-5.6-terra": {
        useResponsesLite: true,
        defaultReasoningEffort: "medium",
        compHash: "3000",
        supportsPriorityServiceTier: true,
        supportsImageDetailOriginal: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    "gpt-5.6-luna": {
        useResponsesLite: true,
        defaultReasoningEffort: "medium",
        compHash: "3000",
        supportsPriorityServiceTier: true,
        supportsImageDetailOriginal: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    "gpt-5.5": {
        useResponsesLite: false,
        defaultReasoningEffort: "medium",
        compHash: "2911",
        supportsPriorityServiceTier: true,
        supportsImageDetailOriginal: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    },
    "gpt-5.4": {
        useResponsesLite: false,
        defaultReasoningEffort: "medium",
        compHash: "2911",
        supportsPriorityServiceTier: true,
        supportsImageDetailOriginal: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    },
    "gpt-5.4-mini": {
        useResponsesLite: false,
        defaultReasoningEffort: "medium",
        compHash: "2911",
        supportsPriorityServiceTier: false,
        supportsImageDetailOriginal: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    },
} satisfies Readonly<Record<CodexTextModel, CodexModelRequestProfile>>;

/** Returns the checked-in request contract for a known Codex model. */
export function codexModelRequestProfile(
    modelId: string | undefined,
): CodexModelRequestProfile | undefined {
    const normalizedModelId = modelId?.trim().toLowerCase();
    const knownModel = CODEX_TEXT_MODEL_CHOICES.find((model) => model === normalizedModelId);
    return knownModel === undefined ? undefined : CODEX_MODEL_REQUEST_PROFILES[knownModel];
}

/** Maps Codex client-only reasoning modes to the value accepted by Responses. */
export function codexReasoningEffortForRequest(effort: string): string {
    return effort.trim().toLowerCase() === "ultra" ? "max" : effort.trim();
}
