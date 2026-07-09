import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
    CONFIG_DIR_NAME,
    getAgentDir,
    type ExtensionContext,
    type WidgetPlacement,
} from "@earendil-works/pi-coding-agent";
import type { TypedCommandUxOptions } from "../types.js";
import {
    DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON,
    piTypedCommandsConfigJsonSchema,
} from "./config-schema.js";
import { DEFAULT_HELPER_PLACEMENT } from "./helper.js";
import {
    DEFAULT_PI_TYPED_COMMANDS_APPEARANCE,
    parsePiTypedCommandsAppearance,
    parsePiTypedCommandsSettings,
    type ResolvedPiTypedCommandsAppearance,
} from "./presentation-config.js";

const EXTENSION_ID = "pi-typed-args";
const CONFIG_BASENAME = "config.json";
const CONFIG_SCHEMA_BASENAME = "config.schema.json";

type TypedCommandsConfigSnapshot = {
    readonly projectConfig: unknown;
    readonly globalConfig: unknown;
};

function helperPlacementFromConfig(config: unknown): WidgetPlacement | undefined {
    const typedCommands = parsePiTypedCommandsSettings(config);
    return typedCommands?.helperPlacement;
}

function projectTrusted(ctx: ExtensionContext): boolean {
    if (typeof ctx.isProjectTrusted === "function") {
        return ctx.isProjectTrusted();
    }
    return true;
}

export function getPiTypedCommandsGlobalConfigPath(agentDir: string = getAgentDir()): string {
    return join(agentDir, EXTENSION_ID, CONFIG_BASENAME);
}

export function getPiTypedCommandsGlobalConfigSchemaPath(agentDir: string = getAgentDir()): string {
    return join(agentDir, EXTENSION_ID, CONFIG_SCHEMA_BASENAME);
}

function getProjectConfigPath(cwd: string): string {
    return join(cwd, CONFIG_DIR_NAME, EXTENSION_ID, CONFIG_BASENAME);
}

function readConfigFile(configPath: string): unknown {
    try {
        const rawConfig: unknown = JSON.parse(readFileSync(configPath, "utf8"));
        return rawConfig;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNodeErrorCode(cause: unknown, code: string): boolean {
    return isRecord(cause) && cause.code === code;
}

function serializeJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonFileIfMissing(filePath: string, value: unknown): void {
    if (existsSync(filePath)) return;

    try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, serializeJson(value), {
            encoding: "utf8",
            flag: "wx",
        });
    } catch (cause: unknown) {
        if (hasNodeErrorCode(cause, "EEXIST")) return;
        let message = String(cause);
        if (cause instanceof Error) {
            message = cause.message;
        }
        console.warn(`[pi-typed-args] Failed to create ${filePath}: ${message}`);
    }
}

function writeJsonFileIfChanged(filePath: string, value: unknown): void {
    const nextContent = serializeJson(value);

    try {
        if (existsSync(filePath) && readFileSync(filePath, "utf8") === nextContent) return;
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, nextContent, "utf8");
    } catch (cause: unknown) {
        let message = String(cause);
        if (cause instanceof Error) {
            message = cause.message;
        }
        console.warn(`[pi-typed-args] Failed to write ${filePath}: ${message}`);
    }
}

export function ensurePiTypedCommandsGlobalConfigFiles(agentDir: string = getAgentDir()): void {
    writeJsonFileIfMissing(
        getPiTypedCommandsGlobalConfigPath(agentDir),
        DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON,
    );
    writeJsonFileIfChanged(
        getPiTypedCommandsGlobalConfigSchemaPath(agentDir),
        piTypedCommandsConfigJsonSchema(),
    );
}

function configSnapshot(ctx: ExtensionContext): TypedCommandsConfigSnapshot {
    ensurePiTypedCommandsGlobalConfigFiles();
    let projectConfig: unknown;
    if (projectTrusted(ctx) && typeof ctx.cwd === "string") {
        projectConfig = readConfigFile(getProjectConfigPath(ctx.cwd));
    }
    return {
        projectConfig,
        globalConfig: readConfigFile(getPiTypedCommandsGlobalConfigPath()),
    };
}

function mergeConfig(base: unknown, override: unknown): unknown {
    if (!isRecord(base)) return override ?? base;
    if (!isRecord(override)) return base;

    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
        merged[key] = mergeConfig(merged[key], value);
    }
    return merged;
}

function effectiveConfig(snapshot: TypedCommandsConfigSnapshot | undefined): unknown {
    if (snapshot === undefined) {
        return undefined;
    }
    return mergeConfig(snapshot.globalConfig ?? {}, snapshot.projectConfig ?? {});
}

function helperPlacementFromSnapshot(
    snapshot: TypedCommandsConfigSnapshot | undefined,
): WidgetPlacement | undefined {
    return helperPlacementFromConfig(effectiveConfig(snapshot));
}

function appearanceFromSnapshot(
    snapshot: TypedCommandsConfigSnapshot | undefined,
): ResolvedPiTypedCommandsAppearance {
    if (snapshot === undefined) {
        return DEFAULT_PI_TYPED_COMMANDS_APPEARANCE;
    }
    return parsePiTypedCommandsAppearance(
        parsePiTypedCommandsSettings(effectiveConfig(snapshot))?.appearance,
    );
}

/** Resolved UX settings for typed-command Pi integrations. */
export type ResolvedTypedCommandUxOptions = {
    helperPlacement: WidgetPlacement;
    appearance: ResolvedPiTypedCommandsAppearance;
};

/** Resolve typed-command appearance from extension-owned config. */
export function resolveTypedCommandAppearance(
    ctx?: ExtensionContext,
): ResolvedPiTypedCommandsAppearance {
    if (ctx === undefined) {
        return DEFAULT_PI_TYPED_COMMANDS_APPEARANCE;
    }

    return appearanceFromSnapshot(configSnapshot(ctx));
}

/** Resolve typed-command UX options from explicit options and extension-owned config. */
export function resolveTypedCommandUxOptions(
    options: TypedCommandUxOptions = {},
    ctx?: ExtensionContext,
): ResolvedTypedCommandUxOptions {
    let settingsHelperPlacement: WidgetPlacement | undefined;
    let appearance = DEFAULT_PI_TYPED_COMMANDS_APPEARANCE;
    if (ctx !== undefined) {
        const snapshot = configSnapshot(ctx);
        settingsHelperPlacement = helperPlacementFromSnapshot(snapshot);
        appearance = appearanceFromSnapshot(snapshot);
    }
    return {
        helperPlacement:
            options.helperPlacement ?? settingsHelperPlacement ?? DEFAULT_HELPER_PLACEMENT,
        appearance,
    };
}
