import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import input from "./settings-input.ts";
import artifact from "./settings.prevalidated.ts";

const definition = definePrevalidatedExtensionSettings(input, artifact);

export function loadPromptHistorySettings(ctx: PiSettingsContext) {
    return loadPiExtensionSettings(definition, ctx, {
        bundledSchema: { kind: "url", url: new URL("../config.schema.json", import.meta.url) },
    });
}
