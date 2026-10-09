import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
    CONFIG_DIR_NAME,
    getAgentDir,
    type WidgetPlacement,
} from "@earendil-works/pi-coding-agent";
import type { TypedCommandFormTrigger, TypedCommandUxOptions } from "../types.js";
import {
    DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON,
    PiTypedCommandsConfigSchema,
    piTypedCommandsConfigJsonSchema,
    type PiTypedCommandsConfig,
} from "./config-schema.js";
import { DEFAULT_HELPER_PLACEMENT } from "./helper.js";
import {
    DEFAULT_PI_TYPED_COMMANDS_APPEARANCE,
    resolvePiTypedCommandsAppearance,
    type ResolvedPiTypedCommandsAppearance,
} from "./presentation-config.js";
import Schema from "../typebox-schema.js";

const EXTENSION_ID = "pi-typed-args";
const CONFIG_BASENAME = "config.json";
const CONFIG_SCHEMA_BASENAME = "config.schema.json";

/** Stable file roles used in safe configuration diagnostics. */
export type PiTypedCommandsConfigFileRole = "global-config" | "project-config" | "global-schema";

/** Safe, structured configuration diagnostic that never includes file contents or raw causes. */
export type PiTypedCommandsConfigDiagnostic = {
    readonly code:
        | "config.json.malformed"
        | "config.read.failed"
        | "config.schema.invalid"
        | "config.write.failed";

    readonly operation: "create" | "parse" | "read" | "refresh" | "validate" | "write";
    readonly fileRole: PiTypedCommandsConfigFileRole;
    readonly errorCode?: string;
    readonly message: string;
};

/** Outcome of loading one user-owned configuration source. */
export type PiTypedCommandsConfigSourceOutcome =
    | {
          readonly status: "absent" | "skipped-untrusted";
          readonly fileRole: "global-config" | "project-config";
      }
    | {
          readonly status: "loaded";
          readonly fileRole: "global-config" | "project-config";
          readonly config: PiTypedCommandsConfig;
      }
    | {
          readonly status: "malformed" | "read-failed" | "schema-invalid";
          readonly fileRole: "global-config" | "project-config";
          readonly diagnostic: PiTypedCommandsConfigDiagnostic;
      };

/** Outcome of creating or refreshing one extension-owned global file. */
export type PiTypedCommandsConfigWriteOutcome =
    | {
          readonly status: "created" | "refreshed" | "unchanged";
          readonly fileRole: "global-config" | "global-schema";
      }
    | {
          readonly status: "read-failed" | "write-failed";
          readonly fileRole: "global-config" | "global-schema";
          readonly diagnostic: PiTypedCommandsConfigDiagnostic;
      };

/** Typed configuration snapshot resolved once at the Pi composition seam. */
export type ResolvedPiTypedCommandsConfigSnapshot = {
    readonly settings: {
        readonly helperPlacement: WidgetPlacement;
        readonly appearance: ResolvedPiTypedCommandsAppearance;
    };

    readonly global: PiTypedCommandsConfigSourceOutcome;
    readonly project: PiTypedCommandsConfigSourceOutcome;
    readonly fileOutcomes: readonly PiTypedCommandsConfigWriteOutcome[];
    readonly diagnostics: readonly PiTypedCommandsConfigDiagnostic[];
};

/** Narrow session boundary values needed to resolve project configuration. */
export type PiTypedCommandsSettingsContext = {
    readonly cwd: string;
    readonly projectTrusted: boolean;
};

export function getPiTypedCommandsGlobalConfigPath(agentDir: string = getAgentDir()): string {
    return join(agentDir, EXTENSION_ID, CONFIG_BASENAME);
}

export function getPiTypedCommandsGlobalConfigSchemaPath(agentDir: string = getAgentDir()): string {
    return join(agentDir, EXTENSION_ID, CONFIG_SCHEMA_BASENAME);
}

function getProjectConfigPath(cwd: string): string {
    return join(cwd, CONFIG_DIR_NAME, EXTENSION_ID, CONFIG_BASENAME);
}

function hasErrorCode(cause: unknown): cause is { readonly code: string } {
    return (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        typeof cause.code === "string"
    );
}

function errorCode(cause: unknown): string | undefined {
    if (!hasErrorCode(cause)) {
        return undefined;
    }

    return cause.code;
}

function diagnosticMessage(
    operation: PiTypedCommandsConfigDiagnostic["operation"],
    fileRole: PiTypedCommandsConfigFileRole,
    code?: string,
): string {
    let suffix = "";
    if (code !== undefined) {
        suffix = ` (${code})`;
    }

    return `pi-typed-args configuration ${operation} failed for ${fileRole}${suffix}`;
}

function configDiagnostic(
    input: Omit<PiTypedCommandsConfigDiagnostic, "message">,
): PiTypedCommandsConfigDiagnostic {
    return {
        ...input,
        message: diagnosticMessage(input.operation, input.fileRole, input.errorCode),
    };
}

