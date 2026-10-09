import { loadPiExtensionSettings } from "@zigai/pi-extension-settings/pi";

import { Type, type Static } from "typebox";

import { Value } from "typebox/value";

import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import {
    FOOTER_CUSTOM_SLOT_ID_PATTERN,
    type FooterLayout,
    type FooterSlotId,
} from "./footer-model.ts";
import {
    FOOTER_LAYOUT,
    FooterConfig,
    FooterLayoutSettings,
    FooterLayoutSettingsParseResult,
    FooterSettings,
    FooterSettingsParseResult,
    FooterSettingsSource,
    LoadedFooterConfig,
    extensionSettingsInput,
    footerSlotIdSchema,
} from "./settings-input.ts";
import prevalidatedSettings from "./settings.prevalidated.ts";

export * from "./settings-input.ts";

export const footerSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedSettings,
);

export default footerSettingsDefinition;

const FooterLayoutSchema = Type.Object(
    {
        left: Type.Optional(Type.Array(footerSlotIdSchema, { uniqueItems: true })),
        right: Type.Optional(Type.Array(footerSlotIdSchema, { uniqueItems: true })),
        hidden: Type.Optional(Type.Array(footerSlotIdSchema, { uniqueItems: true })),
    },
    { additionalProperties: false },
);

const FooterConfigSchema = Type.Object(
    {
        $schema: Type.Optional(Type.String()),
        separator: Type.Optional(Type.String()),
        showGitAheadBehind: Type.Optional(Type.Boolean()),
        layout: Type.Optional(FooterLayoutSchema),
    },
    { additionalProperties: false },
);

type ParsedFooterConfig = Static<typeof FooterConfigSchema>;

const BUILTIN_FOOTER_SLOT_IDS = new Set([
    "path",
    "branch",
    "provider",
    "model",
    "thinking",
    "mcp",
    "context",
]);

const FOOTER_CUSTOM_SLOT_ID_REGEX = new RegExp(FOOTER_CUSTOM_SLOT_ID_PATTERN);

