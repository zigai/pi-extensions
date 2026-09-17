import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import type { StaticDecode } from "typebox";

import artifact from "./settings.prevalidated.ts";
import settingsInput, { settingsSchema } from "./settings-input.ts";

export type CodexCoreSettings = StaticDecode<typeof settingsSchema>;

export const settingsDefinition = definePrevalidatedExtensionSettings(settingsInput, artifact);

export function loadCodexCoreSettings(ctx: PiSettingsContext) {
    return loadPiExtensionSettings(settingsDefinition, ctx, {
        bundledSchema: { kind: "url", url: new URL("../config.schema.json", import.meta.url) },
    });
}
