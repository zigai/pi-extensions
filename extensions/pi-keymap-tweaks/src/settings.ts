import { loadPiExtensionSettings } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import { Value } from "typebox/value";

import {
    DEFAULT_CYCLE_THINKING_BACKWARD_KEY,
    extensionSettingsInput,
    KeymapTweaksConfigSchema,
    type KeymapTweaksConfig,
} from "./settings-input.ts";
import prevalidatedSettings from "./settings.prevalidated.ts";

export * from "./settings-input.ts";

export const keymapTweaksSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedSettings,
);

export default keymapTweaksSettingsDefinition;

export type LoadedKeymapTweaksConfig = {
    readonly config: KeymapTweaksConfig;
    readonly errors: readonly string[];
};

export type KeymapTweaksSettingsSource = {
    readonly label: string;
    readonly settings: unknown;
};

export type KeymapTweaksSettings = {
    $schema?: string;
    cycleThinkingBackwardKey?: string | null;
};

function formatSchemaPath(instancePath: string): string {
    if (instancePath.length === 0) {
        return "root";
    }

    return instancePath
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
        .join(".");
}

type ParsedKeymapTweaksSettingsResult = {
    readonly settings: KeymapTweaksSettings;
    readonly errors: readonly string[];
};

const keymapTweaksSettingsParser = {
    parse(settings: unknown, label: string): ParsedKeymapTweaksSettingsResult {
        try {
            const errors = [...Value.Errors(KeymapTweaksConfigSchema, settings)];
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

            const parsed = Value.Parse(KeymapTweaksConfigSchema, settings);
            return {
                settings: parsed,
                errors: [],
            } satisfies ParsedKeymapTweaksSettingsResult;
        } catch (cause: unknown) {
            let message = String(cause);
            if (cause instanceof Error) {
                message = cause.message;
            }

            return { settings: {}, errors: [message] } satisfies ParsedKeymapTweaksSettingsResult;
        }
    },
};

function buildKeymapTweaksConfig(settings: KeymapTweaksSettings): KeymapTweaksConfig {
    return {
        cycleThinkingBackwardKey:
            settings.cycleThinkingBackwardKey ?? DEFAULT_CYCLE_THINKING_BACKWARD_KEY,
    };
}

export function resolveKeymapTweaksConfig(
    settingsSources: readonly KeymapTweaksSettingsSource[],
): LoadedKeymapTweaksConfig {
    const mergedSettings: KeymapTweaksSettings = {};
    const errors: string[] = [];

    for (const source of settingsSources) {
        const parsed = keymapTweaksSettingsParser.parse(source.settings, source.label);
        Object.assign(mergedSettings, parsed.settings);
        errors.push(...parsed.errors);
    }

    return {
        config: buildKeymapTweaksConfig(mergedSettings),
        errors,
    };
}

export function loadKeymapTweaksSettings(
    cwd: string,
    projectTrusted: boolean,
): LoadedKeymapTweaksConfig {
    const settings = loadPiExtensionSettings(
        keymapTweaksSettingsDefinition,
        { cwd, isProjectTrusted: () => projectTrusted },
        {
            bundledSchema: {
                kind: "url",
                url: new URL("../config.schema.json", import.meta.url),
            },
        },
    );

    return {
        config: settings.settings,
        errors: settings.diagnostics.map((diagnostic) => diagnostic.message),
    };
}
