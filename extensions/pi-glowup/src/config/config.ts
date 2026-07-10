import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import type TypeboxSchema from "typebox/schema";
import type { ScriptPreviewHeaderLayout } from "../rendering/core.ts";
import type { ToolLabelMode } from "../rendering/status-labels.ts";
import {
    parseScriptFormatterCommandsValue,
    type ScriptFormatterCommands,
} from "../script-preview/formatters.ts";
import { parseScriptPreviewHeaderLayout } from "../script-preview/settings.ts";

// Pi's TypeScript loader can misresolve TypeBox subpath ESM imports as
// `typebox/build/index.mjs/schema`; Node's require resolver honors package exports.
const Schema = loadTypeboxSchema();

export type CodexLookConfig = {
    readonly preserveTools: readonly string[];
    readonly appearance: {
        readonly addedRowBackground: string | null;
        readonly deletedRowBackground: string | null;
        readonly instructionPathColor: string | null;
    };
    readonly debugLog: {
        readonly enabled: boolean;
        readonly path: string;
        readonly maxBytes: number | null;
        readonly memorySampleIntervalMs: number;
    };
    readonly scriptFormatters: ScriptFormatterCommands;
    readonly scriptHeaderLayout: ScriptPreviewHeaderLayout;
    readonly scriptMaxCodePreviewLines: number;
    readonly toolLabels: {
        readonly mode: ToolLabelMode;
    };
    readonly writePreview: {
        readonly movingViewport: boolean;
    };
    readonly syntax: {
        readonly preloadLanguages: readonly string[];
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

export type CodexLookConfigLoadPolicy = {
    readonly includeProjectConfig?: boolean;
};

export const CODEX_LOOK_EXTENSION_ID = "pi-codex-look";
export const CODEX_LOOK_CONFIG_BASENAME = "config.json";
export const CODEX_LOOK_CONFIG_SCHEMA_BASENAME = "config.schema.json";
export const CODEX_LOOK_CONFIG_SCHEMA_REFERENCE = `./${CODEX_LOOK_CONFIG_SCHEMA_BASENAME}`;

const JSON_SCHEMA_DRAFT_URI = "https://json-schema.org/draft/2020-12/schema";
const CODEX_LOOK_CONFIG_SCHEMA_ID = "https://github.com/zigai/pi-codex-look/config.schema.json";
const MIN_SCRIPT_PREVIEW_CODE_LINES = 4;

export const DEFAULT_CODEX_LOOK_CONFIG_JSON = {
    $schema: CODEX_LOOK_CONFIG_SCHEMA_REFERENCE,
    preserveTools: [],
    appearance: {
        addedRowBackground: "#213A2B",
        deletedRowBackground: null,
        instructionPathColor: null,
    },
    debugLog: {
        enabled: false,
        path: "debug.log",
        maxBytes: null,
        memorySampleIntervalMs: 10_000,
    },
    toolLabels: {
        mode: "static",
    },
    writePreview: {
        movingViewport: true,
    },
    syntax: {
        preloadLanguages: ["markdown", "bash", "python", "typescript", "javascript", "json"],
        projectLanguageDetection: {
            enabled: true,
        },
    },
    patches: {
        assistantSeparator: true,
        workingWidgetSpacing: false,
        autocompleteCleanup: true,
        markdownSyntax: true,
        thirdPartyToolRenderers: true,
    },
    scriptPreview: {
        headerLayout: "auto",
        maxCodePreviewLines: 8,
        formatters: {},
    },
} as const;

const ScriptPreviewHeaderLayoutSchema = Type.Union([
    Type.Literal("auto"),
    Type.Literal("inline"),
    Type.Literal("block"),
]);
const SchemaReferenceSchema = Type.String();
const OptionalHexColorSchema = Type.Union([
    Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" }),
    Type.Null(),
]);
const StringArraySchema = Type.Array(Type.String());
const FormatterCommandSchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });
const FormatterCommandsSchema = Type.Record(Type.String(), FormatterCommandSchema);
const ScriptPreviewMaxCodePreviewLinesSchema = Type.Integer({
    minimum: MIN_SCRIPT_PREVIEW_CODE_LINES,
});
const DebugLogMaxBytesSchema = Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]);
const DebugLogConfigSchema = Type.Object(
    {
        enabled: Type.Optional(Type.Boolean()),
        path: Type.Optional(Type.String({ minLength: 1 })),
        maxBytes: Type.Optional(DebugLogMaxBytesSchema),
        memorySampleIntervalMs: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
);
const ToolLabelsConfigSchema = Type.Object(
    {
        mode: Type.Optional(Type.Union([Type.Literal("static"), Type.Literal("lifecycle")])),
    },
    { additionalProperties: false },
);
const WritePreviewConfigSchema = Type.Object(
    {
        movingViewport: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);
const SyntaxProjectLanguageDetectionConfigSchema = Type.Object(
    {
        enabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);
const SyntaxConfigSchema = Type.Object(
    {
        preloadLanguages: Type.Optional(StringArraySchema),
        projectLanguageDetection: Type.Optional(SyntaxProjectLanguageDetectionConfigSchema),
    },
    { additionalProperties: false },
);
const PatchesConfigSchema = Type.Object(
    {
        assistantSeparator: Type.Optional(Type.Boolean()),
        workingWidgetSpacing: Type.Optional(Type.Boolean()),
        autocompleteCleanup: Type.Optional(Type.Boolean()),
        markdownSyntax: Type.Optional(Type.Boolean()),
        thirdPartyToolRenderers: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);
const ScriptPreviewConfigSchema = Type.Object(
    {
        headerLayout: Type.Optional(ScriptPreviewHeaderLayoutSchema),
        maxCodePreviewLines: Type.Optional(ScriptPreviewMaxCodePreviewLinesSchema),
        formatters: Type.Optional(FormatterCommandsSchema),
    },
    { additionalProperties: false },
);
const AppearanceConfigSchema = Type.Object(
    {
        addedRowBackground: Type.Optional(OptionalHexColorSchema),
        deletedRowBackground: Type.Optional(OptionalHexColorSchema),
        instructionPathColor: Type.Optional(OptionalHexColorSchema),
    },
    { additionalProperties: false },
);
const CodexLookConfigSchema = Type.Object(
    {
        $schema: Type.Optional(SchemaReferenceSchema),
        preserveTools: Type.Optional(StringArraySchema),
        appearance: Type.Optional(AppearanceConfigSchema),
        debugLog: Type.Optional(DebugLogConfigSchema),
        toolLabels: Type.Optional(ToolLabelsConfigSchema),
        writePreview: Type.Optional(WritePreviewConfigSchema),
        syntax: Type.Optional(SyntaxConfigSchema),
        patches: Type.Optional(PatchesConfigSchema),
        scriptPreview: Type.Optional(ScriptPreviewConfigSchema),
    },
    { additionalProperties: false },
);
const CodexLookConfigJsonSchema = Type.Object(
    {
        $schema: Type.Optional(SchemaReferenceSchema),
        preserveTools: Type.Optional(StringArraySchema),
        appearance: Type.Optional(
            Type.Object(
                {
                    addedRowBackground: Type.Optional(OptionalHexColorSchema),
                    deletedRowBackground: Type.Optional(OptionalHexColorSchema),
                    instructionPathColor: Type.Optional(OptionalHexColorSchema),
                },
                {
                    additionalProperties: false,
                    default: DEFAULT_CODEX_LOOK_CONFIG_JSON.appearance,
                },
            ),
        ),
        debugLog: Type.Optional(
            Type.Object(
                {
                    enabled: Type.Optional(Type.Boolean()),
                    path: Type.Optional(Type.String({ minLength: 1 })),
                    maxBytes: Type.Optional(DebugLogMaxBytesSchema),
                    memorySampleIntervalMs: Type.Optional(Type.Integer({ minimum: 0 })),
                },
                { additionalProperties: false, default: DEFAULT_CODEX_LOOK_CONFIG_JSON.debugLog },
            ),
        ),
        toolLabels: Type.Optional(
            Type.Object(
                {
                    mode: Type.Optional(
                        Type.Union([Type.Literal("static"), Type.Literal("lifecycle")]),
                    ),
                },
                { additionalProperties: false, default: DEFAULT_CODEX_LOOK_CONFIG_JSON.toolLabels },
            ),
        ),
        writePreview: Type.Optional(
            Type.Object(
                {
                    movingViewport: Type.Optional(Type.Boolean()),
                },
                {
                    additionalProperties: false,
                    default: DEFAULT_CODEX_LOOK_CONFIG_JSON.writePreview,
                },
            ),
        ),
        syntax: Type.Optional(
            Type.Object(
                {
                    preloadLanguages: Type.Optional(StringArraySchema),
                    projectLanguageDetection: Type.Optional(
                        Type.Object(
                            {
                                enabled: Type.Optional(Type.Boolean()),
                            },
                            {
                                additionalProperties: false,
                                default:
                                    DEFAULT_CODEX_LOOK_CONFIG_JSON.syntax.projectLanguageDetection,
                            },
                        ),
                    ),
                },
                { additionalProperties: false, default: DEFAULT_CODEX_LOOK_CONFIG_JSON.syntax },
            ),
        ),
        patches: Type.Optional(
            Type.Object(
                {
                    assistantSeparator: Type.Optional(Type.Boolean()),
                    workingWidgetSpacing: Type.Optional(Type.Boolean()),
                    autocompleteCleanup: Type.Optional(Type.Boolean()),
                    markdownSyntax: Type.Optional(Type.Boolean()),
                    thirdPartyToolRenderers: Type.Optional(Type.Boolean()),
                },
                { additionalProperties: false, default: DEFAULT_CODEX_LOOK_CONFIG_JSON.patches },
            ),
        ),
        scriptPreview: Type.Optional(
            Type.Object(
                {
                    headerLayout: Type.Optional(ScriptPreviewHeaderLayoutSchema),
                    maxCodePreviewLines: Type.Optional(ScriptPreviewMaxCodePreviewLinesSchema),
                    formatters: Type.Optional(FormatterCommandsSchema),
                },
                {
                    additionalProperties: false,
                    default: DEFAULT_CODEX_LOOK_CONFIG_JSON.scriptPreview,
                },
            ),
        ),
    },
    { additionalProperties: false },
);

type CodexLookConfigInput = Static<typeof CodexLookConfigSchema>;

function loadTypeboxSchema(): typeof TypeboxSchema {
    const require = createRequire(import.meta.url);
    const schemaModule = require("typebox/schema") as { readonly default: typeof TypeboxSchema };
    return schemaModule.default;
}

export function getCodexLookGlobalConfigPath(agentDir: string = getAgentDir()): string {
    return join(getCodexLookGlobalConfigDirectory(agentDir), CODEX_LOOK_CONFIG_BASENAME);
}

export function getCodexLookProjectConfigPath(cwd: string): string {
    return join(cwd, CONFIG_DIR_NAME, CODEX_LOOK_EXTENSION_ID, CODEX_LOOK_CONFIG_BASENAME);
}

export function getCodexLookGlobalConfigSchemaPath(agentDir: string = getAgentDir()): string {
    return join(getCodexLookGlobalConfigDirectory(agentDir), CODEX_LOOK_CONFIG_SCHEMA_BASENAME);
}

export function getCodexLookGlobalConfigDirectory(agentDir: string = getAgentDir()): string {
    return join(agentDir, CODEX_LOOK_EXTENSION_ID);
}

export function codexLookConfigJsonSchema(): unknown {
    const schema = structuredClone(CodexLookConfigJsonSchema);
    if (!isRecord(schema)) return schema;
    return {
        $schema: JSON_SCHEMA_DRAFT_URI,
        $id: CODEX_LOOK_CONFIG_SCHEMA_ID,
        ...schema,
    };
}

export function ensureCodexLookGlobalConfigFiles(
    agentDir: string = getAgentDir(),
    reportWarning: ConfigWarningReporter = defaultConfigWarningReporter,
): void {
    writeJsonFileIfMissing(
        getCodexLookGlobalConfigPath(agentDir),
        DEFAULT_CODEX_LOOK_CONFIG_JSON,
        reportWarning,
    );
    writeJsonFileIfChanged(
        getCodexLookGlobalConfigSchemaPath(agentDir),
        codexLookConfigJsonSchema(),
        reportWarning,
    );
}

export function readCodexLookConfig(
    options: {
        readonly cwd?: string;
        readonly agentDir?: string;
        readonly reportWarning?: ConfigWarningReporter;
    } = {},
    policy: CodexLookConfigLoadPolicy = {},
): CodexLookConfig {
    const reportWarning = options.reportWarning ?? defaultConfigWarningReporter;
    ensureCodexLookGlobalConfigFiles(options.agentDir, reportWarning);
    const globalConfigPath = getCodexLookGlobalConfigPath(options.agentDir);
    const projectConfigPath =
        policy.includeProjectConfig === true && options.cwd !== undefined
            ? getCodexLookProjectConfigPath(options.cwd)
            : undefined;
    const globalInput = parseCodexLookConfigInput(
        readConfigInput(globalConfigPath, reportWarning) ?? {},
        { source: globalConfigPath, reportWarning },
    );
    const projectInput =
        projectConfigPath === undefined
            ? {}
            : parseCodexLookConfigInput(readConfigInput(projectConfigPath, reportWarning) ?? {}, {
                  source: projectConfigPath,
                  reportWarning,
              });
    return parseCodexLookConfig(mergeConfigInputs(globalInput, projectInput));
}

export function parseCodexLookConfig(
    input: unknown,
    options: {
        readonly source?: string;
        readonly reportWarning?: ConfigWarningReporter;
    } = {},
): CodexLookConfig {
    const config = parseCodexLookConfigInput(input, options);
    const appearance = config.appearance ?? {};
    const scriptPreview = config.scriptPreview ?? {};
    const debugLog = config.debugLog ?? {};
    const toolLabels = config.toolLabels ?? {};
    const writePreview = config.writePreview ?? {};
    const syntax = config.syntax ?? {};
    const projectLanguageDetection = syntax.projectLanguageDetection ?? {};
    const patches = config.patches ?? {};

    return {
        preserveTools: Schema.Check(StringArraySchema, config.preserveTools)
            ? Schema.Parse(StringArraySchema, config.preserveTools).filter(
                  (value) => value.trim().length > 0,
              )
            : [],
        appearance: {
            addedRowBackground:
                appearance.addedRowBackground === undefined
                    ? DEFAULT_CODEX_LOOK_CONFIG_JSON.appearance.addedRowBackground
                    : appearance.addedRowBackground,
            deletedRowBackground:
                appearance.deletedRowBackground ??
                DEFAULT_CODEX_LOOK_CONFIG_JSON.appearance.deletedRowBackground,
            instructionPathColor:
                appearance.instructionPathColor ??
                DEFAULT_CODEX_LOOK_CONFIG_JSON.appearance.instructionPathColor,
        },
        debugLog: {
            enabled: debugLog.enabled ?? DEFAULT_CODEX_LOOK_CONFIG_JSON.debugLog.enabled,
            path: debugLog.path ?? DEFAULT_CODEX_LOOK_CONFIG_JSON.debugLog.path,
            maxBytes: debugLog.maxBytes ?? DEFAULT_CODEX_LOOK_CONFIG_JSON.debugLog.maxBytes,
            memorySampleIntervalMs:
                debugLog.memorySampleIntervalMs ??
                DEFAULT_CODEX_LOOK_CONFIG_JSON.debugLog.memorySampleIntervalMs,
        },
        scriptFormatters: parseScriptFormatterCommandsValue(scriptPreview.formatters ?? {}, {
            source: `${options.source ?? "config"}.scriptPreview.formatters`,
            ...(options.reportWarning === undefined
                ? {}
                : { reportWarning: options.reportWarning }),
        }),
        scriptHeaderLayout: parseScriptPreviewHeaderLayout(scriptPreview.headerLayout),
        scriptMaxCodePreviewLines:
            scriptPreview.maxCodePreviewLines ??
            DEFAULT_CODEX_LOOK_CONFIG_JSON.scriptPreview.maxCodePreviewLines,
        toolLabels: {
            mode: toolLabels.mode ?? DEFAULT_CODEX_LOOK_CONFIG_JSON.toolLabels.mode,
        },
        writePreview: {
            movingViewport:
                writePreview.movingViewport ??
                DEFAULT_CODEX_LOOK_CONFIG_JSON.writePreview.movingViewport,
        },
        syntax: {
            preloadLanguages:
                syntax.preloadLanguages ?? DEFAULT_CODEX_LOOK_CONFIG_JSON.syntax.preloadLanguages,
            projectLanguageDetection: {
                enabled:
                    projectLanguageDetection.enabled ??
                    DEFAULT_CODEX_LOOK_CONFIG_JSON.syntax.projectLanguageDetection.enabled,
            },
        },
        patches: {
            assistantSeparator:
                patches.assistantSeparator ??
                DEFAULT_CODEX_LOOK_CONFIG_JSON.patches.assistantSeparator,
            workingWidgetSpacing:
                patches.workingWidgetSpacing ??
                DEFAULT_CODEX_LOOK_CONFIG_JSON.patches.workingWidgetSpacing,
            autocompleteCleanup:
                patches.autocompleteCleanup ??
                DEFAULT_CODEX_LOOK_CONFIG_JSON.patches.autocompleteCleanup,
            markdownSyntax:
                patches.markdownSyntax ?? DEFAULT_CODEX_LOOK_CONFIG_JSON.patches.markdownSyntax,
            thirdPartyToolRenderers:
                patches.thirdPartyToolRenderers ??
                DEFAULT_CODEX_LOOK_CONFIG_JSON.patches.thirdPartyToolRenderers,
        },
    };
}

function parseCodexLookConfigInput(
    input: unknown,
    options: {
        readonly source?: string;
        readonly reportWarning?: ConfigWarningReporter;
    },
): CodexLookConfigInput {
    if (Schema.Check(CodexLookConfigSchema, input)) {
        return Schema.Parse(CodexLookConfigSchema, input);
    }

    options.reportWarning?.(
        `[pi-codex-look] Ignoring invalid ${options.source ?? "config"}: ${configSchemaErrorSummary(input)}`,
    );
    return {};
}

function configSchemaErrorSummary(input: unknown): string {
    const [, errors] = Schema.Errors(CodexLookConfigSchema, input);
    const messages = errors.slice(0, 3).map((error) => {
        const path = error.instancePath.length > 0 ? error.instancePath : "/";
        return `${path} ${error.message}`;
    });
    if (errors.length > messages.length) {
        messages.push(`+${errors.length - messages.length} more`);
    }
    return messages.join("; ") || "invalid config shape";
}

function serializeJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function defaultConfigWarningReporter(message: string): void {
    console.warn(message);
}

function writeJsonFileIfMissing(
    filePath: string,
    value: unknown,
    reportWarning: ConfigWarningReporter,
): void {
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
        reportWarning(`[pi-codex-look] Failed to create ${filePath}: ${message}`);
    }
}

function writeJsonFileIfChanged(
    filePath: string,
    value: unknown,
    reportWarning: ConfigWarningReporter,
): void {
    const nextContent = serializeJson(value);

    try {
        if (existsSync(filePath) && readFileSync(filePath, "utf8") === nextContent) return;
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, nextContent, "utf8");
    } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        reportWarning(`[pi-codex-look] Failed to write ${filePath}: ${message}`);
    }
}

function readConfigInput(configPath: string, reportWarning: ConfigWarningReporter): unknown {
    if (!existsSync(configPath)) return undefined;

    try {
        const rawConfig: unknown = JSON.parse(readFileSync(configPath, "utf8"));
        return rawConfig;
    } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        reportWarning(`[pi-codex-look] Failed to read ${configPath}: ${message}`);
        return undefined;
    }
}

function mergeConfigInputs(base: unknown, override: unknown): unknown {
    if (!isRecord(base)) return override ?? base;
    if (!isRecord(override)) return base;

    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
        merged[key] = mergeConfigInputs(merged[key], value);
    }
    return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNodeErrorCode(cause: unknown, code: string): boolean {
    return isRecord(cause) && cause.code === code;
}
