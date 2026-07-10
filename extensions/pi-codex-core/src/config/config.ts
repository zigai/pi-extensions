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
import { compileSchema, parseWithSchema } from "../schema-parsing.ts";

export type CodexPromptMode = "pi" | "codex";
export type CodexPersonality = "friendly" | "pragmatic" | "none";
export type CodexToolScope = "codex" | "all";
export type CodexApplyPatchMode = "off" | "openai" | "all";
export type CodexVerbosity = "low" | "medium" | "high";
export type CodexCompactionReasoning = string;

/** Config value that means Codex API requests should use the active Codex model. */
export const CODEX_CURRENT_MODEL_SELECTION = "current";
export const CODEX_TOOL_SCOPES: readonly CodexToolScope[] = ["codex", "all"];
export const CODEX_APPLY_PATCH_MODES: readonly CodexApplyPatchMode[] = ["off", "openai", "all"];
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
const CodexCompactionReasoningSchema = Type.String({ minLength: 1, pattern: "\\S" });
const CodexCoreConfigJsonSchema = Type.Object(
    {
        scope: Type.Object(
            { tools: CodexToolScopeSchema },
            { additionalProperties: false, default: { tools: "codex" } },
        ),
        tools: Type.Object(
            {
                webSearch: Type.Boolean({ default: true }),
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

const UnknownRecordSchema = compileSchema(Type.Record(Type.String(), Type.Unknown()));
const BooleanSchema = compileSchema(Type.Boolean());
const NumberSchema = compileSchema(Type.Number());
const StringSchema = compileSchema(Type.String());

export const DEFAULT_CODEX_CORE_CONFIG: CodexCoreConfig = {
    scope: { tools: "codex" },
    tools: {
        webSearch: true,
        imageGeneration: true,
        viewImage: true,
        viewImageDescriptions: false,
        applyPatch: "off",
    },
    prompt: { mode: "codex", personality: "pragmatic" },
    compaction: { enabled: true, auto: true, thresholdPercent: 80 },
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

export function codexCoreConfigJsonSchema(): unknown {
    const schema = structuredClone(CodexCoreConfigJsonSchema);
    if (!isPlainRecord(schema)) return schema;
    return {
        $schema: JSON_SCHEMA_DRAFT_URI,
        $id: CODEX_CORE_CONFIG_SCHEMA_ID,
        ...schema,
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
    const diagnostics: CodexConfigDiagnostic[] = [];
    const root = parseRecord(value, "$", diagnostics);

    const scope = parseRecord(root.scope, "$.scope", diagnostics);
    const tools = parseRecord(root.tools, "$.tools", diagnostics);
    const prompt = parseRecord(root.prompt, "$.prompt", diagnostics);
    const compaction = parseRecord(root.compaction, "$.compaction", diagnostics);
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
                thresholdPercent: parsePercent(
                    compaction.thresholdPercent,
                    DEFAULT_CODEX_CORE_CONFIG.compaction.thresholdPercent,
                    "$.compaction.thresholdPercent",
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
    if (typeof options === "string") {
        return parseReadConfigInput(readConfigInput(options));
    }

    if (options.configPath !== undefined) {
        return parseReadConfigInput(readConfigInput(options.configPath));
    }

    ensureCodexCoreGlobalConfigFiles(options.agentDir);
    const globalInput = readConfigInput(getCodexCoreGlobalConfigPath(options.agentDir));
    const projectInput =
        options.cwd === undefined
            ? undefined
            : readConfigInput(getCodexCoreProjectConfigPath(options.cwd));
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
        const message = cause instanceof Error ? cause.message : String(cause);
        console.warn(`[pi-codex-core] Failed to create ${filePath}: ${message}`);
    }
}

function writeJsonFileIfChanged(filePath: string, value: unknown): void {
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
    readonly value: unknown;
    readonly diagnostics: readonly CodexConfigDiagnostic[];
};

function readConfigInput(configPath: string): ConfigInputReadResult {
    if (!existsSync(configPath)) return { value: undefined, diagnostics: [] };

    try {
        const rawConfig: unknown = JSON.parse(readFileSync(configPath, "utf8"));
        return { value: rawConfig, diagnostics: [] };
    } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.warn(`[pi-codex-core] Failed to read ${configPath}: ${message}`);
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

function mergeConfigInputs(base: unknown, override: unknown): unknown {
    if (!isPlainRecord(base)) return override ?? base;
    if (!isPlainRecord(override)) return base;

    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
        merged[key] = mergeConfigInputs(merged[key], value);
    }
    return merged;
}

function parseRecord(
    value: unknown,
    path: string,
    diagnostics: CodexConfigDiagnostic[],
): Record<string, unknown> {
    if (value === undefined) return {};
    const parsed = parseWithSchema(UnknownRecordSchema, value);
    if (parsed !== undefined) return parsed;
    diagnostics.push(makeConfigDiagnostic(path, "invalid", "Expected an object."));
    return {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNodeErrorCode(cause: unknown, code: string): boolean {
    return isPlainRecord(cause) && cause.code === code;
}

function parseBoolean(
    value: unknown,
    fallback: boolean,
    path: string,
    diagnostics: CodexConfigDiagnostic[],
): boolean {
    if (value === undefined) return fallback;
    const parsed = parseWithSchema(BooleanSchema, value);
    if (parsed !== undefined) return parsed;
    diagnostics.push(makeConfigDiagnostic(path, "invalid", "Expected a boolean."));
    return fallback;
}

function parsePercent(
    value: unknown,
    fallback: number,
    path: string,
    diagnostics: CodexConfigDiagnostic[],
): number {
    if (value === undefined) return fallback;
    const parsed = parseWithSchema(NumberSchema, value);
    if (parsed === undefined || parsed < 1 || parsed > 99) {
        diagnostics.push(makeConfigDiagnostic(path, "invalid", "Expected a number from 1 to 99."));
        return fallback;
    }
    return Math.trunc(parsed);
}

function parseNonEmptyString(
    value: unknown,
    fallback: string,
    path: string,
    diagnostics: CodexConfigDiagnostic[],
): string {
    if (value === undefined) return fallback;
    const parsed = parseWithSchema(StringSchema, value);
    const text = parsed?.trim() ?? "";
    if (text.length > 0) return text;
    diagnostics.push(makeConfigDiagnostic(path, "invalid", "Expected a non-empty string."));
    return fallback;
}

function parseStringEnum<const TValue extends string>(
    value: unknown,
    allowed: readonly TValue[],
    fallback: TValue,
    path: string,
    diagnostics: CodexConfigDiagnostic[],
): TValue {
    if (value === undefined) return fallback;
    const parsed = parseWithSchema(StringSchema, value);
    if (parsed !== undefined && (allowed as readonly string[]).includes(parsed)) {
        // SAFETY: The allowed-list membership check establishes TValue.
        return parsed as TValue;
    }
    diagnostics.push(
        makeConfigDiagnostic(path, "invalid", `Expected one of: ${allowed.join(", ")}.`),
    );
    return fallback;
}
