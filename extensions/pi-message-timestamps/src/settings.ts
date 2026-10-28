import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import type { StaticDecode } from "typebox";

import settingsInput, { settingsSchema } from "./settings-input.ts";
import artifact from "./settings.prevalidated.ts";

export type MessageTimestampsSettings = StaticDecode<typeof settingsSchema>;
export type TimestampFormat = MessageTimestampsSettings["format"];

export const messageTimestampsSettingsDefinition = definePrevalidatedExtensionSettings(
    settingsInput,
    artifact,
);

export function loadMessageTimestampsSettings(ctx: PiSettingsContext) {
    return loadPiExtensionSettings(messageTimestampsSettingsDefinition, ctx, {
        bundledSchema: { kind: "url", url: new URL("../config.schema.json", import.meta.url) },
    });
}
