import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import type { ScriptPreviewHeaderLayout } from "./rendering.ts";
import {
    parseScriptFormatterCommandsValue,
    type ScriptFormatterCommands,
} from "./script-formatters.ts";
import { parseScriptPreviewHeaderLayout } from "./script-preview-settings.ts";
import Schema from "./typebox-schema.ts";

export type CodexLookConfig = {
    readonly preserveTools: readonly string[];
    readonly scriptFormatters: ScriptFormatterCommands;
    readonly scriptHeaderLayout: ScriptPreviewHeaderLayout;
    readonly syntaxPreloadOnStartup: boolean;
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

export const DEFAULT_CODEX_LOOK_CONFIG_JSON = {
    $schema: CODEX_LOOK_CONFIG_SCHEMA_REFERENCE,
    preserveTools: [],
    syntax: {
        preloadOnStartup: false,
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
        formatters: {},
    },
} as const;

const ScriptPreviewHeaderLayoutSchema = Type.Union([
    Type.Literal("auto"),
    Type.Literal("inline"),
    Type.Literal("block"),
]);
const SchemaReferenceSchema = Type.String();
const StringArraySchema = Type.Array(Type.String());
const FormatterCommandSchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });
const FormatterCommandsSchema = Type.Record(Type.String(), FormatterCommandSchema);
const SyntaxConfigSchema = Type.Object(
    {
        preloadOnStartup: Type.Optional(Type.Boolean()),
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
        formatters: Type.Optional(FormatterCommandsSchema),
    },
    { additionalProperties: false },
);
const CodexLookConfigSchema = Type.Object(
    {
        $schema: Type.Optional(SchemaReferenceSchema),
        preserveTools: Type.Optional(StringArraySchema),
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
        syntax: Type.Optional(
            Type.Object(
                {
                    preloadOnStartup: Type.Optional(Type.Boolean()),
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

export function getCodexLookGlobalConfigPath(agentDir: string = getAgentDir()): string {
    return join(agentDir, CODEX_LOOK_EXTENSION_ID, CODEX_LOOK_CONFIG_BASENAME);
}

export function getCodexLookProjectConfigPath(cwd: string): string {
    return join(cwd, CONFIG_DIR_NAME, CODEX_LOOK_EXTENSION_ID, CODEX_LOOK_CONFIG_BASENAME);
}

export function getCodexLookGlobalConfigSchemaPath(agentDir: string = getAgentDir()): string {
    return join(agentDir, CODEX_LOOK_EXTENSION_ID, CODEX_LOOK_CONFIG_SCHEMA_BASENAME);
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
    const scriptPreview = config.scriptPreview ?? {};
    const syntax = config.syntax ?? {};
    const patches = config.patches ?? {};

    return {
        preserveTools: Schema.Check(StringArraySchema, config.preserveTools)
            ? Schema.Parse(StringArraySchema, config.preserveTools).filter(
                  (value) => value.trim().length > 0,
              )
            : [],
        scriptFormatters: parseScriptFormatterCommandsValue(scriptPreview.formatters ?? {}, {
            source: `${options.source ?? "config"}.scriptPreview.formatters`,
            ...(options.reportWarning === undefined
                ? {}
                : { reportWarning: options.reportWarning }),
        }),
        scriptHeaderLayout: parseScriptPreviewHeaderLayout(scriptPreview.headerLayout),
        syntaxPreloadOnStartup:
            syntax.preloadOnStartup ?? DEFAULT_CODEX_LOOK_CONFIG_JSON.syntax.preloadOnStartup,
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