export const DEFAULT_FOOTER_CONFIG: FooterConfig = {
    separator: "·",
    showGitAheadBehind: false,
    layout: {
        left: [...FOOTER_LAYOUT.left],
        right: [...FOOTER_LAYOUT.right],
        hidden: [],
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

function isParsedFooterConfig(value: unknown): value is ParsedFooterConfig {
    return Value.Check(FooterConfigSchema, value);
}

function sanitizeSeparator(value: string): string {
    return value
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}

function cloneSlotIds(values: readonly FooterSlotId[]): FooterSlotId[] {
    return [...values];
}

function isFooterSlotId(value: string): value is FooterSlotId {
    return BUILTIN_FOOTER_SLOT_IDS.has(value) || FOOTER_CUSTOM_SLOT_ID_REGEX.test(value);
}

function parseSlotIds(values: readonly string[]): FooterSlotId[] {
    const slotIds: FooterSlotId[] = [];
    for (const value of values) {
        if (isFooterSlotId(value)) {
            slotIds.push(value);
        }
    }

    return slotIds;
}

function findSharedVisibleSlotId(
    left: readonly FooterSlotId[] | undefined,
    right: readonly FooterSlotId[] | undefined,
    hidden: readonly FooterSlotId[] | undefined,
): FooterSlotId | undefined {
    if (left === undefined || right === undefined) return undefined;

    const hiddenIds = new Set(hidden ?? []);
    const leftIds = new Set<FooterSlotId>();
    for (const slotId of left) {
        if (!hiddenIds.has(slotId)) {
            leftIds.add(slotId);
        }
    }

    for (const slotId of right) {
        if (hiddenIds.has(slotId)) continue;
        if (leftIds.has(slotId)) return slotId;
    }

    return undefined;
}

function parseFooterLayoutSettings(
    layout: NonNullable<ParsedFooterConfig["layout"]>,
    label: string,
): FooterLayoutSettingsParseResult {
    const settings: FooterLayoutSettings = {};

    if (layout.left !== undefined) {
        settings.left = parseSlotIds(layout.left);
    }

    if (layout.right !== undefined) {
        settings.right = parseSlotIds(layout.right);
    }

    if (layout.hidden !== undefined) {
        settings.hidden = parseSlotIds(layout.hidden);
    }

    const sharedSlotId = findSharedVisibleSlotId(settings.left, settings.right, settings.hidden);
    if (sharedSlotId !== undefined) {
        return {
            errors: [`${label}.layout cannot place "${sharedSlotId}" on both left and right.`],
        } satisfies FooterLayoutSettingsParseResult;
    }

    return { layout: settings, errors: [] } satisfies FooterLayoutSettingsParseResult;
}

function buildParsedFooterSettings(
    parsed: ParsedFooterConfig,
    label: string,
): FooterSettingsParseResult {
    if (
        parsed.separator === undefined &&
        parsed.showGitAheadBehind === undefined &&
        parsed.layout === undefined
    ) {
        return { settings: {}, errors: [] } satisfies FooterSettingsParseResult;
    }

    const nextSettings: FooterSettings = {};
    const errors: string[] = [];

    if (parsed.separator !== undefined) {
        const sanitized = sanitizeSeparator(parsed.separator);
        if (sanitized.length === 0) {
            errors.push(`${label}.separator must contain a visible character.`);
        } else {
            nextSettings.separator = sanitized;
        }
    }

    if (parsed.showGitAheadBehind !== undefined) {
        nextSettings.showGitAheadBehind = parsed.showGitAheadBehind;
    }

    if (parsed.layout !== undefined) {
        const parsedLayout = parseFooterLayoutSettings(parsed.layout, label);
        if (parsedLayout.layout !== undefined) {
            nextSettings.layout = parsedLayout.layout;
        }

        errors.push(...parsedLayout.errors);
    }

    return { settings: nextSettings, errors } satisfies FooterSettingsParseResult;
}

function buildFooterConfig(settings: FooterSettings): FooterConfig {
    return {
        separator: settings.separator ?? DEFAULT_FOOTER_CONFIG.separator,
        showGitAheadBehind: settings.showGitAheadBehind ?? DEFAULT_FOOTER_CONFIG.showGitAheadBehind,
        layout: {
            left: cloneSlotIds(settings.layout?.left ?? DEFAULT_FOOTER_CONFIG.layout.left),
            right: cloneSlotIds(settings.layout?.right ?? DEFAULT_FOOTER_CONFIG.layout.right),
            hidden: cloneSlotIds(settings.layout?.hidden ?? DEFAULT_FOOTER_CONFIG.layout.hidden),
        },
    };
}

function buildDefaultFooterLayout(): FooterLayout {
    return {
        left: cloneSlotIds(DEFAULT_FOOTER_CONFIG.layout.left),
        right: cloneSlotIds(DEFAULT_FOOTER_CONFIG.layout.right),
        hidden: cloneSlotIds(DEFAULT_FOOTER_CONFIG.layout.hidden),
    };
}

function getFooterLayoutError(layout: FooterLayout): string | undefined {
    const sharedSlotId = findSharedVisibleSlotId(layout.left, layout.right, layout.hidden);
    if (sharedSlotId === undefined) return undefined;
    return `footer layout cannot place "${sharedSlotId}" on both left and right.`;
}

function mergeFooterSettings(current: FooterSettings, next: FooterSettings): FooterSettings {
    const merged: FooterSettings = { ...current, ...next };
    if (current.layout === undefined && next.layout === undefined) {
        return merged;
    }

    merged.layout = { ...current.layout, ...next.layout };
    return merged;
}

export function resolveFooterConfig(
    settingsSources: readonly FooterSettingsSource[],
): LoadedFooterConfig {
    let mergedSettings: FooterSettings = {};
    const errors: string[] = [];

    for (const source of settingsSources) {
        try {
            const settings = source.settings;
            if (!isParsedFooterConfig(settings)) {
                const schemaErrors = [...Value.Errors(FooterConfigSchema, settings)];
                const messages = schemaErrors
                    .slice(0, 5)
                    .map((error) => `${formatSchemaPath(error.instancePath)} ${error.message}`);
                let suffix = "";
                if (schemaErrors.length > messages.length) {
                    suffix = `; and ${schemaErrors.length - messages.length} more`;
                }

                errors.push(`${source.label} is invalid: ${messages.join("; ")}${suffix}`);
                continue;
            }

            const parsed = buildParsedFooterSettings(settings, source.label);
            mergedSettings = mergeFooterSettings(mergedSettings, parsed.settings);
            errors.push(...parsed.errors);
        } catch (error: unknown) {
            let message: string;
            if (error instanceof Error) {
                message = error.message;
            } else {
                message = String(error);
            }

            errors.push(message);
        }
    }

    const config = buildFooterConfig(mergedSettings);
    const layoutError = getFooterLayoutError(config.layout);
    if (layoutError !== undefined) {
        return {
            config: {
                separator: config.separator,
                showGitAheadBehind: config.showGitAheadBehind,
                layout: buildDefaultFooterLayout(),
            },
            errors: [...errors, layoutError],
        };
    }

    return { config, errors };
}

export function loadFooterSettings(cwd: string, projectTrusted: boolean): LoadedFooterConfig {
    const settings = loadPiExtensionSettings(
        footerSettingsDefinition,
        { cwd, isProjectTrusted: () => projectTrusted },
        {
            bundledSchema: {
                kind: "url",
                url: new URL("../config.schema.json", import.meta.url),
            },
        },
    );
    const settingsSources: FooterSettingsSource[] = [];
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

    const loaded = resolveFooterConfig(settingsSources);

    return {
        config: loaded.config,
        errors: [...settings.diagnostics.map((diagnostic) => diagnostic.message), ...loaded.errors],
    };
}
