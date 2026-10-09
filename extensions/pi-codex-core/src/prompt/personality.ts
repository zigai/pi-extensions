const PERSONALITY_PROMPT_MODELS = new Set(["gpt-5.5"]);

/** Whether the bundled prompt for this model exposes Codex personality variants. */
export function supportsCodexPromptPersonality(modelId: string | undefined): boolean {
    const normalizedModelId = modelId?.trim().toLowerCase();
    return normalizedModelId !== undefined && PERSONALITY_PROMPT_MODELS.has(normalizedModelId);
}
