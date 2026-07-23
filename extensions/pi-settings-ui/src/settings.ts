import { defineExtensionSettings } from "@zigai/pi-extension-settings";
import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { Type, type Static } from "typebox";

const settingsSchema = Type.Object(
    {
        projectOverrides: Type.Boolean({
            default: true,
            description: "Let trusted projects have their own extension settings.",
        }),
    },
    { additionalProperties: false },
);

export type ExtensionSettings = Static<typeof settingsSchema>;

export const extensionSettingsDefinition = defineExtensionSettings({
    id: "pi-settings-ui",
    title: "Pi Settings UI",
    description: "Settings for Pi Settings UI.",
    schemaId: "https://raw.githubusercontent.com/zigai/pi-settings-ui/HEAD/config.schema.json",
    schema: settingsSchema,
});

export function loadSettingsUiSettings(ctx: PiSettingsContext) {
    return loadPiExtensionSettings(extensionSettingsDefinition, ctx, {
        bundledSchema: {
            kind: "url",
            url: new URL("../config.schema.json", import.meta.url),
        },
    });
}

export default extensionSettingsDefinition;
