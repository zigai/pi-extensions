import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";

import settingsInput from "./settings-input.ts";
import artifact from "./settings.prevalidated.ts";

export const settingsDefinition = definePrevalidatedExtensionSettings(settingsInput, artifact);

export function loadLazyMcpSettings(ctx: PiSettingsContext) {
    return loadPiExtensionSettings(settingsDefinition, ctx, {
        bundledSchema: { kind: "url", url: new URL("../config.schema.json", import.meta.url) },
    });
}
