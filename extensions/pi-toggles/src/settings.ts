import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import type { StaticDecode } from "typebox";

import prevalidatedSettings from "./settings.prevalidated.ts";
import settingsInput, {
    capabilityKindSchema,
    capabilitySelectorSchema,
    conditionSchema,
    desiredStateSchema,
    policyDecisionSchema,
    profileSchema,
    promptFragmentSchema,
    ruleSchema,
    settingsDocumentSchema,
    settingsSchema,
} from "./settings-input.ts";

export {
    capabilitySelectorSchema,
    conditionSchema,
    policyDecisionSchema,
    promptFragmentSchema,
    ruleSchema,
    settingsDocumentSchema,
    settingsSchema,
} from "./settings-input.ts";

export type CapabilityKind = StaticDecode<typeof capabilityKindSchema>;
export type DesiredState = StaticDecode<typeof desiredStateSchema>;
export type Condition = StaticDecode<typeof conditionSchema>;
export type CapabilitySelector = StaticDecode<typeof capabilitySelectorSchema>;
export type PolicyDecision = StaticDecode<typeof policyDecisionSchema>;
export type Profile = StaticDecode<typeof profileSchema>;
export type PromptFragment = StaticDecode<typeof promptFragmentSchema>;
export type PolicyRule = StaticDecode<typeof ruleSchema>;
export type ExtensionSettings = StaticDecode<typeof settingsSchema>;
export type SettingsDocument = StaticDecode<typeof settingsDocumentSchema>;

export const extensionSettingsDefinition = definePrevalidatedExtensionSettings(
    settingsInput,
    prevalidatedSettings,
);

/** Load resolved global and trusted-project settings for this session. */
export function loadTogglesSettings(ctx: PiSettingsContext) {
    return loadPiExtensionSettings(extensionSettingsDefinition, ctx, {
        bundledSchema: {
            kind: "url",
            url: new URL("../config.schema.json", import.meta.url),
        },
    });
}

export default extensionSettingsDefinition;
