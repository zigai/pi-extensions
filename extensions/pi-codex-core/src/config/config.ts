import { randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type StaticDecode, Type } from "typebox";
import { Value } from "typebox/value";

import {
    makeConfigDiagnostic,
    type CodexConfigDiagnostic,
    type CodexCoreConfigParseResult,
} from "./diagnostics.ts";
import { compileSchema } from "../schema-parsing.ts";
import {
    JsonObjectDecoder,
    JsonStringDecoder,
    JsonValueDecoder,
} from "../compaction/responses-input.ts";
import type { JsonObject, JsonValue } from "../compaction/types.ts";
import { settingsSchema } from "../settings-input.ts";

export type CodexPromptMode = "pi" | "codex";
export type CodexPersonality = "friendly" | "pragmatic" | "none";
export type CodexToolScope = "codex" | "all";
export type CodexApplyPatchMode = "off" | "openai" | "all";
export type CodexWebSearchMode = "cached" | "indexed" | "live";
export type CodexVerbosity = "low" | "medium" | "high";
export type CodexCompactionReasoning = string;

/** Config value that means Codex API requests should use the active Codex model. */
export const CODEX_CURRENT_MODEL_SELECTION = "current";
export const CODEX_TOOL_SCOPES: readonly CodexToolScope[] = ["codex", "all"];
export const CODEX_APPLY_PATCH_MODES: readonly CodexApplyPatchMode[] = ["off", "openai", "all"];
export const CODEX_WEB_SEARCH_MODES: readonly CodexWebSearchMode[] = ["cached", "indexed", "live"];
export const CODEX_PROMPT_MODES: readonly CodexPromptMode[] = ["pi", "codex"];
export const CODEX_PERSONALITIES: readonly CodexPersonality[] = ["friendly", "pragmatic", "none"];
export const CODEX_VERBOSITY_LEVELS: readonly CodexVerbosity[] = ["low", "medium", "high"];

export const CODEX_COMPACTION_REASONING_LEVELS: readonly CodexCompactionReasoning[] = [
    "current",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
];

export type CodexCoreConfig = StaticDecode<typeof settingsSchema>;

export const CODEX_CORE_EXTENSION_ID = "pi-codex-core";
export const CODEX_CORE_CONFIG_BASENAME = "config.json";
export const CODEX_CORE_CONFIG_SCHEMA_BASENAME = "config.schema.json";
export const CODEX_CORE_CONFIG_SCHEMA_REFERENCE = `./${CODEX_CORE_CONFIG_SCHEMA_BASENAME}`;
const StringSchema = JsonStringDecoder;
const NodeErrorSchema = compileSchema(Type.Object({ code: Type.Optional(Type.String()) }));
const ConfigReadOptionsSchema = compileSchema(
    Type.Object({
        cwd: Type.Optional(Type.String()),
        agentDir: Type.Optional(Type.String()),
        configPath: Type.Optional(Type.String()),
    }),
);

export const DEFAULT_CODEX_CORE_CONFIG: CodexCoreConfig = Value.Decode(
    settingsSchema,
    Value.Default(settingsSchema, {}),
);

export const DEFAULT_CODEX_CORE_CONFIG_JSON = {
    $schema: CODEX_CORE_CONFIG_SCHEMA_REFERENCE,
    ...DEFAULT_CODEX_CORE_CONFIG,
} as const;

export function getCodexCoreGlobalConfigPath(agentDir: string = getAgentDir()): string {
    return join(agentDir, CODEX_CORE_EXTENSION_ID, CODEX_CORE_CONFIG_BASENAME);
}

export function getCodexCoreProjectConfigPath(cwd: string): string {
    return join(cwd, CONFIG_DIR_NAME, CODEX_CORE_EXTENSION_ID, CODEX_CORE_CONFIG_BASENAME);
}

export function getCodexCoreGlobalConfigSchemaPath(agentDir: string = getAgentDir()): string {
    return join(agentDir, CODEX_CORE_EXTENSION_ID, CODEX_CORE_CONFIG_SCHEMA_BASENAME);
}

export function getCodexCoreConfigPath(agentDir: string = getAgentDir()): string {
    return getCodexCoreGlobalConfigPath(agentDir);
}

