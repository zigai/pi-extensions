import {
    CONFIG_DIR_NAME,
    getAgentDir,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    loadPiExtensionSettings,
    type LoadedPiExtensionSettings,
} from "@zigai/pi-extension-settings/pi";

import { readFileSync } from "node:fs";

import { join } from "node:path";

import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import { Value } from "typebox/value";
import {
    DEFAULT_COMPLETION_SUFFIX,
    DEFAULT_MENTION_TRIGGER,
    LEGACY_SETTINGS_FILE,
    LegacyMentionProjectSettings,
    MentionProjectSettings,
    extensionSettingsInput,
    legacyBooleanSchema,
    legacyCompletionSuffixSchema,
    initialSuggestionsSchema,
    legacyMentionProjectSettingsSchema,
    legacyRootsSchema,
    legacyTriggerSchema,
} from "./settings-input.ts";
import prevalidatedSettings from "./settings.prevalidated.ts";

export * from "./settings-input.ts";

export const mentionProjectSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedSettings,
);

type LoadedMentionProjectSettings = Pick<
    LoadedPiExtensionSettings<typeof mentionProjectSettingsDefinition.schema>,
    "globalSettingsLayer" | "projectSettingsLayer"
>;

type SettingsLayer = LoadedMentionProjectSettings["globalSettingsLayer"];

function readLegacySettings(filePath: string): LegacyMentionProjectSettings {
    try {
        const parsedJson: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        if (!Value.Check(legacyMentionProjectSettingsSchema, parsedJson)) return {};
        return Value.Parse(legacyMentionProjectSettingsSchema, parsedJson);
    } catch {
        return {};
    }
}

function legacySettingsPaths(ctx: MentionProjectSettingsContext): string[] {
    const paths = [join(getAgentDir(), LEGACY_SETTINGS_FILE)];
    if (ctx.isProjectTrusted()) {
        paths.push(join(ctx.cwd, CONFIG_DIR_NAME, LEGACY_SETTINGS_FILE));
    }

    return paths;
}

function hasSetting(layer: SettingsLayer, key: string): boolean {
    return layer !== undefined && Object.prototype.hasOwnProperty.call(layer, key);
}

function isGeneratedDefaultLayer(layer: SettingsLayer): boolean {
    if (layer === undefined) return false;

    const generatedKeys = new Set([
        "trigger",
        "roots",
        "gitReposOnly",
        "includeDotFolders",
        "completionSuffix",
        "initialSuggestions",
    ]);

    if (Object.keys(layer).some((key) => !generatedKeys.has(key))) return false;

    if (
        layer.trigger !== DEFAULT_MENTION_TRIGGER ||
        !Array.isArray(layer.roots) ||
        layer.roots.length !== 0 ||
        layer.gitReposOnly !== true ||
        layer.includeDotFolders !== false ||
        layer.completionSuffix !== DEFAULT_COMPLETION_SUFFIX
    ) {
        return false;
    }

    if (!("initialSuggestions" in layer)) return true;

    const initialSuggestions = layer.initialSuggestions;
    if (!Value.Check(initialSuggestionsSchema, initialSuggestions)) return false;

    const parsed = Value.Parse(initialSuggestionsSchema, initialSuggestions);
    return parsed.strategy === "frecency" && parsed.pinned.length === 0;
}

type LoadedMentionProjectSettingsLayers = {
    readonly globalSettingsLayer: SettingsLayer;
    readonly projectSettingsLayer: SettingsLayer;
};

function hasExplicitExtensionSetting(
    loaded: LoadedMentionProjectSettingsLayers,
    key: string,
): boolean {
    if (hasSetting(loaded.projectSettingsLayer, key)) return true;
    if (isGeneratedDefaultLayer(loaded.globalSettingsLayer)) return false;
    return hasSetting(loaded.globalSettingsLayer, key);
}

function matchesLegacyTrigger(value: unknown): value is string {
    return Value.Check(legacyTriggerSchema, value);
}

function matchesLegacyCompletionSuffix(value: unknown): value is string {
    return Value.Check(legacyCompletionSuffixSchema, value);
}

function matchesLegacyBoolean(value: unknown): value is boolean {
    return Value.Check(legacyBooleanSchema, value);
}

function matchesLegacyRoots(value: unknown): value is string | string[] {
    return Value.Check(legacyRootsSchema, value);
}

function normalizeLegacyRoots(value: string | string[]): string[] | undefined {
    let candidates: string[];
    if (Array.isArray(value)) candidates = value;
    else candidates = [value];

    const roots: string[] = [];
    for (const root of candidates) {
        const trimmed = root.trim();
        if (trimmed.length > 0) roots.push(trimmed);
    }

    if (roots.length === 0 && candidates.length > 0) return undefined;
    return roots;
}

function loadLegacySettings(ctx: MentionProjectSettingsContext): LegacyMentionProjectSettings {
    const paths = legacySettingsPaths(ctx);
    const globalSettingsPath = paths.at(0);
    const projectSettingsPath = paths.at(1);

    let globalSettings: LegacyMentionProjectSettings = {};
    if (globalSettingsPath !== undefined) globalSettings = readLegacySettings(globalSettingsPath);

    let projectSettings: LegacyMentionProjectSettings = {};
    if (projectSettingsPath !== undefined) {
        projectSettings = readLegacySettings(projectSettingsPath);
    }

    return { ...globalSettings, ...projectSettings };
}

function applyLegacySettings(
    legacy: LegacyMentionProjectSettings,
    settings: MentionProjectSettings,
    loaded: LoadedMentionProjectSettingsLayers,
): void {
    if (!hasExplicitExtensionSetting(loaded, "trigger")) {
        const trigger = legacy.mentionProjectTrigger;
        if (matchesLegacyTrigger(trigger)) settings.trigger = trigger;
    }

    if (!hasExplicitExtensionSetting(loaded, "roots")) {
        const legacyRoots = legacy.mentionProjectRoots;
        if (matchesLegacyRoots(legacyRoots)) {
            const roots = normalizeLegacyRoots(legacyRoots);
            if (roots !== undefined) settings.roots = roots;
        }
    }

    if (!hasExplicitExtensionSetting(loaded, "gitReposOnly")) {
        const gitReposOnly = legacy.mentionProjectGitReposOnly;
        if (matchesLegacyBoolean(gitReposOnly)) settings.gitReposOnly = gitReposOnly;
    }

    if (!hasExplicitExtensionSetting(loaded, "includeDotFolders")) {
        const includeDotFolders = legacy.mentionProjectIncludeDotFolders;
        if (matchesLegacyBoolean(includeDotFolders)) {
            settings.includeDotFolders = includeDotFolders;
        }
    }

    if (!hasExplicitExtensionSetting(loaded, "completionSuffix")) {
        const completionSuffix = legacy.mentionProjectCompletionSuffix;
        if (matchesLegacyCompletionSuffix(completionSuffix)) {
            settings.completionSuffix = completionSuffix;
        }
    }
}

export default mentionProjectSettingsDefinition;

export type MentionProjectSettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

/** Load validated project-mention settings with safe diagnostics. */
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

    applyLegacySettings(loadLegacySettings(ctx), settings, loaded);

    return { settings, diagnostics: loaded.diagnostics };
}

/** Load validated global and trusted-project project-mention settings. */
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
