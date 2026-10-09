import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function defineThemeColors<const Colors extends readonly ThemeColor[]>(
    colors: Colors & ([ThemeColor] extends [Colors[number]] ? unknown : never),
): Colors {
    return colors;
}

export const THEME_FOREGROUND_COLORS = defineThemeColors([
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
    "scrollbarTrack",
    "scrollbarThumb",
    "searchMatchText",
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
] as const);

export type ThemeForegroundColor = (typeof THEME_FOREGROUND_COLORS)[number];

export const DEFAULT_URL_COLOR_SETTING = "#87d7ff";

export const themeForegroundColorSchema = Type.Union(
    THEME_FOREGROUND_COLORS.map((color) => Type.Literal(color)),
    {
        title: "Theme color",
        "x-control": "select",
        description: "Pi theme foreground color name.",
    },
);

export const ansiColorSettingSchema = Type.Integer({
    title: "ANSI 256 color",
    minimum: 0,
    maximum: 255,
    "x-control": "slider",
    description: "ANSI 256 color index.",
});

export const urlColorSettingSchema = Type.Union([
    ansiColorSettingSchema,
    Type.Literal("", { title: "Disabled", description: "Disable URL highlighting." }),
    Type.String({
        title: "Hex color",
        pattern: "^#[0-9a-fA-F]{6}$",
        "x-control": "color",
        description: "Six-digit hexadecimal color.",
    }),
    themeForegroundColorSchema,
]);

export const extensionSettingsInput = {
    id: "pi-message-highlights",
    title: "Pi Message Highlights",
    description: "Settings for highlighting URLs in message output.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-message-highlights/config.schema.json",
    schema: Type.Object(
        {
            urlColor: Type.Union(urlColorSettingSchema.anyOf, {
                default: DEFAULT_URL_COLOR_SETTING,
                description:
                    "URL color as an ANSI-256 index, hex color, theme color name, or empty string to disable highlighting.",
            }),
        },
        { additionalProperties: false },
    ),
};

export default extensionSettingsInput;
