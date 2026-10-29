import { Type } from "typebox";
import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";

export const settingsSchema = Type.Object(
    {
        tableRenderer: Type.String({
            default: "codex",
            minLength: 1,
            description: "Selected table renderer: codex, native, or an extension-registered name.",
        }),
        nativeTableBorderStyle: Type.Union([Type.Literal("normal"), Type.Literal("dim")], {
            default: "dim",
            description: "Border style for native assistant tables: normal or dim.",
        }),
    },
    { additionalProperties: false },
);

export default {
    id: "pi-response-renderer",
    title: "Pi Response Renderer",
    description: "Assistant response presentation.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-response-renderer/config.schema.json",
    schema: settingsSchema,
} satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;