function failureDiagnostic(
    code: PiTypedCommandsConfigDiagnostic["code"],
    operation: PiTypedCommandsConfigDiagnostic["operation"],
    fileRole: PiTypedCommandsConfigFileRole,
    causeCode?: string,
): PiTypedCommandsConfigDiagnostic {
    if (causeCode === undefined) {
        return configDiagnostic({ code, operation, fileRole });
    }

    return configDiagnostic({ code, operation, fileRole, errorCode: causeCode });
}

function readConfigFile(
    configPath: string,
    fileRole: "global-config" | "project-config",
): PiTypedCommandsConfigSourceOutcome {
    let content: string;
    try {
        content = readFileSync(configPath, "utf8");
    } catch (cause: unknown) {
        const code = errorCode(cause);
        if (code === "ENOENT") {
            return { status: "absent", fileRole };
        }

        return {
            status: "read-failed",
            fileRole,
            diagnostic: failureDiagnostic("config.read.failed", "read", fileRole, code),
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        return {
            status: "malformed",
            fileRole,
            diagnostic: configDiagnostic({
                code: "config.json.malformed",
                operation: "parse",
                fileRole,
            }),
        };
    }

    if (!Schema.Check(PiTypedCommandsConfigSchema, parsed)) {
        return {
            status: "schema-invalid",
            fileRole,
            diagnostic: configDiagnostic({
                code: "config.schema.invalid",
                operation: "validate",
                fileRole,
            }),
        };
    }

    return {
        status: "loaded",
        fileRole,
        config: Schema.Parse(PiTypedCommandsConfigSchema, parsed),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeJson<const TValue>(value: TValue): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonFileIfMissing<const TValue>(
    filePath: string,
    value: TValue,
): PiTypedCommandsConfigWriteOutcome {
    if (existsSync(filePath)) return { status: "unchanged", fileRole: "global-config" };

    try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, serializeJson(value), {
            encoding: "utf8",
            flag: "wx",
        });
        return { status: "created", fileRole: "global-config" };
    } catch (cause: unknown) {
        const code = errorCode(cause);
        if (code === "EEXIST") {
            return { status: "unchanged", fileRole: "global-config" };
        }

        return {
            status: "write-failed",
            fileRole: "global-config",
            diagnostic: failureDiagnostic("config.write.failed", "create", "global-config", code),
        };
    }
}

function writeJsonFileIfChanged<const TValue>(
    filePath: string,
    value: TValue,
): PiTypedCommandsConfigWriteOutcome {
    const nextContent = serializeJson(value);
    const existed = existsSync(filePath);
    if (existed) {
        try {
            if (readFileSync(filePath, "utf8") === nextContent) {
                return { status: "unchanged", fileRole: "global-schema" };
            }
        } catch (cause: unknown) {
            const code = errorCode(cause);
            return {
                status: "read-failed",
                fileRole: "global-schema",
                diagnostic: failureDiagnostic("config.read.failed", "read", "global-schema", code),
            };
        }
    }

    try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, nextContent, "utf8");

        if (existed) {
            return { status: "refreshed", fileRole: "global-schema" };
        }

        return { status: "created", fileRole: "global-schema" };
    } catch (cause: unknown) {
        const code = errorCode(cause);
        return {
            status: "write-failed",
            fileRole: "global-schema",
            diagnostic: failureDiagnostic("config.write.failed", "write", "global-schema", code),
        };
    }
}

export function ensurePiTypedCommandsGlobalConfigFiles(
    agentDir: string = getAgentDir(),
): readonly PiTypedCommandsConfigWriteOutcome[] {
    return [
        writeJsonFileIfMissing(
            getPiTypedCommandsGlobalConfigPath(agentDir),
            DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON,
        ),
        writeJsonFileIfChanged(
            getPiTypedCommandsGlobalConfigSchemaPath(agentDir),
            piTypedCommandsConfigJsonSchema(),
        ),
    ];
}

function projectConfigOutcome(
    context: PiTypedCommandsSettingsContext,
): PiTypedCommandsConfigSourceOutcome {
    if (!context.projectTrusted) {
        return { status: "skipped-untrusted", fileRole: "project-config" };
    }

    return readConfigFile(getProjectConfigPath(context.cwd), "project-config");
}

function mergeConfig(base: unknown, override: unknown): unknown {
    if (!isRecord(base)) return override ?? base;
    if (!isRecord(override)) return base;

    const entries = new Map(Object.entries(base));
    for (const [key, value] of Object.entries(override)) {
        entries.set(key, mergeConfig(entries.get(key), value));
    }

    return Object.fromEntries(entries);
}

function loadedConfig(outcome: PiTypedCommandsConfigSourceOutcome): PiTypedCommandsConfig {
    if (outcome.status === "loaded") {
        return outcome.config;
    }

    return {};
}

