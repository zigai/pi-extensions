import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";
import { Type } from "typebox";

export const CodexToolScopeSchema = Type.Union([Type.Literal("codex"), Type.Literal("all")], {
    default: "codex",
    description: "Expose Codex tools only for Codex models (`codex`) or for all models (`all`).",
});

export const CodexApplyPatchModeSchema = Type.Union(
    [Type.Literal("off"), Type.Literal("openai"), Type.Literal("all")],
    {
        default: "off",
        description: "Replace standard `edit` with `apply_patch`: `off`, `openai`, or `all`.",
    },
);

export const CodexWebSearchModeSchema = Type.Union(
    [Type.Literal("cached"), Type.Literal("indexed"), Type.Literal("live")],
    {
        default: "live",
        description: "Set search mode: `cached`, `indexed`, or `live`.",
    },
);

export const CodexPromptModeSchema = Type.Union([Type.Literal("pi"), Type.Literal("codex")], {
    default: "codex",
    description: "Enable model-aware Codex prompts (`codex`) or standard Pi prompts (`pi`).",
});

export const CodexPersonalitySchema = Type.Union(
    [Type.Literal("friendly"), Type.Literal("pragmatic"), Type.Literal("none")],
    {
        default: "pragmatic",
        description: "Set Codex communication style: `friendly`, `pragmatic`, or `none`.",
    },
);

export const CodexVerbositySchema = Type.Union(
    [Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
    {
        default: "low",
        description: "Verbosity level for Codex API requests: `low`, `medium`, or `high`.",
    },
);

export const CodexCompactionReasoningSchema = Type.String({
    minLength: 1,
    pattern: "\\S",
    default: "medium",
    description:
        "Reasoning effort for compaction requests: `medium`, `current`, `max`, or `ultra`.",
});

export const scopeSchema = Type.Object(
    {
        tools: CodexToolScopeSchema,
    },
    { additionalProperties: false, default: { tools: "codex" } },
);

export const toolsSchema = Type.Object(
    {
        webSearch: Type.Boolean({
            default: true,
            description: "Enable the `web_run` web search tool.",
        }),
        webSearchMode: CodexWebSearchModeSchema,
        imageGeneration: Type.Boolean({
            default: true,
            description: "Enable the `imagegen` image generation and editing tool.",
        }),
        viewImage: Type.Boolean({
            default: true,
            description: "Enable the `view_image` local image viewing tool.",
        }),
        viewImageDescriptions: Type.Boolean({
            default: false,
            description: "Include Codex-generated descriptions when viewing images.",
        }),
        applyPatch: CodexApplyPatchModeSchema,
    },
    {
        additionalProperties: false,
        default: {
            webSearch: true,
            webSearchMode: "live",
            imageGeneration: true,
            viewImage: true,
            viewImageDescriptions: false,
            applyPatch: "off",
        },
    },
);

export const promptSchema = Type.Object(
    {
        mode: CodexPromptModeSchema,
        personality: CodexPersonalitySchema,
    },
    { additionalProperties: false, default: { mode: "codex", personality: "pragmatic" } },
);

export const compactionSchema = Type.Object(
    {
        enabled: Type.Boolean({
            default: true,
            description: "Enable Codex-style conversation compaction.",
        }),
        auto: Type.Boolean({
            default: true,
            description: "Automatically trigger compaction when reaching the context threshold.",
        }),
        thresholdPercent: Type.Integer({
            minimum: 1,
            maximum: 99,
            default: 80,
            description: "Context percentage threshold that triggers auto-compaction.",
        }),
    },
    {
        additionalProperties: false,
        default: {
            enabled: true,
            auto: true,
            thresholdPercent: 80,
        },
    },
);

export const recoverySchema = Type.Object(
    {
        enabled: Type.Boolean({
            default: true,
            description: "Resume transiently failed Codex turns after Pi exhausts retries.",
        }),
        batchFollowUps: Type.Boolean({
            default: false,
            description:
                "Deliver user follow-up messages sent during a turn together when it completes.",
        }),
        maxAttempts: Type.Integer({
            minimum: 0,
            maximum: 10,
            default: 3,
            description: "Maximum delayed resume attempts for a failed turn.",
        }),
        baseDelayMs: Type.Integer({
            minimum: 1000,
            maximum: 300000,
            default: 30000,
            description: "Initial recovery delay in milliseconds.",
        }),
        maxDelayMs: Type.Integer({
            minimum: 1000,
            maximum: 900000,
            default: 120000,
            description: "Maximum recovery delay in milliseconds.",
        }),
    },
    {
        additionalProperties: false,
        default: {
            enabled: true,
            batchFollowUps: false,
            maxAttempts: 3,
            baseDelayMs: 30000,
            maxDelayMs: 120000,
        },
    },
);

export const openaiSchema = Type.Object(
    {
        webSearchModel: Type.String({
            default: "current",
            description: "Model for `web_run`; `current` uses the active model.",
        }),
        imageModel: Type.String({
            default: "gpt-image-2",
            description: "Model for `imagegen`.",
        }),
        imageDescriptionModel: Type.String({
            default: "current",
            description: "Model for image descriptions; `current` uses the active model.",
        }),
        compactionModel: Type.String({
            default: "current",
            description: "Model for compaction; `current` uses the active model.",
        }),
        compactionReasoning: CodexCompactionReasoningSchema,
        verbosity: CodexVerbositySchema,
        fast: Type.Boolean({
            default: false,
            description: "Prioritize speed for supported OpenAI models.",
        }),
        showReasoningTraces: Type.Boolean({
            default: true,
            description: "Stream reasoning trace summaries for GPT Responses models.",
        }),
    },
    {
        additionalProperties: false,
        default: {
            webSearchModel: "current",
            imageModel: "gpt-image-2",
            imageDescriptionModel: "current",
            compactionModel: "current",
            compactionReasoning: "medium",
            verbosity: "low",
            fast: false,
            showReasoningTraces: true,
        },
    },
);

export const settingsSchema = Type.Object(
    {
        scope: scopeSchema,
        tools: toolsSchema,
        prompt: promptSchema,
        compaction: compactionSchema,
        recovery: recoverySchema,
        openai: openaiSchema,
    },
    { additionalProperties: false },
);

const settingsInput = {
    id: "pi-codex-core",
    title: "Pi Codex Core",
    description: "Everything GPT models need to feel at home in Pi.",
    schemaId: "https://github.com/zigai/pi-codex-core/config.schema.json",
    schema: settingsSchema,
} as const satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;

export default settingsInput;
