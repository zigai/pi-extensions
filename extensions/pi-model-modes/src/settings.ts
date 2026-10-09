import { type ExtensionSettingsLayer, type ResolvedSettings } from "@zigai/pi-extension-settings";

import {
    loadPiExtensionSettings,
    updatePiExtensionSettings,
    type BundledSchemaSource,
    type SettingsDiagnostic,
} from "@zigai/pi-extension-settings/pi";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Static } from "typebox";

import { Value } from "typebox/value";

import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import {
    SHOW_THINKING_LEVEL_STATUS_SETTINGS_KEY,
    USE_THINKING_BORDER_COLORS_SETTINGS_KEY,
    extensionSettingsInput,
    modeShortcutsSchema,
} from "./settings-input.ts";
import prevalidatedSettings from "./settings.prevalidated.ts";

export * from "./settings-input.ts";

export const modelModesSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedSettings,
);

export default modelModesSettingsDefinition;

const EXTENSION_ID = "pi-model-modes";
const BUNDLED_SETTINGS_SCHEMA_URL = new URL("../config.schema.json", import.meta.url);

export type ModeShortcuts = Static<typeof modeShortcutsSchema>;
type SettingsObject = ExtensionSettingsLayer<typeof extensionSettingsInput.schema>;
type ModelModesSettings = ResolvedSettings<typeof modelModesSettingsDefinition>;

type ModeDisplaySettings = {
    readonly useThinkingBorderColors: ModelModesSettings[typeof USE_THINKING_BORDER_COLORS_SETTINGS_KEY];
    readonly showThinkingLevelStatus: ModelModesSettings[typeof SHOW_THINKING_LEVEL_STATUS_SETTINGS_KEY];
};

export type SettingsReadContext = {
    readonly cwd: string;
    readonly projectTrusted: boolean;
};

export function createStableBundledSchemaSource(url: URL): () => BundledSchemaSource {
    let content: string | undefined;
    return () => {
        if (content !== undefined) return { kind: "content", content };

        try {
            content = readFileSync(url, "utf8");
            return { kind: "content", content };
        } catch {
            return { kind: "url", url };
        }
    };
}

// Pi can retain imported definition modules while rebinding extensions for /new. Cache the schema
// read by that same module instance so a concurrently updated source checkout cannot mix versions.
const bundledSettingsSchemaSource = createStableBundledSchemaSource(BUNDLED_SETTINGS_SCHEMA_URL);

export function formatModelModesSettingsDiagnostic(diagnostic: SettingsDiagnostic): string {
    const prefix = `[${EXTENSION_ID}]`;
    if (diagnostic.code === "bundled-schema-stale") {
        return `${prefix} Generated settings schema does not match the loaded definition: ${fileURLToPath(BUNDLED_SETTINGS_SCHEMA_URL)}. In a source checkout, run "npm run config:generate" from the repository root and restart Pi; otherwise reinstall or update the extension.`;
    }

    if (diagnostic.code === "bundled-schema-read-failed") {
        return `${prefix} Bundled settings schema could not be read: ${fileURLToPath(BUNDLED_SETTINGS_SCHEMA_URL)}.`;
    }

    return `${prefix} ${diagnostic.message}: ${diagnostic.path}`;
}

export function loadModelModesSettings(context: SettingsReadContext) {
    return loadPiExtensionSettings(
        modelModesSettingsDefinition,
        {
            cwd: context.cwd,
            isProjectTrusted: () => context.projectTrusted,
        },
        { bundledSchema: bundledSettingsSchemaSource() },
    );
}

export type LoadedModelModesSettings = ReturnType<typeof loadModelModesSettings>;

async function updateSettingsObject(
    context: SettingsReadContext,
    update: (settings: SettingsObject) => void,
): Promise<void> {
    loadModelModesSettings(context);

    const result = await updatePiExtensionSettings(
        modelModesSettingsDefinition,
        { cwd: context.cwd, isProjectTrusted: () => context.projectTrusted },
        {
            scope: "global",
            update: (settings) => {
                update(settings);
                return settings;
            },
        },
    );
    switch (result.status) {
        case "updated":
        case "unchanged":
            return;
        case "blocked":
        case "conflict":
        case "failed":
        case "invalid-existing":
        case "invalid-update":
            throw new Error(result.message);
    }
}

export function resolveModeShortcuts(value: ModeShortcuts | undefined): ModeShortcuts {
    if (!Value.Check(modeShortcutsSchema, value)) return {};
    return Value.Parse(modeShortcutsSchema, value);
}

export function getConfiguredModeShortcuts(context: SettingsReadContext): ModeShortcuts {
    const value = loadModelModesSettings(context).globalSettingsLayer?.shortcuts;
    if (!Value.Check(modeShortcutsSchema, value)) return {};
    return resolveModeShortcuts(Value.Parse(modeShortcutsSchema, value));
}

function readModeSettings(context: SettingsReadContext): ModeDisplaySettings {
    const settings = loadModelModesSettings(context).settings;
    return {
        useThinkingBorderColors: settings[USE_THINKING_BORDER_COLORS_SETTINGS_KEY],
        showThinkingLevelStatus: settings[SHOW_THINKING_LEVEL_STATUS_SETTINGS_KEY],
    };
}

export function shouldUseThinkingBorderColors(context: SettingsReadContext): boolean {
    return readModeSettings(context).useThinkingBorderColors;
}

export function shouldShowThinkingLevelStatus(context: SettingsReadContext): boolean {
    return readModeSettings(context).showThinkingLevelStatus;
}

export async function setUseThinkingBorderColors(
    context: SettingsReadContext,
    useThinkingBorderColors: boolean,
): Promise<void> {
    return updateSettingsObject(context, (settings) => {
        settings[USE_THINKING_BORDER_COLORS_SETTINGS_KEY] = useThinkingBorderColors;
    });
}

export async function setShowThinkingLevelStatus(
    context: SettingsReadContext,
    showThinkingLevelStatus: boolean,
): Promise<void> {
    return updateSettingsObject(context, (settings) => {
        settings[SHOW_THINKING_LEVEL_STATUS_SETTINGS_KEY] = showThinkingLevelStatus;
    });
}
