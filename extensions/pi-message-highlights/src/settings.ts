import { loadPiExtensionSettings } from "@zigai/pi-extension-settings/pi";

import { Type, type Static } from "typebox";

import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import { Value } from "typebox/value";
import {
    DEFAULT_URL_COLOR_SETTING,
    THEME_FOREGROUND_COLORS,
    ThemeForegroundColor,
    ansiColorSettingSchema,
    extensionSettingsInput,
    urlColorSettingSchema,
} from "./settings-input.ts";
import prevalidatedSettings from "./settings.prevalidated.ts";

export * from "./settings-input.ts";

export const messageHighlightsSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedSettings,
);

export default messageHighlightsSettingsDefinition;

export type HighlightColor =
    | {
          readonly kind: "none";
      }
    | {
          readonly kind: "theme";
          readonly color: ThemeForegroundColor;
      }
    | {
          readonly kind: "ansi256";
          readonly color: number;
      }
    | {
          readonly kind: "hex";
          readonly color: `#${string}`;
      };

export type MessageHighlightsConfig = {
    readonly urlColor: HighlightColor;
};

export type LoadedMessageHighlightsConfig = {
    readonly config: MessageHighlightsConfig;
    readonly errors: readonly string[];
};

export type MessageHighlightsSettingsSource = {
    readonly label: string;
    readonly settings: unknown;
};

type MessageHighlightsSettings = {
    readonly $schema?: string;
    readonly urlColor?: UrlColorSetting;
};

type UrlColorSetting = Static<typeof urlColorSettingSchema>;

const MessageHighlightsConfigSchema = Type.Object(
    {
        $schema: Type.Optional(Type.String()),
        urlColor: Type.Optional(urlColorSettingSchema),
    },
    { additionalProperties: false },
);

const THEME_FOREGROUND_COLOR_SET = new Set<string>(THEME_FOREGROUND_COLORS);

export const DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG: MessageHighlightsConfig = {
    urlColor: {
        kind: "hex",
        color: DEFAULT_URL_COLOR_SETTING,
    },
};

function formatSchemaPath(instancePath: string): string {
    if (instancePath.length === 0) return "root";
    return instancePath
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
        .join(".");
}

function isMessageHighlightsSettings(value: unknown): value is MessageHighlightsSettings {
    return Value.Check(MessageHighlightsConfigSchema, value);
}

type ParsedSettingsResult = {
    settings: MessageHighlightsSettings;
    errors: string[];
};

const messageHighlightsSettingsParser = {
    parse(settings: unknown, label: string): ParsedSettingsResult {
        const errors = [...Value.Errors(MessageHighlightsConfigSchema, settings)];
        if (errors.length > 0) {
            const messages = errors
                .slice(0, 5)
                .map((error) => `${formatSchemaPath(error.instancePath)} ${error.message}`);
            let suffix = "";
            if (errors.length > messages.length) {
                suffix = `; and ${errors.length - messages.length} more`;
            }

            return {
                settings: {},
                errors: [`${label} is invalid: ${messages.join("; ")}${suffix}`],
            };
        }

        if (!isMessageHighlightsSettings(settings)) {
            return { settings: {}, errors: [`${label} is invalid: root failed schema parsing`] };
        }

        return { settings, errors: [] };
    },
};

function isHexColor(value: string): value is `#${string}` {
    return /^#[0-9a-fA-F]{6}$/.test(value);
}

function isThemeForegroundColor(value: string): value is ThemeForegroundColor {
    return THEME_FOREGROUND_COLOR_SET.has(value);
}

function isAnsiColorSetting(setting: UrlColorSetting): setting is number {
    return Value.Check(ansiColorSettingSchema, setting);
}

function parseUrlColorSetting(setting: UrlColorSetting): HighlightColor {
    if (isAnsiColorSetting(setting)) {
        return { kind: "ansi256", color: setting };
    }

    if (setting === "") {
        return { kind: "none" };
    }

    if (isHexColor(setting)) {
        return { kind: "hex", color: setting };
    }

    if (isThemeForegroundColor(setting)) {
        return { kind: "theme", color: setting };
    }

    throw new Error(`Invalid parsed URL color: ${setting}`);
}

function buildMessageHighlightsConfig(
    settings: MessageHighlightsSettings,
): MessageHighlightsConfig {
    if (settings.urlColor === undefined) return DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG;

    return {
        urlColor: parseUrlColorSetting(settings.urlColor),
    };
}

export function resolveMessageHighlightsConfig(
    settingsSources: readonly MessageHighlightsSettingsSource[],
): LoadedMessageHighlightsConfig {
    let mergedSettings: MessageHighlightsSettings = {};
    const errors: string[] = [];

    for (const source of settingsSources) {
        const parsed = messageHighlightsSettingsParser.parse(source.settings, source.label);
        Object.assign(mergedSettings, parsed.settings);
        errors.push(...parsed.errors);
    }

    return {
        config: buildMessageHighlightsConfig(mergedSettings),
        errors,
    };
}

export function loadMessageHighlightsSettings(
    cwd: string,
    projectTrusted: boolean,
): LoadedMessageHighlightsConfig {
    const settings = loadPiExtensionSettings(
        messageHighlightsSettingsDefinition,
        { cwd, isProjectTrusted: () => projectTrusted },
        {
            bundledSchema: {
                kind: "url",
                url: new URL("../config.schema.json", import.meta.url),
            },
        },
    );
    const settingsSources: MessageHighlightsSettingsSource[] = [];
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

    const loaded = resolveMessageHighlightsConfig(settingsSources);

    return {
        config: loaded.config,
        errors: [...settings.diagnostics.map((diagnostic) => diagnostic.message), ...loaded.errors],
    };
}
