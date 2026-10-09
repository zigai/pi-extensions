import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import type { StaticDecode } from "typebox";

import prevalidatedSettings from "./settings.prevalidated.ts";
import settingsInput, { settingsSchema } from "./settings-input.ts";

export type ExtensionSettings = StaticDecode<typeof settingsSchema>;

export const extensionSettingsDefinition = definePrevalidatedExtensionSettings(
    settingsInput,
    prevalidatedSettings,
);

export function loadSettingsUiSettings(ctx: PiSettingsContext) {
    return loadPiExtensionSettings(extensionSettingsDefinition, ctx, {
        bundledSchema: {
            kind: "url",
            url: new URL("../config.schema.json", import.meta.url),
        },
    });
}

export default extensionSettingsDefinition;
