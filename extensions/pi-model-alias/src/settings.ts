import {
    getPiGlobalSettingsPath,
    getPiProjectSettingsPath,
    loadPiExtensionSettings,
} from "@zigai/pi-extension-settings/pi";

import { existsSync, statSync } from "node:fs";

import { Type, type Static } from "typebox";

import { Value } from "typebox/value";

import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import type { AliasConfig, ModelAliasSettings, ProviderAliasConfig } from "./model-aliasing.ts";
import {
    EXTENSION_ID,
    LoadedModelAliasSettings,
    ModelAliasSettingsLoadState,
    aliasConfigSchema,
    extensionSettingsInput,
    providerAliasConfigSchema,
} from "./settings-input.ts";
import prevalidatedSettings from "./settings.prevalidated.ts";

export * from "./settings-input.ts";

export const modelAliasSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedSettings,
);

export default modelAliasSettingsDefinition;

const ModelAliasesConfigSchema = Type.Object(
    {
        $schema: Type.Optional(Type.String()),
        aliases: Type.Optional(Type.Array(aliasConfigSchema)),
        providerAliases: Type.Optional(Type.Array(providerAliasConfigSchema)),
        stableProviderColumn: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

type ParsedAliasConfig = Static<typeof aliasConfigSchema>;
type ParsedProviderAliasConfig = Static<typeof providerAliasConfigSchema>;

export type ModelAliasConfigInput = {
    readonly $schema?: unknown;
    readonly aliases?: unknown;
    readonly providerAliases?: unknown;
    readonly stableProviderColumn?: unknown;
};

function formatSchemaPath(instancePath: string): string {
    if (instancePath.length === 0) return "root";
    return instancePath
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
        .join(".");
}

function parseModelAliasesConfig(
    value: ModelAliasConfigInput,
): Static<typeof ModelAliasesConfigSchema> {
    const errors = [...Value.Errors(ModelAliasesConfigSchema, value)];
    if (errors.length > 0) {
        const messages = errors
            .slice(0, 5)
            .map((error) => `${formatSchemaPath(error.instancePath)} ${error.message}`);
        let suffix = "";
        if (errors.length > messages.length) {
            suffix = `; and ${errors.length - messages.length} more`;
        }

        throw new Error(`pi-model-alias config.json is invalid: ${messages.join("; ")}${suffix}`);
    }

    return Value.Parse(ModelAliasesConfigSchema, value);
}

function normalizeAliasConfig(entry: ParsedAliasConfig): AliasConfig {
    const normalized: AliasConfig = {
        provider: entry.provider.trim(),
        model: entry.model.trim(),
        alias: entry.alias.trim(),
    };
    if (entry.name !== undefined) normalized.name = entry.name.trim();

    return normalized;
}

function normalizeProviderAliasConfig(entry: ParsedProviderAliasConfig): ProviderAliasConfig {
    return { provider: entry.provider.trim(), name: entry.name.trim() };
}

function validateUniqueAliases(aliases: readonly AliasConfig[]): void {
    const seenAliases = new Map<string, number>();

    aliases.forEach((entry, index) => {
        const aliasKey = `${entry.provider}\0${entry.alias}`;
        const duplicateIndex = seenAliases.get(aliasKey);
        if (duplicateIndex !== undefined) {
            throw new Error(
                `aliases[${index}] duplicates aliases[${duplicateIndex}] for provider "${entry.provider}" and alias "${entry.alias}".`,
            );
        }

        seenAliases.set(aliasKey, index);
    });
}

function validateUniqueProviderAliases(providerAliases: readonly ProviderAliasConfig[]): void {
    const seenProviders = new Map<string, number>();

    providerAliases.forEach((entry, index) => {
        const duplicateIndex = seenProviders.get(entry.provider);
        if (duplicateIndex !== undefined) {
            throw new Error(
                `providerAliases[${index}] duplicates providerAliases[${duplicateIndex}] for provider "${entry.provider}".`,
            );
        }

        seenProviders.set(entry.provider, index);
    });
}

export function decodeModelAliasSettings(config: ModelAliasConfigInput): ModelAliasSettings {
    const parsed = parseModelAliasesConfig(config);
    const aliases = (parsed.aliases ?? []).map(normalizeAliasConfig);
    const providerAliases = (parsed.providerAliases ?? []).map(normalizeProviderAliasConfig);

    validateUniqueAliases(aliases);
    validateUniqueProviderAliases(providerAliases);

    return {
        aliases,
        providerAliases,
        stableProviderColumn: parsed.stableProviderColumn ?? true,
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

export function loadModelAliasSettings(
    state: ModelAliasSettingsLoadState,
): LoadedModelAliasSettings {
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
        modelAliasSettingsDefinition,
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
        const normalized = decodeModelAliasSettings(loadedLayers.settings);
        const diagnostics = loadedLayers.diagnostics.map((diagnostic) => diagnostic.message);
        const loaded: LoadedModelAliasSettings = {
            path: configPath,
            mtimeMs,
            settings: normalized,
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

        const loaded: LoadedModelAliasSettings = {
            path: configPath,
            mtimeMs,
            settings: { aliases: [], providerAliases: [], stableProviderColumn: true },
            diagnostic: `Failed to load ${configPath}: ${message}`,
        };

        state.configCache = loaded;
        state.configCacheSignature = settingsSignature(globalConfigPath, watchedProjectPath);
        return loaded;
    }
}