export function codexCoreConfigJsonSchema(): JsonObject {
    const content = readFileSync(join(import.meta.dirname, "../../config.schema.json"), "utf8");
    const parsed = JsonObjectDecoder.decode(JSON.parse(content));
    if (parsed === undefined) {
        throw new Error("config.schema.json is not a valid JSON object.");
    }

    return parsed;
}

export function ensureCodexCoreGlobalConfigFiles(agentDir: string = getAgentDir()): void {
    writeJsonFileIfMissing(getCodexCoreGlobalConfigPath(agentDir), DEFAULT_CODEX_CORE_CONFIG_JSON);
    writeJsonFileIfChanged(
        getCodexCoreGlobalConfigSchemaPath(agentDir),
        codexCoreConfigJsonSchema(),
    );
}

function formatTypeboxErrorMessage(instancePath: string): string {
    if (instancePath.includes("thresholdPercent")) return "Expected an integer from 1 to 99.";
    if (instancePath.includes("maxAttempts")) return "Expected an integer from 0 to 10.";
    if (instancePath.includes("baseDelayMs")) return "Expected an integer from 1000 to 300000.";
    if (instancePath.includes("maxDelayMs")) return "Expected an integer from 1000 to 900000.";
    if (instancePath.includes("webSearchMode")) return "Expected one of: cached, indexed, live.";
    if (instancePath.includes("applyPatch")) return "Expected one of: off, openai, all.";
    if (instancePath.includes("personality")) return "Expected one of: friendly, pragmatic, none.";
    if (instancePath.includes("verbosity")) return "Expected one of: low, medium, high.";
    if (instancePath.includes("scope.tools")) return "Expected one of: codex, all.";
    if (instancePath.includes("prompt.mode")) return "Expected one of: pi, codex.";

    return "Expected a valid value.";
}

function deleteJsonPath(target: JsonObject, instancePath: string): void {
    const segments = instancePath.split("/").filter((segment) => segment.length > 0);
    let current = target;

    for (let index = 0; index < segments.length - 1; index += 1) {
        const key = segments[index];
        if (key === undefined) return;

        const next = JsonObjectDecoder.decode(current[key]);
        if (next === undefined) return;

        current = next;
    }

    const lastKey = segments.at(-1);
    if (lastKey !== undefined) {
        Reflect.deleteProperty(current, lastKey);
    }
}

export function parseCodexCoreConfig(inputConfig: JsonValue | undefined): CodexCoreConfig {
    return parseCodexCoreConfigWithDiagnostics(inputConfig).config;
}

export function parseCodexCoreConfigWithDiagnostics(
    inputConfig: JsonValue | undefined,
): CodexCoreConfigParseResult<CodexCoreConfig> {
    const rawObject = JsonObjectDecoder.decode(inputConfig);
    const diagnostics: CodexConfigDiagnostic[] = [];

    if (inputConfig !== undefined && rawObject === undefined) {
        diagnostics.push(makeConfigDiagnostic("$", "invalid", "Expected an object."));
    }

    const cleanedObject =
        JsonObjectDecoder.decode(
            Value.Clean(settingsSchema, rawObject === undefined ? {} : structuredClone(rawObject)),
        ) ?? {};
    const errorPaths = new Set<string>();

    for (const error of Value.Errors(settingsSchema, cleanedObject)) {
        if (error.keyword === "required") continue;

        const path = error.instancePath;
        if (!errorPaths.has(path)) {
            errorPaths.add(path);
            const dotPath = `$${path.replaceAll("/", ".")}`;

            diagnostics.push(
                makeConfigDiagnostic(dotPath, "invalid", formatTypeboxErrorMessage(path)),
            );
        }
    }

    for (const path of errorPaths) {
        deleteJsonPath(cleanedObject, path);
    }

    const withDefaults = Value.Default(settingsSchema, cleanedObject);
    const config = Value.Decode(settingsSchema, withDefaults);

    return { config, diagnostics };
}

export type CodexCoreConfigReadOptions = {
    readonly cwd?: string;
    readonly agentDir?: string;
    readonly configPath?: string;
};

