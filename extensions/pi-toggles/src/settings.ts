import { defineExtensionSettings } from "@zigai/pi-extension-settings";
import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { Type, type Static } from "typebox";

const settingsSchema = Type.Object(
    {
        enabled: Type.Boolean({
            default: true,
            description: "Enable the extension.",
        }),
    },
    { additionalProperties: false },
);

export type ExtensionSettings = Static<typeof settingsSchema>;

export const extensionSettingsDefinition = defineExtensionSettings({
    id: "pi-toggles",
    title: "Pi Toggles",
    description: "Settings for Pi Toggles.",
    schemaId: "https://raw.githubusercontent.com/zigai/pi-toggles/HEAD/config.schema.json",
    schema: settingsSchema,
});

export function loadTogglesSettings(ctx: PiSettingsContext) {
    return loadPiExtensionSettings(extensionSettingsDefinition, ctx, {
        bundledSchema: {
            kind: "url",
            url: new URL("../config.schema.json", import.meta.url),
        },
    });
}

export default extensionSettingsDefinition;
