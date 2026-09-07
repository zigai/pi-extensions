import { normalizeGlowupConfig, type GlowupConfig } from "./normalize.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import { extensionSettingsDefinition, loadGlowupSettings, settingsSchema } from "../settings.ts";
import { jsonObjectParser, jsonValueParser, type JsonValue } from "../json-value.ts";

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

function parseDefaultSettingsInput(): JsonValue {
    const parsed = jsonValueParser.parse(extensionSettingsDefinition.defaultSettings);
    if (parsed === undefined) {
        throw new Error("Generated default settings must be valid JSON");
    }

    return parsed;
}

const defaultSettingsInput = parseDefaultSettingsInput();

const nodeErrorSchema = Type.Object(
    { code: Type.Optional(Type.String()) },
    { additionalProperties: true },
);

type NodeError = Static<typeof nodeErrorSchema>;

const nodeErrorParser = {
    parse(value: unknown): NodeError | undefined {
        try {
            return Value.Parse(nodeErrorSchema, value);
        } catch {
            return undefined;
        }
    },
};

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

function mergeConfigInputs(base: JsonValue, override: JsonValue): JsonValue {
    const baseRecord = jsonObjectParser.parse(base);
    const overrideRecord = jsonObjectParser.parse(override);
    if (baseRecord === undefined || overrideRecord === undefined) return override;

    const merged = { ...baseRecord };
    for (const [key, value] of Object.entries(overrideRecord)) {
        merged[key] = mergeConfigInputs(merged[key] ?? null, value);
    }

    return merged;
}

function withoutSchemaMetadata(input: JsonValue): JsonValue {
    const record = jsonObjectParser.parse(input);
    if (record === undefined) return input;
    const { $schema: _schema, ...settings } = record;
    return settings;
}

function isNodeErrorWithCode(cause: unknown, code: string): boolean {
    return nodeErrorParser.parse(cause)?.code === code;
}

function serializeJson(value: JsonValue): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function migrateLegacySettingsFile(
    legacyPath: string,
    settingsPath: string,
    reportWarning: ConfigWarningReporter | undefined,
): void {
    if (existsSync(settingsPath) || !existsSync(legacyPath)) return;

    let raw: JsonValue | undefined;
    try {
        raw = jsonValueParser.parse(JSON.parse(readFileSync(legacyPath, "utf8")));
    } catch {
        reportWarning?.(`[pi-glowup] Legacy settings at ${legacyPath} were not migrated.`);
        return;
    }

    if (raw === undefined) {
        reportWarning?.(`[pi-glowup] Legacy settings at ${legacyPath} were not migrated.`);
        return;
    }

    const candidate = mergeConfigInputs(defaultSettingsInput, withoutSchemaMetadata(raw));
    const rawRecord = jsonObjectParser.parse(raw);
    if (!Value.Check(settingsSchema, candidate) || rawRecord === undefined) {
        reportWarning?.(`[pi-glowup] Legacy settings at ${legacyPath} were not migrated.`);
        return;
    }

    const { $schema: _schema, ...settings } = rawRecord;
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

function configSchemaErrorSummary(input: JsonValue): string {
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
    const parsedInput = jsonValueParser.parse(input) ?? null;
    const candidate = mergeConfigInputs(defaultSettingsInput, withoutSchemaMetadata(parsedInput));
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