export function readCodexCoreConfig(
    options: string | CodexCoreConfigReadOptions = {},
): CodexCoreConfig {
    return readCodexCoreConfigWithDiagnostics(options).config;
}

export function readCodexCoreConfigWithDiagnostics(
    options: string | CodexCoreConfigReadOptions = {},
): CodexCoreConfigParseResult<CodexCoreConfig> {
    const directConfigPath = StringSchema.decode(options);
    if (directConfigPath !== undefined) {
        return parseReadConfigInput(readConfigInput(directConfigPath));
    }

    const readOptions = ConfigReadOptionsSchema.decode(options) ?? {};
    if (readOptions.configPath !== undefined) {
        return parseReadConfigInput(readConfigInput(readOptions.configPath));
    }

    ensureCodexCoreGlobalConfigFiles(readOptions.agentDir);

    const globalInput = readConfigInput(getCodexCoreGlobalConfigPath(readOptions.agentDir));
    const projectInput =
        readOptions.cwd === undefined
            ? undefined
            : readConfigInput(getCodexCoreProjectConfigPath(readOptions.cwd));
    const parsed = parseCodexCoreConfigWithDiagnostics(
        mergeConfigInputs(globalInput.value ?? {}, projectInput?.value ?? {}),
    );

    return {
        config: parsed.config,
        diagnostics: [
            ...globalInput.diagnostics,
            ...(projectInput?.diagnostics ?? []),
            ...parsed.diagnostics,
        ],
    };
}

export class CodexConfigStartupError extends Error {
    readonly path: string;
    readonly reason: CodexConfigDiagnostic["reason"];

    constructor(diagnostic: CodexConfigDiagnostic) {
        super(
            `Invalid Pi Codex Core config at ${diagnostic.path} (${diagnostic.reason}): ${diagnostic.message}`,
        );
        this.name = "CodexConfigStartupError";
        this.path = diagnostic.path;
        this.reason = diagnostic.reason;
    }
}

/** Read startup configuration and surface safe diagnostics as startup defects. */
export function readCodexCoreStartupConfig(
    options: string | CodexCoreConfigReadOptions = {},
): CodexCoreConfig {
    const result = readCodexCoreConfigWithDiagnostics(options);
    const diagnostic = result.diagnostics[0];

    if (diagnostic) throw new CodexConfigStartupError(diagnostic);

    return result.config;
}

/** Resolves `current` or missing model selections to the active Codex request model. */
export function resolveCodexRequestModel(
    configuredModel: string | undefined,
    currentModel: string | undefined,
): string {
    const configuredText = configuredModel?.trim();
    const configured =
        configuredText === undefined || configuredText.length === 0
            ? CODEX_CURRENT_MODEL_SELECTION
            : configuredText;

    if (configured !== CODEX_CURRENT_MODEL_SELECTION) return configured;

    const activeModel = currentModel?.trim() ?? "";
    if (activeModel.length === 0)
        throw new Error("Codex current model selection requires an active Codex model.");

    return activeModel;
}

/** Formats model selections for user-facing Pi settings/status text. */
export function formatCodexModelSelection(configuredModel: string | undefined): string {
    const configuredText = configuredModel?.trim();
    const configured =
        configuredText === undefined || configuredText.length === 0
            ? CODEX_CURRENT_MODEL_SELECTION
            : configuredText;

    return configured === CODEX_CURRENT_MODEL_SELECTION ? "current model" : configured;
}

export function writeCodexCoreConfig(
    config: CodexCoreConfig,
    configPath: string = getCodexCoreConfigPath(),
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
    const unsafeExistingConfig = existingConfigWriteBlocker(configPath);

    if (unsafeExistingConfig) return { ok: false, error: unsafeExistingConfig };

    try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileAtomically(
            configPath,
            `${JSON.stringify({ $schema: CODEX_CORE_CONFIG_SCHEMA_REFERENCE, ...parseCodexCoreConfig(config) }, null, 2)}\n`,
            existingFileMode(configPath, 0o600),
        );

        return { ok: true };
    } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.warn(`[pi-codex-core] Failed to write ${configPath}: ${message}`);

        return { ok: false, error: message };
    }
}

