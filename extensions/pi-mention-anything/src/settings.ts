import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPiExtensionSettings } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";

import {
    type ConfiguredMention,
    type ConfiguredMentionInput,
    DEFAULT_COMPLETION_SUFFIX,
    type MentionAnythingSettings,
    extensionSettingsInput,
} from "./settings-input.ts";
import prevalidatedSettings from "./settings.prevalidated.ts";

export * from "./settings-input.ts";

export const mentionAnythingSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedSettings,
);

export default mentionAnythingSettingsDefinition;

export type MentionAnythingSettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

function copyMention(mention: ConfiguredMentionInput): ConfiguredMention {
    return structuredClone({
        ...mention,
        completionSuffix: mention.completionSuffix ?? DEFAULT_COMPLETION_SUFFIX,
        initialSuggestions: mention.initialSuggestions ?? { strategy: "frecency", pinned: [] },
    });
}

/** Load validated global and trusted-project mention settings. */
export function loadMentionAnythingSettings(
    ctx: MentionAnythingSettingsContext,
): MentionAnythingSettings {
    const loaded = loadPiExtensionSettings(
        mentionAnythingSettingsDefinition,
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

    return { mentions: loaded.settings.mentions.map(copyMention) };
}
