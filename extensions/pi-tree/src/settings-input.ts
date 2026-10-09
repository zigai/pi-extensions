import { Type, type Static } from "typebox";

import { DEFAULT_MODE } from "./timestamps.ts";

export const SETTINGS_KEY = "treeTimestampMode";
export const PREVIEW_SETTINGS_KEY = "treeSelectedPreview";
export const MAX_VISIBLE_LINES_SETTINGS_KEY = "treeMaxVisibleLines";
export const PREVIEW_FULL_HEIGHT_SETTINGS_KEY = "treePreviewFullHeight";
export const MIN_VISIBLE_LINES = 5;
export const SETTINGS_LOCK_TIMEOUT_MS = 5_000;
export const STALE_SETTINGS_LOCK_MS = 30_000;

export const TreeTimestampModeSchema = Type.Union([
    Type.Literal("off"),
    Type.Literal("relative"),
    Type.Literal("absolute"),
]);
export const TreePreviewEnabledSchema = Type.Boolean();
export const TreeMaxVisibleLinesSchema = Type.Number({ minimum: MIN_VISIBLE_LINES });
export const TreePreviewFullHeightSchema = Type.Boolean();
export const SettingsObjectSchema = Type.Object(
    {
        $schema: Type.Optional(Type.String()),
        [SETTINGS_KEY]: Type.Optional(TreeTimestampModeSchema),
        [PREVIEW_SETTINGS_KEY]: Type.Optional(TreePreviewEnabledSchema),
        [MAX_VISIBLE_LINES_SETTINGS_KEY]: Type.Optional(TreeMaxVisibleLinesSchema),
        [PREVIEW_FULL_HEIGHT_SETTINGS_KEY]: Type.Optional(TreePreviewFullHeightSchema),
    },
    { additionalProperties: false },
);

export type SettingsObject = Static<typeof SettingsObjectSchema>;

export const extensionSettingsInput = {
    id: "pi-tree",
    title: "Pi Tree",
    description: "Settings for session-tree timestamps and preview layout.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-tree/config.schema.json",
    schema: Type.Object(
        {
            [SETTINGS_KEY]: Type.Union(
                [Type.Literal("off"), Type.Literal("relative"), Type.Literal("absolute")],
                {
                    default: DEFAULT_MODE,
                    description: "Timestamp style shown in tree entries.",
                },
            ),
            [PREVIEW_SETTINGS_KEY]: Type.Boolean({
                default: false,
                description: "Show the selected tree entry preview.",
            }),
            [MAX_VISIBLE_LINES_SETTINGS_KEY]: Type.Optional(
                Type.Number({
                    minimum: MIN_VISIBLE_LINES,
                    description: "Maximum visible lines in the tree selector.",
                }),
            ),
            [PREVIEW_FULL_HEIGHT_SETTINGS_KEY]: Type.Boolean({
                default: true,
                description: "Allow the preview to use the selector's full available height.",
            }),
        },
        { additionalProperties: false },
    ),
};

export default extensionSettingsInput;
