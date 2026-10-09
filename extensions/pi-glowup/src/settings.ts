import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";

import prevalidatedExtensionSettingsArtifact from "./settings.prevalidated.ts";
import { extensionSettingsInput } from "./settings-input.ts";

export {
    extensionSettingsInput,
    settingsSchema,
    type ExtensionSettings,
} from "./settings-input.ts";

export const extensionSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedExtensionSettingsArtifact,
);

/** Load resolved settings from Pi's global file and trusted project override. */
export function loadGlowupSettings(context: PiSettingsContext) {
    return loadPiExtensionSettings(extensionSettingsDefinition, context, {
        bundledSchema: {
            kind: "url",
            url: new URL("../config.schema.json", import.meta.url),
        },
    });
}

export default extensionSettingsDefinition;
