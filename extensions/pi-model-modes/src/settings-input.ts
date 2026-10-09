import { Type } from "typebox";
import { ALL_THINKING_LEVELS } from "./thinking-levels.ts";

export const MODE_COLOR_EXAMPLES = [
    "accent",
    "border",
    "borderAccent",
    "borderMuted",
    "success",
    "error",
    "warning",
    "muted",
    "dim",
    "text",
    "thinkingText",
    "userMessageText",
    "customMessageText",
    "customMessageLabel",
    "toolTitle",
    "toolOutput",
    "mdHeading",
    "mdLink",
    "mdLinkUrl",
    "mdCode",
    "mdCodeBlock",
    "mdCodeBlockBorder",
    "mdQuote",
    "mdQuoteBorder",
    "mdHr",
    "mdListBullet",
    "toolDiffAdded",
    "toolDiffRemoved",
    "toolDiffContext",
    "syntaxComment",
    "syntaxKeyword",
    "syntaxFunction",
    "syntaxVariable",
    "syntaxString",
    "syntaxNumber",
    "syntaxType",
    "syntaxOperator",
    "syntaxPunctuation",
    "thinkingOff",
    "thinkingMinimal",
    "thinkingLow",
    "thinkingMedium",
    "thinkingHigh",
    "thinkingXhigh",
    "thinkingMax",
    "bashMode",
] as const;

export const USE_THINKING_BORDER_COLORS_SETTINGS_KEY = "modeUseThinkingBorderColors";
export const SHOW_THINKING_LEVEL_STATUS_SETTINGS_KEY = "modeShowThinkingLevelStatus";

export const modeThinkingLevelSchema = Type.Enum(ALL_THINKING_LEVELS, {
    "x-control": "select",
    description: "Pi thinking level for this mode, clamped to the selected model's capabilities.",
});

export const defaultThinkingLevelSchema = Type.Enum(ALL_THINKING_LEVELS, {
    "x-control": "select",
    description: "Pi thinking level for the default model, clamped to that model's capabilities.",
});

export const modeSpecSchema = Type.Object(
    {
        provider: Type.Optional(Type.String()),
        modelId: Type.Optional(Type.String()),
        thinkingLevel: Type.Optional(modeThinkingLevelSchema),
        color: Type.Optional(
            Type.String({
                "x-control": "combobox",
                examples: MODE_COLOR_EXAMPLES,
                description: "Pi theme foreground color used for this mode.",
            }),
        ),
    },
    { additionalProperties: false, title: "ModelMode" },
);

export const defaultModelSchema = Type.Object(
    {
        provider: Type.String({
            minLength: 1,
            description: "Default model provider.",
        }),
        modelId: Type.String({ minLength: 1, description: "Default model ID." }),
        thinkingLevel: Type.Optional(defaultThinkingLevelSchema),
    },
    { additionalProperties: false },
);

export const modeShortcutsSchema = Type.Object(
    {
        forward: Type.Optional(
            Type.String({ minLength: 1, description: "Shortcut for cycling modes forward." }),
        ),
        backward: Type.Optional(
            Type.String({ minLength: 1, description: "Shortcut for cycling modes backward." }),
        ),
    },
    { additionalProperties: false },
);

export const extensionSettingsInput = {
    id: "pi-model-modes",
    title: "Pi Model Modes",
    description: "Settings and mode definitions for switching model configurations.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-model-modes/config.schema.json",
    schema: Type.Object(
        {
            version: Type.Number({ default: 1, description: "Settings format version." }),
            currentMode: Type.String({
                default: "default",
                description: "Currently selected mode ID.",
            }),
            defaultModel: Type.Optional(defaultModelSchema),
            [USE_THINKING_BORDER_COLORS_SETTINGS_KEY]: Type.Boolean({
                default: false,
                description: "Use thinking-level colors instead of mode colors for borders.",
            }),
            [SHOW_THINKING_LEVEL_STATUS_SETTINGS_KEY]: Type.Boolean({
                default: false,
                description: "Show thinking level alongside mode status.",
            }),
            shortcuts: Type.Optional(modeShortcutsSchema),
            modes: Type.Record(Type.String(), modeSpecSchema, {
                default: {},
                description: "Named model-mode specifications keyed by mode ID.",
            }),
        },
        { additionalProperties: false },
    ),
    exampleSettings: {
        currentMode: "deep",
        modes: {
            fast: {
                provider: "openai-codex",
                modelId: "gpt-5.4-mini",
                thinkingLevel: "low",
                color: "thinkingLow",
            },
            deep: {
                provider: "openai-codex",
                modelId: "gpt-5.6-sol",
                thinkingLevel: "high",
                color: "thinkingHigh",
            },
        },
    },
} as const;

export default extensionSettingsInput;
