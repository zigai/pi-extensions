import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPiExtensionSettings } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import { MentionProjectSettings, extensionSettingsInput } from "./settings-input.ts";
import prevalidatedSettings from "./settings.prevalidated.ts";

export * from "./settings-input.ts";

export const mentionProjectSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedSettings,
);

export default mentionProjectSettingsDefinition;

export type MentionProjectSettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

export function loadMentionProjectSettingsResult(ctx: MentionProjectSettingsContext) {
    const loaded = loadPiExtensionSettings(
        mentionProjectSettingsDefinition,
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
    let roots: string[];
    if (Array.isArray(loaded.settings.roots)) {
        roots = [...loaded.settings.roots];
    } else {
        roots = [loaded.settings.roots];
    }

    const settings: MentionProjectSettings = {
        trigger: loaded.settings.trigger,
        roots,
        gitReposOnly: loaded.settings.gitReposOnly,
        includeDotFolders: loaded.settings.includeDotFolders,
        completionSuffix: loaded.settings.completionSuffix,
        initialSuggestions: {
            strategy: loaded.settings.initialSuggestions.strategy,
            pinned: [...loaded.settings.initialSuggestions.pinned],
        },
    };

    return { settings, diagnostics: loaded.diagnostics };
}

export function loadMentionProjectSettings(
    ctx: MentionProjectSettingsContext,
): MentionProjectSettings {
    return loadMentionProjectSettingsResult(ctx).settings;
}

export function applyMentionProjectCliFlags(
    settings: MentionProjectSettings,
    flags: { includeNonGit: unknown; includeDotFolders: unknown },
): MentionProjectSettings {
    const loaded = { ...settings };
    if (flags.includeNonGit === true) loaded.gitReposOnly = false;
    if (flags.includeDotFolders === true) loaded.includeDotFolders = true;

    return loaded;
}
