import { Type } from "typebox";
import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";

export const settingsSchema = Type.Object(
    {
        enabled: Type.Boolean({
            default: false,
            description: "Enable the replaceable workspace surface.",
        }),
        transcript: Type.String({
            default: "native",
            minLength: 1,
            description: "Transcript backend: native, ledger, or a registered name.",
        }),
        editor: Type.String({
            default: "native",
            minLength: 1,
            description: "Editor backend: native or a registered name.",
        }),
        layout: Type.String({
            default: "native",
            minLength: 1,
            description: "Layout backend: native, sidebar, or a registered name.",
        }),
        sidebarSide: Type.Union(
            [Type.Literal("off"), Type.Literal("left"), Type.Literal("right")],
            { default: "off", description: "Optional persistent sidebar position." },
        ),
        sidebarWidth: Type.Integer({
            minimum: 1,
            default: 24,
            description: "Sidebar width in terminal columns.",
        }),
        minimumMainWidth: Type.Integer({
            minimum: 1,
            default: 48,
            description: "Main-area width below which the sidebar is hidden.",
        }),
        timestamps: Type.Boolean({
            default: false,
            description: "Show available message and tool timestamps in ledger metadata.",
        }),
        durations: Type.Boolean({
            default: false,
            description:
                "Show observed tool duration when both execution boundaries were available.",
        }),
        timeouts: Type.Boolean({
            default: false,
            description: "Show available tool timeout arguments in ledger metadata.",
        }),
    },
    { additionalProperties: false },
);

export default {
    id: "pi-workspace",
    title: "Pi Workspace",
    description: "Replaceable transcript, editor and workspace layout.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-workspace/config.schema.json",
    schema: settingsSchema,
} satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;
