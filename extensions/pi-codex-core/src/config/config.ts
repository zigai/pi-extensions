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
import { Type } from "typebox";

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

export type CodexCoreConfig = {
    readonly scope: {
        readonly tools: CodexToolScope;
    };
    readonly tools: {
        readonly webSearch: boolean;
        readonly webSearchMode: CodexWebSearchMode;
        readonly imageGeneration: boolean;
        readonly viewImage: boolean;
        readonly viewImageDescriptions: boolean;
        readonly applyPatch: CodexApplyPatchMode;
    };
    readonly prompt: {
        readonly mode: CodexPromptMode;
        readonly personality: CodexPersonality;
    };
    readonly compaction: {
        readonly enabled: boolean;
        readonly auto: boolean;
        readonly thresholdPercent: number;
    };
    readonly recovery: {
        readonly enabled: boolean;
        readonly batchFollowUps: boolean;
        readonly maxAttempts: number;
        readonly baseDelayMs: number;
        readonly maxDelayMs: number;
    };
    readonly openai: {
        readonly webSearchModel: string;
        readonly imageModel: string;
        readonly imageDescriptionModel: string;
        readonly compactionModel: string;
        readonly compactionReasoning: CodexCompactionReasoning;
        readonly verbosity: CodexVerbosity;
        readonly fast: boolean;
        readonly showReasoningTraces: boolean;
    };
};

export const CODEX_CORE_EXTENSION_ID = "pi-codex-core";
export const CODEX_CORE_CONFIG_BASENAME = "config.json";
export const CODEX_CORE_CONFIG_SCHEMA_BASENAME = "config.schema.json";
export const CODEX_CORE_CONFIG_SCHEMA_REFERENCE = `./${CODEX_CORE_CONFIG_SCHEMA_BASENAME}`;

const JSON_SCHEMA_DRAFT_URI = "https://json-schema.org/draft/2020-12/schema";
const CODEX_CORE_CONFIG_SCHEMA_ID = "https://github.com/zigai/pi-codex-core/config.schema.json";