function hasValidLayoutRanges(config: PiTypedCommandsConfig): boolean {
    const layout = config.appearance?.form?.layout;
    const defaults = DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON.appearance.form.layout;
    const minNameWidth = layout?.minNameWidth ?? defaults.minNameWidth;
    const maxNameWidth = layout?.maxNameWidth ?? defaults.maxNameWidth;
    const minValueWidth = layout?.minValueWidth ?? defaults.minValueWidth;
    const maxValueWidth = layout?.maxValueWidth ?? defaults.maxValueWidth;
    return maxNameWidth >= minNameWidth && maxValueWidth >= minValueWidth;
}

function schemaInvalidOutcome(
    fileRole: "global-config" | "project-config",
): PiTypedCommandsConfigSourceOutcome {
    return {
        status: "schema-invalid",
        fileRole,
        diagnostic: configDiagnostic({
            code: "config.schema.invalid",
            operation: "validate",
            fileRole,
        }),
    };
}

function parseMergedConfig(
    global: PiTypedCommandsConfigSourceOutcome,
    project: PiTypedCommandsConfigSourceOutcome,
): PiTypedCommandsConfig {
    return Schema.Parse(
        PiTypedCommandsConfigSchema,
        mergeConfig(loadedConfig(global), loadedConfig(project)),
    );
}

function diagnosticFromSource(
    outcome: PiTypedCommandsConfigSourceOutcome,
): PiTypedCommandsConfigDiagnostic | undefined {
    if (
        outcome.status === "malformed" ||
        outcome.status === "read-failed" ||
        outcome.status === "schema-invalid"
    ) {
        return outcome.diagnostic;
    }

    return undefined;
}

function diagnosticFromWrite(
    outcome: PiTypedCommandsConfigWriteOutcome,
): PiTypedCommandsConfigDiagnostic | undefined {
    if (outcome.status === "read-failed" || outcome.status === "write-failed") {
        return outcome.diagnostic;
    }

    return undefined;
}

/** Load, classify, merge, and resolve global/project configuration once. */
export function resolvePiTypedCommandsConfigSnapshot(
    context: PiTypedCommandsSettingsContext,
): ResolvedPiTypedCommandsConfigSnapshot {
    const fileOutcomes = ensurePiTypedCommandsGlobalConfigFiles();
    let global = readConfigFile(getPiTypedCommandsGlobalConfigPath(), "global-config");
    let project = projectConfigOutcome(context);
    const absentProject: PiTypedCommandsConfigSourceOutcome = {
        status: "absent",
        fileRole: "project-config",
    };
    if (
        global.status === "loaded" &&
        !hasValidLayoutRanges(parseMergedConfig(global, absentProject))
    ) {
        global = schemaInvalidOutcome("global-config");
    }

    let config = parseMergedConfig(global, project);
    if (!hasValidLayoutRanges(config) && project.status === "loaded") {
        project = schemaInvalidOutcome("project-config");
        config = parseMergedConfig(global, project);
    }

    const diagnostics: PiTypedCommandsConfigDiagnostic[] = [];
    for (const outcome of fileOutcomes) {
        const diagnostic = diagnosticFromWrite(outcome);
        if (diagnostic !== undefined) {
            diagnostics.push(diagnostic);
        }
    }

    for (const outcome of [global, project]) {
        const diagnostic = diagnosticFromSource(outcome);
        if (diagnostic !== undefined) {
            diagnostics.push(diagnostic);
        }
    }

    return {
        settings: {
            helperPlacement: config.helperPlacement ?? DEFAULT_HELPER_PLACEMENT,
            appearance: resolvePiTypedCommandsAppearance(config.appearance),
        },
        global,
        project,
        fileOutcomes,
        diagnostics,
    };
}

/** Resolved UX settings for typed-command Pi integrations. */
export type ResolvedTypedCommandUxOptions = {
    helperPlacement: WidgetPlacement;
    formTrigger: TypedCommandFormTrigger;
    appearance: ResolvedPiTypedCommandsAppearance;
    diagnostics: readonly PiTypedCommandsConfigDiagnostic[];
};

/** Resolve typed-command UX options from explicit options and one session config snapshot. */
export function resolveTypedCommandUxOptions(
    options: TypedCommandUxOptions = {},
    snapshot?: ResolvedPiTypedCommandsConfigSnapshot,
): ResolvedTypedCommandUxOptions {
    let settingsHelperPlacement: WidgetPlacement | undefined;
    let appearance = DEFAULT_PI_TYPED_COMMANDS_APPEARANCE;
    let diagnostics: readonly PiTypedCommandsConfigDiagnostic[] = [];
    if (snapshot !== undefined) {
        settingsHelperPlacement = snapshot.settings.helperPlacement;
        appearance = snapshot.settings.appearance;
        diagnostics = snapshot.diagnostics;
    }

    return {
        helperPlacement:
            options.helperPlacement ?? settingsHelperPlacement ?? DEFAULT_HELPER_PLACEMENT,
        formTrigger: options.formTrigger ?? "tab",
        appearance,
        diagnostics,
    };
}