function existingConfigWriteBlocker(configPath: string): string | undefined {
    if (!existsSync(configPath)) return undefined;

    const unsafeDiagnostic = readConfigInput(configPath).diagnostics.find(
        (diagnostic) =>
            diagnostic.reason === "malformed-json" || diagnostic.reason === "unreadable",
    );
    if (!unsafeDiagnostic) return undefined;

    return `Refusing to overwrite ${unsafeDiagnostic.reason === "malformed-json" ? "malformed" : "unreadable"} config: ${configPath}`;
}

type ScaffoldedJson =
    | typeof DEFAULT_CODEX_CORE_CONFIG_JSON
    | ReturnType<typeof codexCoreConfigJsonSchema>;

function serializeJson(value: ScaffoldedJson): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonFileIfMissing(filePath: string, value: ScaffoldedJson): void {
    if (existsSync(filePath)) return;

    try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, serializeJson(value), {
            encoding: "utf8",
            flag: "wx",
        });
    } catch (cause: unknown) {
        if (hasNodeErrorCode(cause, "EEXIST")) return;

        const message = cause instanceof Error ? cause.message : String(cause);
        console.warn(`[pi-codex-core] Failed to create ${filePath}: ${message}`);
    }
}

function writeJsonFileIfChanged(filePath: string, value: ScaffoldedJson): void {
    const nextContent = serializeJson(value);

    try {
        if (existsSync(filePath) && readFileSync(filePath, "utf8") === nextContent) return;

        mkdirSync(dirname(filePath), { recursive: true });
        writeFileAtomically(filePath, nextContent, existingFileMode(filePath, 0o644));
    } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.warn(`[pi-codex-core] Failed to write ${filePath}: ${message}`);
    }
}

type ConfigInputReadResult = {
    readonly value: JsonValue | undefined;
    readonly diagnostics: readonly CodexConfigDiagnostic[];
};

function readConfigInput(configPath: string): ConfigInputReadResult {
    if (!existsSync(configPath)) return { value: undefined, diagnostics: [] };

    try {
        const rawConfig: unknown = JSON.parse(readFileSync(configPath, "utf8"));

        return { value: JsonValueDecoder.decode(rawConfig), diagnostics: [] };
    } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const reason = cause instanceof SyntaxError ? "malformed-json" : "unreadable";

        return {
            value: undefined,
            diagnostics: [makeConfigDiagnostic(configPath, reason, message)],
        };
    }
}

function parseReadConfigInput(
    input: ConfigInputReadResult,
): CodexCoreConfigParseResult<CodexCoreConfig> {
    const parsed = parseCodexCoreConfigWithDiagnostics(input.value);

    return {
        config: parsed.config,
        diagnostics: [...input.diagnostics, ...parsed.diagnostics],
    };
}

function writeFileAtomically(filePath: string, content: string, mode: number): void {
    const directory = dirname(filePath);
    const temporaryPath = join(
        directory,
        `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    try {
        writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode });
        renameSync(temporaryPath, filePath);
    } finally {
        if (existsSync(temporaryPath)) {
            try {
                unlinkSync(temporaryPath);
            } catch {
                // Preserve the original write failure when temporary-file cleanup also fails.
            }
        }
    }
}

function existingFileMode(filePath: string, fallback: number): number {
    try {
        return statSync(filePath).mode & 0o777;
    } catch {
        return fallback;
    }
}

function mergeConfigInputs(
    base: JsonValue | undefined,
    override: JsonValue | undefined,
): JsonValue | undefined {
    const baseObject = JsonObjectDecoder.decode(base);
    if (baseObject === undefined) return override ?? base;

    const overrideObject = JsonObjectDecoder.decode(override);
    if (overrideObject === undefined) return base;

    const merged: Record<string, JsonValue | undefined> = {};
    for (const [key, value] of Object.entries(baseObject)) merged[key] = value;

    for (const [key, value] of Object.entries(overrideObject)) {
        merged[key] = mergeConfigInputs(merged[key], value);
    }

    return merged;
}

function hasNodeErrorCode(cause: unknown, code: string): boolean {
    return NodeErrorSchema.decode(cause)?.code === code;
}
