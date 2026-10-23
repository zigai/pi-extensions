import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import type { StaticDecode } from "typebox";
import input, { settingsSchema } from "./settings-input.ts";
import artifact from "./settings.prevalidated.ts";

export type WorkspaceSettings = StaticDecode<typeof settingsSchema>;

const definition = definePrevalidatedExtensionSettings(input, artifact);

export function loadWorkspaceSettings(ctx: PiSettingsContext) {
    return loadPiExtensionSettings(definition, ctx, {
        bundledSchema: { kind: "url", url: new URL("../config.schema.json", import.meta.url) },
    });
}