const CodexToolScopeSchema = Type.Union([Type.Literal("codex"), Type.Literal("all")]);
const CodexApplyPatchModeSchema = Type.Union([
    Type.Literal("off"),
    Type.Literal("openai"),
    Type.Literal("all"),
]);
const CodexWebSearchModeSchema = Type.Union(
    [Type.Literal("cached"), Type.Literal("indexed"), Type.Literal("live")],
    { default: "live" },
);
const CodexPromptModeSchema = Type.Union([Type.Literal("pi"), Type.Literal("codex")]);
const CodexPersonalitySchema = Type.Union([
    Type.Literal("friendly"),
    Type.Literal("pragmatic"),
    Type.Literal("none"),
]);
const CodexVerbositySchema = Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
]);
const CodexCompactionReasoningSchema = Type.String({
    minLength: 1,
    pattern: "\\S",
    default: "medium",
});
const CodexCoreConfigJsonSchema = Type.Object(
    {
        scope: Type.Object(
            { tools: CodexToolScopeSchema },
            { additionalProperties: false, default: { tools: "codex" } },
        ),
        tools: Type.Object(
            {
                webSearch: Type.Boolean({ default: true }),
                webSearchMode: CodexWebSearchModeSchema,
                imageGeneration: Type.Boolean({ default: true }),
                viewImage: Type.Boolean({ default: true }),
                viewImageDescriptions: Type.Boolean({ default: false }),
                applyPatch: CodexApplyPatchModeSchema,
            },
            { additionalProperties: false },
        ),
        prompt: Type.Object(
            { mode: CodexPromptModeSchema, personality: CodexPersonalitySchema },
            { additionalProperties: false, default: { mode: "codex", personality: "pragmatic" } },
        ),
        compaction: Type.Object(
            {
                enabled: Type.Boolean({ default: true }),
                auto: Type.Boolean({ default: true }),
                thresholdPercent: Type.Integer({ minimum: 1, maximum: 99, default: 80 }),
            },
            { additionalProperties: false },
        ),
        recovery: Type.Object(
            {
                enabled: Type.Boolean({ default: true }),
                batchFollowUps: Type.Boolean({ default: false }),
                maxAttempts: Type.Integer({ minimum: 0, maximum: 10, default: 3 }),
                baseDelayMs: Type.Integer({ minimum: 1000, maximum: 300000, default: 30000 }),
                maxDelayMs: Type.Integer({ minimum: 1000, maximum: 900000, default: 120000 }),
            },
            { additionalProperties: false },
        ),
        openai: Type.Object(
            {
                webSearchModel: Type.String({ default: CODEX_CURRENT_MODEL_SELECTION }),
                imageModel: Type.String({ default: "gpt-image-2" }),
                imageDescriptionModel: Type.String({ default: CODEX_CURRENT_MODEL_SELECTION }),
                compactionModel: Type.String({ default: CODEX_CURRENT_MODEL_SELECTION }),
                compactionReasoning: CodexCompactionReasoningSchema,
                verbosity: CodexVerbositySchema,
                fast: Type.Boolean({ default: false }),
                showReasoningTraces: Type.Boolean({ default: true }),
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: true },
);

const BooleanSchema = compileSchema(Type.Boolean());
const NumberSchema = compileSchema(Type.Number());
const StringSchema = JsonStringDecoder;
const NodeErrorSchema = compileSchema(Type.Object({ code: Type.Optional(Type.String()) }));
const ConfigReadOptionsSchema = compileSchema(
    Type.Object({
        cwd: Type.Optional(Type.String()),
        agentDir: Type.Optional(Type.String()),
        configPath: Type.Optional(Type.String()),
    }),
);

export const DEFAULT_CODEX_CORE_CONFIG: CodexCoreConfig = {
    scope: { tools: "codex" },
    tools: {
        webSearch: true,
        webSearchMode: "live",
        imageGeneration: true,
        viewImage: true,
        viewImageDescriptions: false,
        applyPatch: "off",
    },
    prompt: { mode: "codex", personality: "pragmatic" },
    compaction: { enabled: true, auto: true, thresholdPercent: 80 },
    recovery: {
        enabled: true,
        batchFollowUps: false,
        maxAttempts: 3,
        baseDelayMs: 30_000,
        maxDelayMs: 120_000,
    },
    openai: {
        webSearchModel: CODEX_CURRENT_MODEL_SELECTION,
        imageModel: "gpt-image-2",
        imageDescriptionModel: CODEX_CURRENT_MODEL_SELECTION,
        compactionModel: CODEX_CURRENT_MODEL_SELECTION,
        compactionReasoning: "medium",
        verbosity: "low",
        fast: false,
        showReasoningTraces: true,
    },
};

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

export function codexCoreConfigJsonSchema() {
    return {
        $schema: JSON_SCHEMA_DRAFT_URI,
        $id: CODEX_CORE_CONFIG_SCHEMA_ID,
        ...structuredClone(CodexCoreConfigJsonSchema),
    };
}

export function ensureCodexCoreGlobalConfigFiles(agentDir: string = getAgentDir()): void {
    writeJsonFileIfMissing(getCodexCoreGlobalConfigPath(agentDir), DEFAULT_CODEX_CORE_CONFIG_JSON);
    writeJsonFileIfChanged(
        getCodexCoreGlobalConfigSchemaPath(agentDir),
        codexCoreConfigJsonSchema(),
    );
}

export function parseCodexCoreConfig(value: unknown): CodexCoreConfig {
    return parseCodexCoreConfigWithDiagnostics(value).config;
}

export function parseCodexCoreConfigWithDiagnostics(
    value: unknown,
): CodexCoreConfigParseResult<CodexCoreConfig> {
    const decodedValue = JsonValueDecoder.decode(value);
    const diagnostics: CodexConfigDiagnostic[] = [];
    const root = parseRecord(decodedValue, "$", diagnostics);

    const scope = parseRecord(root.scope, "$.scope", diagnostics);
    const tools = parseRecord(root.tools, "$.tools", diagnostics);
    const prompt = parseRecord(root.prompt, "$.prompt", diagnostics);
    const compaction = parseRecord(root.compaction, "$.compaction", diagnostics);
    const recovery = parseRecord(root.recovery, "$.recovery", diagnostics);
    const openai = parseRecord(root.openai, "$.openai", diagnostics);

    return {
        config: {
            scope: {
                tools: parseStringEnum(
                    scope.tools,
                    CODEX_TOOL_SCOPES,
                    DEFAULT_CODEX_CORE_CONFIG.scope.tools,
                    "$.scope.tools",
                    diagnostics,
                ),
            },
            tools: {
                webSearch: parseBoolean(
                    tools.webSearch,
                    DEFAULT_CODEX_CORE_CONFIG.tools.webSearch,
                    "$.tools.webSearch",
                    diagnostics,
                ),
                webSearchMode: parseStringEnum(
                    tools.webSearchMode,
                    CODEX_WEB_SEARCH_MODES,
                    DEFAULT_CODEX_CORE_CONFIG.tools.webSearchMode,
                    "$.tools.webSearchMode",
                    diagnostics,
                ),
                imageGeneration: parseBoolean(
                    tools.imageGeneration,
                    DEFAULT_CODEX_CORE_CONFIG.tools.imageGeneration,
                    "$.tools.imageGeneration",
                    diagnostics,
                ),
                viewImage: parseBoolean(
                    tools.viewImage,
                    DEFAULT_CODEX_CORE_CONFIG.tools.viewImage,
                    "$.tools.viewImage",
                    diagnostics,
                ),
                viewImageDescriptions: parseBoolean(
                    tools.viewImageDescriptions,
                    DEFAULT_CODEX_CORE_CONFIG.tools.viewImageDescriptions,
                    "$.tools.viewImageDescriptions",
                    diagnostics,
                ),
                applyPatch: parseStringEnum(
                    tools.applyPatch,
                    CODEX_APPLY_PATCH_MODES,
                    DEFAULT_CODEX_CORE_CONFIG.tools.applyPatch,
                    "$.tools.applyPatch",
                    diagnostics,
                ),
            },
            prompt: {
                mode: parseStringEnum(
                    prompt.mode,
                    CODEX_PROMPT_MODES,
                    DEFAULT_CODEX_CORE_CONFIG.prompt.mode,
                    "$.prompt.mode",
                    diagnostics,
                ),
                personality: parseStringEnum(
                    prompt.personality,
                    CODEX_PERSONALITIES,
                    DEFAULT_CODEX_CORE_CONFIG.prompt.personality,
                    "$.prompt.personality",
                    diagnostics,
                ),
            },
            compaction: {
                enabled: parseBoolean(
                    compaction.enabled,
                    DEFAULT_CODEX_CORE_CONFIG.compaction.enabled,
                    "$.compaction.enabled",
                    diagnostics,
                ),
                auto: parseBoolean(
                    compaction.auto,
                    DEFAULT_CODEX_CORE_CONFIG.compaction.auto,
                    "$.compaction.auto",
                    diagnostics,
                ),
                thresholdPercent: parseIntegerInRange(
                    compaction.thresholdPercent,
                    DEFAULT_CODEX_CORE_CONFIG.compaction.thresholdPercent,
                    1,
                    99,
                    "$.compaction.thresholdPercent",
                    diagnostics,
                ),
            },
            recovery: {
                enabled: parseBoolean(
                    recovery.enabled,
                    DEFAULT_CODEX_CORE_CONFIG.recovery.enabled,
                    "$.recovery.enabled",
                    diagnostics,
                ),
                batchFollowUps: parseBoolean(
                    recovery.batchFollowUps,
                    DEFAULT_CODEX_CORE_CONFIG.recovery.batchFollowUps,
                    "$.recovery.batchFollowUps",
                    diagnostics,
                ),
                maxAttempts: parseIntegerInRange(
                    recovery.maxAttempts,
                    DEFAULT_CODEX_CORE_CONFIG.recovery.maxAttempts,
                    0,
                    10,
                    "$.recovery.maxAttempts",
                    diagnostics,
                ),
                baseDelayMs: parseIntegerInRange(
                    recovery.baseDelayMs,
                    DEFAULT_CODEX_CORE_CONFIG.recovery.baseDelayMs,
                    1_000,
                    300_000,
                    "$.recovery.baseDelayMs",
                    diagnostics,
                ),
                maxDelayMs: parseIntegerInRange(
                    recovery.maxDelayMs,
                    DEFAULT_CODEX_CORE_CONFIG.recovery.maxDelayMs,
                    1_000,
                    900_000,
                    "$.recovery.maxDelayMs",
                    diagnostics,
                ),
            },
            openai: {
                webSearchModel: parseNonEmptyString(
                    openai.webSearchModel,
                    DEFAULT_CODEX_CORE_CONFIG.openai.webSearchModel,
                    "$.openai.webSearchModel",
                    diagnostics,
                ),
                imageModel: parseNonEmptyString(
                    openai.imageModel,
                    DEFAULT_CODEX_CORE_CONFIG.openai.imageModel,
                    "$.openai.imageModel",
                    diagnostics,
                ),
                imageDescriptionModel: parseNonEmptyString(
                    openai.imageDescriptionModel,
                    DEFAULT_CODEX_CORE_CONFIG.openai.imageDescriptionModel,
                    "$.openai.imageDescriptionModel",
                    diagnostics,
                ),
                compactionModel: parseNonEmptyString(
                    openai.compactionModel,
                    DEFAULT_CODEX_CORE_CONFIG.openai.compactionModel,
                    "$.openai.compactionModel",
                    diagnostics,
                ),
                compactionReasoning: parseNonEmptyString(
                    openai.compactionReasoning,
                    DEFAULT_CODEX_CORE_CONFIG.openai.compactionReasoning,
                    "$.openai.compactionReasoning",
                    diagnostics,
                ),
                verbosity: parseStringEnum(
                    openai.verbosity,
                    CODEX_VERBOSITY_LEVELS,
                    DEFAULT_CODEX_CORE_CONFIG.openai.verbosity,
                    "$.openai.verbosity",
                    diagnostics,
                ),
                fast: parseBoolean(
                    openai.fast,
                    DEFAULT_CODEX_CORE_CONFIG.openai.fast,
                    "$.openai.fast",
                    diagnostics,
                ),
                showReasoningTraces: parseBoolean(
                    openai.showReasoningTraces,
                    DEFAULT_CODEX_CORE_CONFIG.openai.showReasoningTraces,
                    "$.openai.showReasoningTraces",
                    diagnostics,
                ),
            },
        },
        diagnostics,
    };
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
    const parsed = parseCodexCoreConfigWithDiagnostics(input.value ?? {});
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

function parseRecord(
    value: JsonValue | undefined,
    path: string,
    diagnostics: CodexConfigDiagnostic[],
): JsonObject {
    if (value === undefined) return {};
    const parsed = JsonObjectDecoder.decode(value);
    if (parsed !== undefined) return parsed;
    diagnostics.push(makeConfigDiagnostic(path, "invalid", "Expected an object."));
    return {};
}

function hasNodeErrorCode(cause: unknown, code: string): boolean {
    return NodeErrorSchema.decode(cause)?.code === code;
}

function parseBoolean(
    value: JsonValue | undefined,
    fallback: boolean,
    path: string,
    diagnostics: CodexConfigDiagnostic[],
): boolean {
    if (value === undefined) return fallback;
    const parsed = BooleanSchema.decode(value);
    if (parsed !== undefined) return parsed;
    diagnostics.push(makeConfigDiagnostic(path, "invalid", "Expected a boolean."));
    return fallback;
}

function parseIntegerInRange(
    value: JsonValue | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
    path: string,
    diagnostics: CodexConfigDiagnostic[],
): number {
    if (value === undefined) return fallback;
    const parsed = NumberSchema.decode(value);
    if (parsed === undefined || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        diagnostics.push(
            makeConfigDiagnostic(
                path,
                "invalid",
                `Expected an integer from ${minimum} to ${maximum}.`,
            ),
        );
        return fallback;
    }
    return parsed;
}

function parseNonEmptyString(
    value: JsonValue | undefined,
    fallback: string,
    path: string,
    diagnostics: CodexConfigDiagnostic[],
): string {
    if (value === undefined) return fallback;
    const parsed = StringSchema.decode(value);
    const text = parsed?.trim() ?? "";
    if (text.length > 0) return text;
    diagnostics.push(makeConfigDiagnostic(path, "invalid", "Expected a non-empty string."));
    return fallback;
}

function parseStringEnum<const TValue extends string>(
    value: JsonValue | undefined,
    allowed: readonly TValue[],
    fallback: TValue,
    path: string,
    diagnostics: CodexConfigDiagnostic[],
): TValue {
    if (value === undefined) return fallback;
    const parsed = StringSchema.decode(value);
    if (parsed !== undefined && isOneOf(allowed, parsed)) return parsed;
    diagnostics.push(
        makeConfigDiagnostic(path, "invalid", `Expected one of: ${allowed.join(", ")}.`),
    );
    return fallback;
}

function isOneOf<const TValue extends string>(
    allowed: readonly TValue[],
    value: string,
): value is TValue {
    return allowed.some((candidate) => candidate === value);
}
