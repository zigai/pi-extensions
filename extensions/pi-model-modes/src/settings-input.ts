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
        thinkingLevel: Type.Optional(
            Type.Union([modeThinkingLevelSchema, Type.Null()], {
                description:
                    "Pi thinking level for this mode; null clears an inherited project value.",
            }),
        ),
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
            description:
                "Legacy startup model provider; ignored. The first cycle mode is used instead.",
        }),
        modelId: Type.String({
            minLength: 1,
            description: "Legacy startup model ID; ignored. The first cycle mode is used instead.",
        }),
        thinkingLevel: Type.Optional(defaultThinkingLevelSchema),
    },
    {
        additionalProperties: false,
        deprecated: true,
        description:
            "Deprecated and ignored. Fresh sessions use the first configured cycle mode. Removed on explicit mode saves.",
    },
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
            deletedModes: Type.Optional(
                Type.Array(Type.String(), {
                    description: "Global mode names hidden by this project configuration.",
                }),
            ),
            modes: Type.Record(Type.String(), modeSpecSchema, {
                default: {},
                description:
                    "Named model modes in cycle order. The first configured mode is used on fresh startup and /new; resumed sessions keep their selection.",
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
