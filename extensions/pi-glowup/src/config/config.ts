import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { Value } from "typebox/value";
import type {
    RenderingAppearance,
    ScriptPreviewHeaderLayout,
    ToolCallIndicator,
} from "../rendering/core.ts";
import {
    extensionSettingsDefinition,
    loadGlowupSettings,
    settingsSchema,
    type ExtensionSettings,
} from "../settings.ts";
import {
    parseScriptFormatterCommandsValue,
    type ScriptFormatterCommands,
} from "../script-preview/formatters.ts";
import type { ToolLabelMode } from "../rendering/status-labels.ts";
import type { MutationSettings } from "../mutations/settings.ts";
import { isRecord } from "../unknown-values.ts";

export type GlowupConfig = {
    readonly preserveTools: readonly string[];
    readonly mutations: MutationSettings;
    readonly appearance: RenderingAppearance;
    readonly debugLog: {
        readonly enabled: boolean;
        readonly path: string;
        readonly maxBytes: number | null;
        readonly memorySampleIntervalMs: number;
    };
    readonly scriptFormatters: ScriptFormatterCommands;
    readonly scriptHeaderLayout: ScriptPreviewHeaderLayout;
    readonly scriptMaxCodePreviewLines: number;
    readonly toolCallIndicator: ToolCallIndicator;
    readonly toolLabels: {
        readonly mode: ToolLabelMode;
    };
    readonly writePreview: {
        readonly movingViewport: boolean;
    };
    readonly syntax: {
        readonly preloadLanguages: readonly string[];
        readonly bracketPairColoring: boolean;
        readonly projectLanguageDetection: {
            readonly enabled: boolean;
        };
    };
    readonly patches: {
        readonly assistantSeparator: boolean;
        readonly workingWidgetSpacing: boolean;
        readonly autocompleteCleanup: boolean;
        readonly markdownSyntax: boolean;
        readonly thirdPartyToolRenderers: boolean;
    };
};

export type ConfigWarningReporter = (message: string) => void;

export type GlowupConfigLoadPolicy = {
    readonly includeProjectConfig?: boolean;
};

const GLOWUP_EXTENSION_ID = "pi-glowup";
const EXTENSION_SETTINGS_DIRECTORY = "extension-settings";
const GLOWUP_CONFIG_BASENAME = `${GLOWUP_EXTENSION_ID}.json`;
const GLOWUP_CONFIG_SCHEMA_BASENAME = `${GLOWUP_EXTENSION_ID}.schema.json`;
const GLOWUP_DIAGNOSTICS_DIRECTORY = GLOWUP_EXTENSION_ID;
const LEGACY_CONFIG_BASENAME = "config.json";

/** Complete generated settings document used by the README and test fixtures. */
export const DEFAULT_GLOWUP_CONFIG_JSON = {
    $schema: `./schemas/${GLOWUP_CONFIG_SCHEMA_BASENAME}`,
    ...extensionSettingsDefinition.defaultSettings,
};

function reportLoadedDiagnostics(
    diagnostics: readonly { readonly message: string }[],
    reportWarning: ConfigWarningReporter,
): void {
    for (const diagnostic of diagnostics) {
        reportWarning(`[pi-glowup] ${diagnostic.message}`);
    }
}

function normalizeGlowupConfig(
    settings: ExtensionSettings,
    reportWarning: ConfigWarningReporter | undefined,
): GlowupConfig {
    return {
        preserveTools: settings.preserveTools.filter((value) => value.trim().length > 0),
        mutations: settings.mutations,
        appearance: settings.appearance,
        debugLog: settings.debugLog,
        scriptFormatters: parseScriptFormatterCommandsValue(settings.scriptPreview.formatters, {
            source: "settings.scriptPreview.formatters",
            ...(reportWarning === undefined ? {} : { reportWarning }),
        }),
        scriptHeaderLayout: settings.scriptPreview.headerLayout,
        scriptMaxCodePreviewLines: settings.scriptPreview.maxCodePreviewLines,
        toolCallIndicator: settings.toolCallIndicator,
        toolLabels: settings.toolLabels,
        writePreview: settings.writePreview,
        syntax: settings.syntax,
        patches: settings.patches,
    };
}

function mergeConfigInputs(base: unknown, override: unknown): unknown {
    if (!isRecord(base) || !isRecord(override)) return override;

    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
        merged[key] = mergeConfigInputs(merged[key], value);
    }
    return merged;
}

function withoutSchemaMetadata(input: unknown): unknown {
    if (!isRecord(input)) return input;
    const { $schema: _schema, ...settings } = input;
    return settings;
}

function isNodeErrorWithCode(cause: unknown, code: string): boolean {
    return isRecord(cause) && cause.code === code;
}

function serializeJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function migrateLegacySettingsFile(
    legacyPath: string,
    settingsPath: string,
    reportWarning: ConfigWarningReporter | undefined,
): void {
    if (existsSync(settingsPath) || !existsSync(legacyPath)) return;

    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(legacyPath, "utf8"));
    } catch {
        reportWarning?.(`[pi-glowup] Legacy settings at ${legacyPath} were not migrated.`);
        return;
    }

    const candidate = mergeConfigInputs(
        extensionSettingsDefinition.defaultSettings,
        withoutSchemaMetadata(raw),
    );
    if (!Value.Check(settingsSchema, candidate) || !isRecord(raw)) {
        reportWarning?.(`[pi-glowup] Legacy settings at ${legacyPath} were not migrated.`);
        return;
    }

    const { $schema: _schema, ...settings } = raw;
    const migrated = {
        $schema: `./schemas/${GLOWUP_CONFIG_SCHEMA_BASENAME}`,
        ...settings,
    };
    try {
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, serializeJson(migrated), {
            encoding: "utf8",
            flag: "wx",
        });
    } catch (cause: unknown) {
        if (!isNodeErrorWithCode(cause, "EEXIST")) {
            reportWarning?.(`[pi-glowup] Legacy settings at ${legacyPath} were not migrated.`);
        }
    }
}

function configSchemaErrorSummary(input: unknown): string {
    const errors = [...Value.Errors(settingsSchema, input)];
    const messages = errors.slice(0, 3).map((error) => {
        const path = error.instancePath.length > 0 ? error.instancePath : "/";
        return `${path} ${error.message}`;
    });
    if (errors.length > messages.length) {
        messages.push(`+${errors.length - messages.length} more`);
    }
    return messages.join("; ") || "invalid settings shape";
}

/** Parse a partial settings object with the definition's defaults. */
export function parseGlowupConfig(
    input: unknown,
    options: {
        readonly source?: string;
        readonly reportWarning?: ConfigWarningReporter;
    } = {},
): GlowupConfig {
    const candidate = mergeConfigInputs(
        extensionSettingsDefinition.defaultSettings,
        withoutSchemaMetadata(input),
    );
    if (!Value.Check(settingsSchema, candidate)) {
        options.reportWarning?.(
            `[pi-glowup] Ignoring invalid ${options.source ?? "config"}: ${configSchemaErrorSummary(candidate)}`,
        );
        return normalizeGlowupConfig(
            Value.Decode(settingsSchema, extensionSettingsDefinition.defaultSettings),
            options.reportWarning,
        );
    }

    return normalizeGlowupConfig(Value.Decode(settingsSchema, candidate), options.reportWarning);
}

export function getGlowupGlobalConfigPath(agentDir: string = getAgentDir()): string {
    return join(agentDir, EXTENSION_SETTINGS_DIRECTORY, GLOWUP_CONFIG_BASENAME);
}

export function getGlowupProjectConfigPath(cwd: string): string {
    return join(cwd, CONFIG_DIR_NAME, EXTENSION_SETTINGS_DIRECTORY, GLOWUP_CONFIG_BASENAME);
}

export function getGlowupGlobalConfigSchemaPath(agentDir: string = getAgentDir()): string {
    return join(agentDir, EXTENSION_SETTINGS_DIRECTORY, "schemas", GLOWUP_CONFIG_SCHEMA_BASENAME);
}

/** Directory retained for pi-glowup diagnostics, separate from shared settings artifacts. */
export function getGlowupDiagnosticsDirectory(agentDir: string = getAgentDir()): string {
    return join(agentDir, GLOWUP_DIAGNOSTICS_DIRECTORY);
}

export function readGlowupConfig(
    options: {
        readonly cwd?: string;
        readonly reportWarning?: ConfigWarningReporter;
    } = {},
    policy: GlowupConfigLoadPolicy = {},
): GlowupConfig {
    const reportWarning = options.reportWarning;
    const cwd = options.cwd ?? process.cwd();
    migrateLegacySettingsFile(
        join(getAgentDir(), GLOWUP_DIAGNOSTICS_DIRECTORY, LEGACY_CONFIG_BASENAME),
        getGlowupGlobalConfigPath(),
        reportWarning,
    );
    if (policy.includeProjectConfig === true) {
        migrateLegacySettingsFile(
            join(cwd, CONFIG_DIR_NAME, GLOWUP_DIAGNOSTICS_DIRECTORY, LEGACY_CONFIG_BASENAME),
            getGlowupProjectConfigPath(cwd),
            reportWarning,
        );
    }
    const context: PiSettingsContext = {
        cwd,
        isProjectTrusted: () => policy.includeProjectConfig === true,
    };
    const loaded = loadGlowupSettings(context);
    if (reportWarning !== undefined) {
        reportLoadedDiagnostics(loaded.diagnostics, reportWarning);
    }
    return normalizeGlowupConfig(loaded.settings, reportWarning);
}
