import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadPiExtensionSettings } from "@zigai/pi-extension-settings/pi";

import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import { MentionSkillSettings, extensionSettingsInput } from "./settings-input.ts";
import prevalidatedSettings from "./settings.prevalidated.ts";

export * from "./settings-input.ts";

export const mentionSkillSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedSettings,
);

export default mentionSkillSettingsDefinition;

export type MentionSkillSettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

export function loadMentionSkillSettingsResult(ctx: MentionSkillSettingsContext) {
    const loaded = loadPiExtensionSettings(
        mentionSkillSettingsDefinition,
        {
            cwd: ctx.cwd,
            isProjectTrusted: () => ctx.isProjectTrusted(),
        },
        {
            bundledSchema: {
                kind: "url",
                url: new URL("../config.schema.json", import.meta.url),
            },
        },
    );

    return {
        settings: {
            trigger: loaded.settings.trigger,
            hideSlashSkills: loaded.settings.hideSlashSkills,
            completionSuffix: loaded.settings.completionSuffix,
            initialSuggestions: {
                strategy: loaded.settings.initialSuggestions.strategy,
                pinned: [...loaded.settings.initialSuggestions.pinned],
                projectSkillsFirst: loaded.settings.initialSuggestions.projectSkillsFirst,
            },
        },
        diagnostics: loaded.diagnostics,
    };
}

export function loadMentionSkillSettings(ctx: MentionSkillSettingsContext): MentionSkillSettings {
    return loadMentionSkillSettingsResult(ctx).settings;
}
