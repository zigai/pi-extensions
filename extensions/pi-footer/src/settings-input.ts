import { Type } from "typebox";
import {
    FOOTER_CUSTOM_SLOT_ID_PATTERN,
    type FooterLayout,
    type FooterSlotId,
} from "./footer-model.ts";

export const FOOTER_LAYOUT = {
    left: ["path", "branch", "provider", "model", "thinking"],
    right: ["cost", "context"],
    hidden: [],
} as const;

export type FooterConfig = {
    readonly separator: string;
    readonly showGitAheadBehind: boolean;
    readonly layout: FooterLayout;
};

export type LoadedFooterConfig = {
    readonly config: FooterConfig;
    readonly errors: readonly string[];
};

export type FooterSettingsSource = {
    readonly label: string;
    readonly settings: unknown;
};

export type FooterSettings = {
    $schema?: string;
    separator?: string;
    showGitAheadBehind?: boolean;
    layout?: FooterLayoutSettings;
};

export type FooterLayoutSettings = {
    left?: readonly FooterSlotId[];
    right?: readonly FooterSlotId[];
    hidden?: readonly FooterSlotId[];
};

export type FooterLayoutSettingsParseResult = {
    readonly layout?: FooterLayoutSettings;
    readonly errors: readonly string[];
};

export type FooterSettingsParseResult = {
    readonly settings: FooterSettings;
    readonly errors: readonly string[];
};

export const builtinSlotIdSchema = Type.Union([
    Type.Literal("path"),
    Type.Literal("branch"),
    Type.Literal("provider"),
    Type.Literal("model"),
    Type.Literal("thinking"),
    Type.Literal("mcp"),
    Type.Literal("cost"),
    Type.Literal("context"),
]);

export const footerSlotIdSchema = Type.Union(
    [builtinSlotIdSchema, Type.String({ pattern: FOOTER_CUSTOM_SLOT_ID_PATTERN })],
    {
        "x-control": "combobox",
        examples: ["path", "branch", "provider", "model", "thinking", "mcp", "cost", "context"],
        description: "Built-in or extension-provided footer slot ID.",
    },
);

export const extensionSettingsInput = {
    id: "pi-footer",
    title: "Pi Footer",
    description: "Settings for footer content, ordering, and separators.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-footer/config.schema.json",
    schema: Type.Object(
        {
            separator: Type.String({
                default: "·",
                description: "Text placed between visible footer slots.",
            }),
            showGitAheadBehind: Type.Boolean({
                default: false,
                description:
                    "Show upstream commit counts (↑ahead ↓behind) beside the branch. Hidden when the branch has no upstream.",
            }),
            layout: Type.Object(
                {
                    left: Type.Array(footerSlotIdSchema, {
                        uniqueItems: true,
                        default: [...FOOTER_LAYOUT.left],
                        description: "Footer slot IDs shown on the left in display order.",
                    }),
                    right: Type.Array(footerSlotIdSchema, {
                        uniqueItems: true,
                        default: [...FOOTER_LAYOUT.right],
                        description: "Footer slot IDs shown on the right in display order.",
                    }),
                    hidden: Type.Array(footerSlotIdSchema, {
                        uniqueItems: true,
                        default: [],
                        description: "Footer slot IDs hidden from both sides.",
                    }),
                },
                { default: {}, additionalProperties: false },
            ),
        },
        { additionalProperties: false },
    ),
};

export default extensionSettingsInput;
