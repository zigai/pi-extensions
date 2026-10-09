import { loadPiExtensionSettings } from "@zigai/pi-extension-settings/pi";

import { Type } from "typebox";

import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import { Value } from "typebox/value";
import {
    DEFAULT_PASTE_COLLAPSE_CHAR_THRESHOLD,
    DEFAULT_PASTE_COLLAPSE_ENABLED,
    DEFAULT_PASTE_COLLAPSE_EXPAND_KEY,
    DEFAULT_PASTE_COLLAPSE_LINE_THRESHOLD,
    DEFAULT_PASTE_COLLAPSE_USE_TOOL_EXPAND_KEY,
    LoadedUiTweaksConfig,
    OptionalPasteCollapseExpandKeySchema,
    UiTweaksConfig,
    UiTweaksSettings,
    UiTweaksSettingsSource,
    extensionSettingsInput,
} from "./settings-input.ts";
import prevalidatedSettings from "./settings.prevalidated.ts";

export * from "./settings-input.ts";

export const uiTweaksSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedSettings,
);

export default uiTweaksSettingsDefinition;

const UiTweaksConfigSchema = Type.Object(
    {
        $schema: Type.Optional(Type.String()),
        autocompleteAboveInput: Type.Optional(Type.Boolean()),
        bashExecPromptSpacing: Type.Optional(Type.Boolean()),
        anchorInputToBottom: Type.Optional(Type.Boolean()),
        compactModelSelector: Type.Optional(Type.Boolean()),
        enabled: Type.Optional(Type.Boolean()),
        hideAutocompleteScrollInfo: Type.Optional(Type.Boolean()),
        hideModelChangeStatus: Type.Optional(Type.Boolean()),
        hideModelProviderHint: Type.Optional(Type.Boolean()),
        hideSlashCommandSourceTags: Type.Optional(Type.Boolean()),
        highlightSelectedModelProvider: Type.Optional(Type.Boolean()),
        inputPromptPrefix: Type.Optional(Type.String({ minLength: 1 })),
        neutralBorderColor: Type.Optional(Type.Boolean()),
        pasteCollapseCharThreshold: Type.Optional(Type.Integer({ minimum: 0 })),
        pasteCollapseEnabled: Type.Optional(Type.Boolean()),
        pasteCollapseExpandKey: Type.Optional(OptionalPasteCollapseExpandKeySchema),
        pasteCollapseLineThreshold: Type.Optional(Type.Integer({ minimum: 0 })),
        pasteCollapseUseToolExpandKey: Type.Optional(Type.Boolean()),
        preserveCompactionHistory: Type.Optional(Type.Boolean()),
        restoreContentAfterAutocompleteClose: Type.Optional(Type.Boolean()),
        refreshTmuxHyperlinks: Type.Optional(Type.Boolean()),
        selectedOptionPrefix: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
);

const DEFAULT_UI_TWEAKS_CONFIG: UiTweaksConfig = {
    autocompleteAboveInput: true,
    bashExecPromptSpacing: true,
    anchorInputToBottom: false,
    compactModelSelector: true,
    hideAutocompleteScrollInfo: true,
    hideModelChangeStatus: true,
    hideModelProviderHint: true,
    hideSlashCommandSourceTags: true,
    highlightSelectedModelProvider: true,
    inputPromptPrefix: "> ",
    neutralBorderColor: true,
    pasteCollapseCharThreshold: DEFAULT_PASTE_COLLAPSE_CHAR_THRESHOLD,
    pasteCollapseEnabled: DEFAULT_PASTE_COLLAPSE_ENABLED,
    pasteCollapseExpandKey: DEFAULT_PASTE_COLLAPSE_EXPAND_KEY,
    pasteCollapseLineThreshold: DEFAULT_PASTE_COLLAPSE_LINE_THRESHOLD,
    pasteCollapseUseToolExpandKey: DEFAULT_PASTE_COLLAPSE_USE_TOOL_EXPAND_KEY,
    preserveCompactionHistory: false,
    restoreContentAfterAutocompleteClose: true,
    refreshTmuxHyperlinks: true,
    selectedOptionPrefix: "→ ",
};

function formatSchemaPath(instancePath: string): string {
    if (instancePath.length === 0) return "root";
    return instancePath
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
        .join(".");
}

type ParsedUiTweaksSettingsResult = {
    readonly settings: UiTweaksSettings;
    readonly errors: readonly string[];
};

const uiTweaksSettingsParser = {
    parse(settings: unknown, label: string): ParsedUiTweaksSettingsResult {
        try {
            const errors = [...Value.Errors(UiTweaksConfigSchema, settings)];
            if (errors.length > 0) {
                const messages = errors
                    .slice(0, 10)
                    .map((error) => `${formatSchemaPath(error.instancePath)} ${error.message}`);
                let suffix = "";
                if (errors.length > messages.length) {
                    suffix = `; and ${errors.length - messages.length} more`;
                }

                throw new Error(`${label} is invalid: ${messages.join("; ")}${suffix}`);
            }

            const parsed = Value.Parse(UiTweaksConfigSchema, settings);
            return {
                settings: parsed,
                errors: [],
            } satisfies ParsedUiTweaksSettingsResult;
        } catch (cause: unknown) {
            let message = String(cause);
            if (cause instanceof Error) message = cause.message;

            return { settings: {}, errors: [message] } satisfies ParsedUiTweaksSettingsResult;
        }
    },
};

function buildUiTweaksConfig(settings: UiTweaksSettings): UiTweaksConfig {
    if (settings.enabled === false) {
        return {
            autocompleteAboveInput: false,
            bashExecPromptSpacing: false,
            anchorInputToBottom: false,
            compactModelSelector: false,
            hideAutocompleteScrollInfo: false,
            hideModelChangeStatus: false,
            hideModelProviderHint: false,
            hideSlashCommandSourceTags: false,
            highlightSelectedModelProvider: false,
            inputPromptPrefix: DEFAULT_UI_TWEAKS_CONFIG.inputPromptPrefix,
            neutralBorderColor: false,
            pasteCollapseCharThreshold: DEFAULT_UI_TWEAKS_CONFIG.pasteCollapseCharThreshold,
            pasteCollapseEnabled: false,
            pasteCollapseExpandKey: DEFAULT_UI_TWEAKS_CONFIG.pasteCollapseExpandKey,
            pasteCollapseLineThreshold: DEFAULT_UI_TWEAKS_CONFIG.pasteCollapseLineThreshold,
            pasteCollapseUseToolExpandKey: false,
            preserveCompactionHistory: false,
            restoreContentAfterAutocompleteClose: false,
            refreshTmuxHyperlinks: false,
            selectedOptionPrefix: DEFAULT_UI_TWEAKS_CONFIG.selectedOptionPrefix,
        };
    }

    return {
        autocompleteAboveInput:
            settings.autocompleteAboveInput ?? DEFAULT_UI_TWEAKS_CONFIG.autocompleteAboveInput,
        bashExecPromptSpacing:
            settings.bashExecPromptSpacing ?? DEFAULT_UI_TWEAKS_CONFIG.bashExecPromptSpacing,
        anchorInputToBottom:
            settings.anchorInputToBottom ?? DEFAULT_UI_TWEAKS_CONFIG.anchorInputToBottom,
        compactModelSelector:
            settings.compactModelSelector ?? DEFAULT_UI_TWEAKS_CONFIG.compactModelSelector,
        hideAutocompleteScrollInfo:
            settings.hideAutocompleteScrollInfo ??
            DEFAULT_UI_TWEAKS_CONFIG.hideAutocompleteScrollInfo,
        hideModelChangeStatus:
            settings.hideModelChangeStatus ?? DEFAULT_UI_TWEAKS_CONFIG.hideModelChangeStatus,
        hideModelProviderHint:
            settings.hideModelProviderHint ?? DEFAULT_UI_TWEAKS_CONFIG.hideModelProviderHint,
        hideSlashCommandSourceTags:
            settings.hideSlashCommandSourceTags ??
            DEFAULT_UI_TWEAKS_CONFIG.hideSlashCommandSourceTags,
        highlightSelectedModelProvider:
            settings.highlightSelectedModelProvider ??
            DEFAULT_UI_TWEAKS_CONFIG.highlightSelectedModelProvider,
        inputPromptPrefix: settings.inputPromptPrefix ?? DEFAULT_UI_TWEAKS_CONFIG.inputPromptPrefix,
        neutralBorderColor:
            settings.neutralBorderColor ?? DEFAULT_UI_TWEAKS_CONFIG.neutralBorderColor,
        pasteCollapseCharThreshold:
            settings.pasteCollapseCharThreshold ??
            DEFAULT_UI_TWEAKS_CONFIG.pasteCollapseCharThreshold,
        pasteCollapseEnabled:
            settings.pasteCollapseEnabled ?? DEFAULT_UI_TWEAKS_CONFIG.pasteCollapseEnabled,
        pasteCollapseExpandKey:
            settings.pasteCollapseExpandKey ?? DEFAULT_UI_TWEAKS_CONFIG.pasteCollapseExpandKey,
        pasteCollapseLineThreshold:
            settings.pasteCollapseLineThreshold ??
            DEFAULT_UI_TWEAKS_CONFIG.pasteCollapseLineThreshold,
        pasteCollapseUseToolExpandKey:
            settings.pasteCollapseUseToolExpandKey ??
            DEFAULT_UI_TWEAKS_CONFIG.pasteCollapseUseToolExpandKey,
        preserveCompactionHistory:
            settings.preserveCompactionHistory ??
            DEFAULT_UI_TWEAKS_CONFIG.preserveCompactionHistory,
        restoreContentAfterAutocompleteClose:
            settings.restoreContentAfterAutocompleteClose ??
            DEFAULT_UI_TWEAKS_CONFIG.restoreContentAfterAutocompleteClose,
        refreshTmuxHyperlinks:
            settings.refreshTmuxHyperlinks ?? DEFAULT_UI_TWEAKS_CONFIG.refreshTmuxHyperlinks,
        selectedOptionPrefix:
            settings.selectedOptionPrefix ?? DEFAULT_UI_TWEAKS_CONFIG.selectedOptionPrefix,
    };
}

/**
 * Resolves UI tweak settings from already-parsed extension config objects in precedence order.
 */
export function resolveUiTweaksConfig(
    settingsSources: readonly UiTweaksSettingsSource[],
): LoadedUiTweaksConfig {
    let mergedSettings: UiTweaksSettings = {};
    const errors: string[] = [];

    for (const source of settingsSources) {
        const parsed = uiTweaksSettingsParser.parse(source.settings, source.label);
        Object.assign(mergedSettings, parsed.settings);
        errors.push(...parsed.errors);
    }

    return {
        config: buildUiTweaksConfig(mergedSettings),
        errors,
    };
}

/** Load UI tweak settings from global and trusted-project extension settings. */
export function loadUiTweaksSettings(cwd: string, projectTrusted: boolean): LoadedUiTweaksConfig {
    const settings = loadPiExtensionSettings(
        uiTweaksSettingsDefinition,
        { cwd, isProjectTrusted: () => projectTrusted },
        {
            bundledSchema: {
                kind: "url",
                url: new URL("../config.schema.json", import.meta.url),
            },
        },
    );
    const settingsSources: UiTweaksSettingsSource[] = [];
    if (settings.globalSettingsLayer !== undefined) {
        settingsSources.push({
            label: settings.globalConfigPath,
            settings: settings.globalSettingsLayer,
        });
    }

    if (settings.projectSettingsLayer !== undefined && settings.projectConfigPath !== undefined) {
        settingsSources.push({
            label: settings.projectConfigPath,
            settings: settings.projectSettingsLayer,
        });
    }

    const loaded = resolveUiTweaksConfig(settingsSources);

    return {
        config: loaded.config,
        errors: [...settings.diagnostics.map((diagnostic) => diagnostic.message), ...loaded.errors],
    };
}
