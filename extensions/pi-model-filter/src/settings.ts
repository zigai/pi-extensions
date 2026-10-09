import {
    getPiGlobalSettingsPath,
    getPiProjectSettingsPath,
    loadPiExtensionSettings,
} from "@zigai/pi-extension-settings/pi";

import { existsSync, statSync } from "node:fs";

import type { Static } from "typebox";

import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import { normalizeRules, type FilterRuleConfig, type ModelFilterSettings } from "./model-filter.ts";
import {
    EXTENSION_ID,
    LoadedModelFilterSettings,
    ModelFilterSettingsLoadState,
    extensionSettingsInput,
    filterRuleSchema,
} from "./settings-input.ts";
import prevalidatedSettings from "./settings.prevalidated.ts";

export * from "./settings-input.ts";

export const modelFilterSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedSettings,
);

export default modelFilterSettingsDefinition;

type ParsedFilterRuleConfig = Static<typeof filterRuleSchema>;

type ParsedFilterConfig = {
    readonly include?: readonly ParsedFilterRuleConfig[];
    readonly exclude?: readonly ParsedFilterRuleConfig[];
};

function normalizeRule(rule: ParsedFilterRuleConfig): FilterRuleConfig {
    return {
        provider: rule.provider.trim(),
        models: rule.models.map((model) => model.trim()),
    };
}

export function decodeModelFilterSettings(config: ParsedFilterConfig): ModelFilterSettings {
    return {
        includeRules: normalizeRules((config.include ?? []).map(normalizeRule)),
        excludeRules: normalizeRules((config.exclude ?? []).map(normalizeRule)),
    };
}

export function getGlobalConfigPath(): string {
    return getPiGlobalSettingsPath(EXTENSION_ID);
}

export function getProjectConfigPath(cwd: string): string {
    return getPiProjectSettingsPath(EXTENSION_ID, cwd);
}

function settingsMtime(path: string): number {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return -1;
    }
}

function settingsSignature(globalPath: string, projectPath?: string): string {
    let projectMtime = "untrusted";
    if (projectPath !== undefined) projectMtime = String(settingsMtime(projectPath));

    return `${settingsMtime(globalPath)}:${projectMtime}`;
}

export function loadModelFilterSettings(
    state: ModelFilterSettingsLoadState,
): LoadedModelFilterSettings {
    const cwd = state.configCwd ?? process.cwd();
    const globalConfigPath = getGlobalConfigPath();
    const projectConfigPath = getProjectConfigPath(cwd);
    const useProjectConfig = state.projectTrusted === true && existsSync(projectConfigPath);
    let configPath = globalConfigPath;
    let watchedProjectPath: string | undefined;
    if (useProjectConfig) {
        configPath = projectConfigPath;
        watchedProjectPath = projectConfigPath;
    }

    const cacheSignature = settingsSignature(globalConfigPath, watchedProjectPath);
    if (state.configCache !== undefined && state.configCacheSignature === cacheSignature) {
        return state.configCache;
    }

    const loadedLayers = loadPiExtensionSettings(
        modelFilterSettingsDefinition,
        { cwd, isProjectTrusted: () => state.projectTrusted === true },
        {
            bundledSchema: {
                kind: "url",
                url: new URL("../config.schema.json", import.meta.url),
            },
        },
    );
    const mtimeMs = settingsMtime(configPath);

    try {
        const diagnostics = loadedLayers.diagnostics.map((diagnostic) => diagnostic.message);
        const loaded: LoadedModelFilterSettings = {
            path: configPath,
            mtimeMs,
            settings: decodeModelFilterSettings(loadedLayers.settings),
        };
        if (diagnostics.length > 0) {
            loaded.diagnostic = `Failed to load ${configPath}: ${diagnostics.join("; ")}`;
        }

        state.configCache = loaded;
        state.configCacheSignature = settingsSignature(globalConfigPath, watchedProjectPath);
        return loaded;
    } catch (cause: unknown) {
        let message = String(cause);
        if (cause instanceof Error) message = cause.message;

        const loaded: LoadedModelFilterSettings = {
            path: configPath,
            mtimeMs,
            settings: { includeRules: [], excludeRules: [] },
            diagnostic: `Failed to load ${configPath}: ${message}`,
        };
        state.configCache = loaded;
        state.configCacheSignature = settingsSignature(globalConfigPath, watchedProjectPath);
        return loaded;
    }
}
