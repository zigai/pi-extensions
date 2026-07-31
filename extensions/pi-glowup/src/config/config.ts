import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import type TypeboxSchema from "typebox/schema";
import type { DiffLineNumberStyle, NarrowDiffLayout, SideBySideLayout } from "../diffs/layout.ts";
import type {
    DiffBackgroundStyle,
    ScriptPreviewHeaderLayout,
    ToolCallIndicator,
} from "../rendering/core.ts";
import type { ToolLabelMode } from "../rendering/status-labels.ts";
import { DEFAULT_MUTATION_SETTINGS, type MutationSettings } from "../mutations/settings.ts";
import {
    parseScriptFormatterCommandsValue,
    type ScriptFormatterCommands,
} from "../script-preview/formatters.ts";
import { parseScriptPreviewHeaderLayout } from "../script-preview/settings.ts";

// Pi's TypeScript loader can misresolve TypeBox subpath ESM imports as
// `typebox/build/index.mjs/schema`; Node's require resolver honors package exports.
const Schema = loadTypeboxSchema();

export type GlowupConfig = {
    readonly preserveTools: readonly string[];
    readonly mutations: MutationSettings;
    readonly appearance: {
        readonly diffBackgroundStyle: DiffBackgroundStyle;
        readonly diffLineNumberStyle: DiffLineNumberStyle;
        readonly narrowDiffLayout: NarrowDiffLayout;
        readonly sideBySideLayout: SideBySideLayout;
        readonly addedRowBackground: string | null;
        readonly deletedRowBackground: string | null;
        readonly addedContentBackground: string | null;
        readonly deletedContentBackground: string | null;
        readonly instructionPathColor: string | null;
        readonly dimUnchangedDiffText: boolean;
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

export const GLOWUP_EXTENSION_ID = "pi-glowup";
export const GLOWUP_CONFIG_BASENAME = "config.json";
export const GLOWUP_CONFIG_SCHEMA_BASENAME = "config.schema.json";
export const GLOWUP_CONFIG_SCHEMA_REFERENCE = `./${GLOWUP_CONFIG_SCHEMA_BASENAME}`;

const JSON_SCHEMA_DRAFT_URI = "https://json-schema.org/draft/2020-12/schema";
const GLOWUP_CONFIG_SCHEMA_ID = "https://github.com/zigai/pi-glowup/config.schema.json";
const MIN_SCRIPT_PREVIEW_CODE_LINES = 4;

export const DEFAULT_GLOWUP_CONFIG_JSON = {
    $schema: GLOWUP_CONFIG_SCHEMA_REFERENCE,
    preserveTools: [],
    mutations: DEFAULT_MUTATION_SETTINGS,
    appearance: {
        diffBackgroundStyle: "two-tone",
        diffLineNumberStyle: "dual",
        narrowDiffLayout: "paired",
        sideBySideLayout: "content-aware",
        addedRowBackground: "#213A2B",
        deletedRowBackground: "#4A221D",
        addedContentBackground: "#0D5728",
        deletedContentBackground: "#762925",
        instructionPathColor: null,
        dimUnchangedDiffText: false,
    },
    debugLog: {
        enabled: false,
        path: "debug.log",
        maxBytes: null,
        memorySampleIntervalMs: 10_000,
    },
    toolCallIndicator: {
        symbol: "•",
        bold: true,
    },
    toolLabels: {
        mode: "static",
    },
    writePreview: {
        movingViewport: true,
    },
    syntax: {
        preloadLanguages: ["markdown", "bash", "python", "typescript", "javascript", "json"],
        bracketPairColoring: true,
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
const DiffBackgroundStyleSchema = Type.Union(
    [Type.Literal("changed-spans"), Type.Literal("two-tone"), Type.Literal("full-row")],
    {
        description: "Background treatment for changed diff rows and intraline spans.",
    },
);
const DiffLineNumberStyleSchema = Type.Union([Type.Literal("single"), Type.Literal("dual")], {
    description: "Show one relevant line number or aligned old and new line-number columns.",
});
const NarrowDiffLayoutSchema = Type.Union([Type.Literal("paired"), Type.Literal("traditional")], {
    description: "Order similar deletion/addition rows together or in traditional blocks.",
});
const SideBySideLayoutSchema = Type.Union([Type.Literal("content-aware"), Type.Literal("fixed")], {
    description: "Choose split diffs from content fit or a fixed terminal-width threshold.",
});
const SchemaReferenceSchema = Type.String();
function optionalHexColorSchema(description: string) {
    return Type.Union([Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" }), Type.Null()], {
        description,
    });
}
const AddedRowBackgroundSchema = optionalHexColorSchema(
    "Subtle addition-row background; null derives it from the active Pi theme.",
);
const DeletedRowBackgroundSchema = optionalHexColorSchema(
    "Subtle deletion-row background; null derives it from the active Pi theme.",
);
const AddedContentBackgroundSchema = optionalHexColorSchema(
    "Stronger added intraline-span background; null derives a contrasting shade.",
);
const DeletedContentBackgroundSchema = optionalHexColorSchema(
    "Stronger deleted intraline-span background; null derives a contrasting shade.",
);
const InstructionPathColorSchema = optionalHexColorSchema(
    "Instruction-file path foreground; null inherits the active Pi theme.",
);
const StringArraySchema = Type.Array(Type.String());
const FormatterCommandSchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });
const FormatterCommandsSchema = Type.Record(Type.String(), FormatterCommandSchema);
const ScriptPreviewMaxCodePreviewLinesSchema = Type.Integer({
    minimum: MIN_SCRIPT_PREVIEW_CODE_LINES,
});
const DebugLogMaxBytesSchema = Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]);
const ToolCallIndicatorSymbolSchema = Type.String({ minLength: 1, maxLength: 8, pattern: "\\S" });
const DebugLogConfigSchema = Type.Object(
    {
        enabled: Type.Optional(Type.Boolean()),
        path: Type.Optional(Type.String({ minLength: 1 })),
        maxBytes: Type.Optional(DebugLogMaxBytesSchema),
        memorySampleIntervalMs: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
);
const ToolCallIndicatorConfigSchema = Type.Object(
    {
        symbol: Type.Optional(ToolCallIndicatorSymbolSchema),
        bold: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);
const ToolLabelsConfigSchema = Type.Object(
    {
        mode: Type.Optional(Type.Union([Type.Literal("static"), Type.Literal("lifecycle")])),
    },
    { additionalProperties: false },
);
function optionalPositiveIntegerSchema(description: string) {
    return Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], { description });
}
const MaxDiffBytesSchema = optionalPositiveIntegerSchema(
    "Maximum combined diff snapshot or metadata bytes; null disables this limit.",
);
const MaxDiffLinesSchema = optionalPositiveIntegerSchema(
    "Maximum diff rows before rendering a summary; null disables this limit.",
);
const MaxWritePreviewBytesSchema = optionalPositiveIntegerSchema(
    "Maximum native-write content bytes retained for rendering; null disables this limit.",
);
const MaxDeletePreimageBytesSchema = optionalPositiveIntegerSchema(
    "Maximum file bytes captured before deletion; null disables this limit.",
);
const MutationLimitsConfigSchema = Type.Object(
    {
        maxDiffBytes: Type.Optional(MaxDiffBytesSchema),
        maxDiffLines: Type.Optional(MaxDiffLinesSchema),
        maxWritePreviewBytes: Type.Optional(MaxWritePreviewBytesSchema),
        maxDeletePreimageBytes: Type.Optional(MaxDeletePreimageBytesSchema),
    },
    { additionalProperties: false },
);
const MutationsConfigSchema = Type.Object(
    {
        defaultView: Type.Optional(
            Type.Union([Type.Literal("full"), Type.Literal("preview")], {
                description:
                    "Show every available completed-mutation row or a bounded semantic preview.",
            }),
        ),
        previewLines: Type.Optional(
            Type.Integer({
                minimum: 1,
                description: "Changed/content rows retained per file in preview view.",
            }),
        ),
        limits: Type.Optional(MutationLimitsConfigSchema),
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
        bracketPairColoring: Type.Optional(
            Type.Boolean({
                description:
                    "Color matching bracket pairs; false preserves the syntax theme foreground.",
            }),
        ),
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
        diffBackgroundStyle: Type.Optional(DiffBackgroundStyleSchema),
        diffLineNumberStyle: Type.Optional(DiffLineNumberStyleSchema),
        narrowDiffLayout: Type.Optional(NarrowDiffLayoutSchema),
        sideBySideLayout: Type.Optional(SideBySideLayoutSchema),
        addedRowBackground: Type.Optional(AddedRowBackgroundSchema),
        deletedRowBackground: Type.Optional(DeletedRowBackgroundSchema),
        addedContentBackground: Type.Optional(AddedContentBackgroundSchema),
        deletedContentBackground: Type.Optional(DeletedContentBackgroundSchema),
        instructionPathColor: Type.Optional(InstructionPathColorSchema),
        dimUnchangedDiffText: Type.Optional(
            Type.Boolean({ description: "Dim unchanged text around changed intraline spans." }),
        ),
    },
    { additionalProperties: false },
);
const GlowupConfigSchema = Type.Object(
    {
        $schema: Type.Optional(SchemaReferenceSchema),
        preserveTools: Type.Optional(StringArraySchema),
        mutations: Type.Optional(MutationsConfigSchema),
        appearance: Type.Optional(AppearanceConfigSchema),
        debugLog: Type.Optional(DebugLogConfigSchema),
        toolCallIndicator: Type.Optional(ToolCallIndicatorConfigSchema),
        toolLabels: Type.Optional(ToolLabelsConfigSchema),
        writePreview: Type.Optional(WritePreviewConfigSchema),
        syntax: Type.Optional(SyntaxConfigSchema),
        patches: Type.Optional(PatchesConfigSchema),
        scriptPreview: Type.Optional(ScriptPreviewConfigSchema),
    },
    { additionalProperties: false },
);
const GlowupConfigJsonSchema = Type.Object(
    {
        $schema: Type.Optional(SchemaReferenceSchema),
        preserveTools: Type.Optional(StringArraySchema),
        mutations: Type.Optional(
            Type.Object(
                {
                    defaultView: Type.Optional(
                        Type.Union([Type.Literal("full"), Type.Literal("preview")], {
                            description:
                                "Show every available completed-mutation row or a bounded semantic preview.",
                        }),
                    ),
                    previewLines: Type.Optional(
                        Type.Integer({
                            minimum: 1,
                            description: "Changed/content rows retained per file in preview view.",
                        }),
                    ),
                    limits: Type.Optional(
                        Type.Object(
                            {
                                maxDiffBytes: Type.Optional(MaxDiffBytesSchema),
                                maxDiffLines: Type.Optional(MaxDiffLinesSchema),
                                maxWritePreviewBytes: Type.Optional(MaxWritePreviewBytesSchema),
                                maxDeletePreimageBytes: Type.Optional(MaxDeletePreimageBytesSchema),
                            },
                            {
                                additionalProperties: false,
                                default: DEFAULT_GLOWUP_CONFIG_JSON.mutations.limits,
                            },
                        ),
                    ),
                },
                {
                    additionalProperties: false,
                    default: DEFAULT_GLOWUP_CONFIG_JSON.mutations,
                },
            ),
        ),
        appearance: Type.Optional(
            Type.Object(
                {
                    diffBackgroundStyle: Type.Optional(DiffBackgroundStyleSchema),
                    diffLineNumberStyle: Type.Optional(DiffLineNumberStyleSchema),
                    narrowDiffLayout: Type.Optional(NarrowDiffLayoutSchema),
                    sideBySideLayout: Type.Optional(SideBySideLayoutSchema),
                    addedRowBackground: Type.Optional(AddedRowBackgroundSchema),
                    deletedRowBackground: Type.Optional(DeletedRowBackgroundSchema),
                    addedContentBackground: Type.Optional(AddedContentBackgroundSchema),
                    deletedContentBackground: Type.Optional(DeletedContentBackgroundSchema),
                    instructionPathColor: Type.Optional(InstructionPathColorSchema),
                    dimUnchangedDiffText: Type.Optional(
                        Type.Boolean({
                            description: "Dim unchanged text around changed intraline spans.",
                        }),
                    ),
                },
                {
                    additionalProperties: false,
                    default: DEFAULT_GLOWUP_CONFIG_JSON.appearance,
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
                { additionalProperties: false, default: DEFAULT_GLOWUP_CONFIG_JSON.debugLog },
            ),
        ),
        toolLabels: Type.Optional(
            Type.Object(
                {
                    mode: Type.Optional(
                        Type.Union([Type.Literal("static"), Type.Literal("lifecycle")]),
                    ),
                },
                { additionalProperties: false, default: DEFAULT_GLOWUP_CONFIG_JSON.toolLabels },
            ),
        ),
        toolCallIndicator: Type.Optional(
            Type.Object(
                {
                    symbol: Type.Optional(ToolCallIndicatorSymbolSchema),
                    bold: Type.Optional(Type.Boolean()),
                },
                {
                    additionalProperties: false,
                    default: DEFAULT_GLOWUP_CONFIG_JSON.toolCallIndicator,
                },
            ),
        ),
        writePreview: Type.Optional(
            Type.Object(
                {
                    movingViewport: Type.Optional(Type.Boolean()),
                },
                {
                    additionalProperties: false,
                    default: DEFAULT_GLOWUP_CONFIG_JSON.writePreview,
                },
            ),
        ),
        syntax: Type.Optional(
            Type.Object(
                {
                    preloadLanguages: Type.Optional(StringArraySchema),
                    bracketPairColoring: Type.Optional(
                        Type.Boolean({
                            description:
                                "Color matching bracket pairs; false preserves the syntax theme foreground.",
                        }),
                    ),
                    projectLanguageDetection: Type.Optional(
                        Type.Object(
                            {
                                enabled: Type.Optional(Type.Boolean()),
                            },
                            {
                                additionalProperties: false,
                                default: DEFAULT_GLOWUP_CONFIG_JSON.syntax.projectLanguageDetection,
                            },
                        ),
                    ),
                },
                { additionalProperties: false, default: DEFAULT_GLOWUP_CONFIG_JSON.syntax },
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
                { additionalProperties: false, default: DEFAULT_GLOWUP_CONFIG_JSON.patches },
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
                    default: DEFAULT_GLOWUP_CONFIG_JSON.scriptPreview,
                },
            ),
        ),
    },
    { additionalProperties: false },
);

type GlowupConfigInput = Static<typeof GlowupConfigSchema>;

function loadTypeboxSchema(): typeof TypeboxSchema {
    const require = createRequire(import.meta.url);
    const schemaModule = require("typebox/schema") as { readonly default: typeof TypeboxSchema };
    return schemaModule.default;
}

export function getGlowupGlobalConfigPath(agentDir: string = getAgentDir()): string {
    return join(getGlowupGlobalConfigDirectory(agentDir), GLOWUP_CONFIG_BASENAME);
}

export function getGlowupProjectConfigPath(cwd: string): string {
    return join(cwd, CONFIG_DIR_NAME, GLOWUP_EXTENSION_ID, GLOWUP_CONFIG_BASENAME);
}

export function getGlowupGlobalConfigSchemaPath(agentDir: string = getAgentDir()): string {
    return join(getGlowupGlobalConfigDirectory(agentDir), GLOWUP_CONFIG_SCHEMA_BASENAME);
}

export function getGlowupGlobalConfigDirectory(agentDir: string = getAgentDir()): string {
    return join(agentDir, GLOWUP_EXTENSION_ID);
}

export function glowupConfigJsonSchema(): unknown {
    const schema = structuredClone(GlowupConfigJsonSchema);
    if (!isRecord(schema)) return schema;
    return {
        $schema: JSON_SCHEMA_DRAFT_URI,
        $id: GLOWUP_CONFIG_SCHEMA_ID,
        ...schema,
    };
}

export function ensureGlowupGlobalConfigFiles(
    agentDir: string = getAgentDir(),
    reportWarning: ConfigWarningReporter = defaultConfigWarningReporter,
): void {
    writeJsonFileIfMissing(
        getGlowupGlobalConfigPath(agentDir),
        DEFAULT_GLOWUP_CONFIG_JSON,
        reportWarning,
    );
    writeJsonFileIfChanged(
        getGlowupGlobalConfigSchemaPath(agentDir),
        glowupConfigJsonSchema(),
        reportWarning,
    );
}

export function readGlowupConfig(
    options: {
        readonly cwd?: string;
        readonly agentDir?: string;
        readonly reportWarning?: ConfigWarningReporter;
    } = {},
    policy: GlowupConfigLoadPolicy = {},
): GlowupConfig {
    const reportWarning = options.reportWarning ?? defaultConfigWarningReporter;
    ensureGlowupGlobalConfigFiles(options.agentDir, reportWarning);
    const globalConfigPath = getGlowupGlobalConfigPath(options.agentDir);
    const projectConfigPath =
        policy.includeProjectConfig === true && options.cwd !== undefined
            ? getGlowupProjectConfigPath(options.cwd)
            : undefined;
    const globalInput = parseGlowupConfigInput(
        readConfigInput(globalConfigPath, reportWarning) ?? {},
        { source: globalConfigPath, reportWarning },
    );
    const projectInput =
        projectConfigPath === undefined
            ? {}
            : parseGlowupConfigInput(readConfigInput(projectConfigPath, reportWarning) ?? {}, {
                  source: projectConfigPath,
                  reportWarning,
              });
    return parseGlowupConfig(mergeConfigInputs(globalInput, projectInput));
}

export function parseGlowupConfig(
    input: unknown,
    options: {
        readonly source?: string;
        readonly reportWarning?: ConfigWarningReporter;
    } = {},
): GlowupConfig {
    const config = parseGlowupConfigInput(input, options);
    const mutations = config.mutations ?? {};
    const mutationLimits = mutations.limits ?? {};
    const appearance = config.appearance ?? {};
    const scriptPreview = config.scriptPreview ?? {};
    const debugLog = config.debugLog ?? {};
    const toolCallIndicator = config.toolCallIndicator ?? {};
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
        mutations: {
            defaultView: mutations.defaultView ?? DEFAULT_GLOWUP_CONFIG_JSON.mutations.defaultView,
            previewLines:
                mutations.previewLines ?? DEFAULT_GLOWUP_CONFIG_JSON.mutations.previewLines,
            limits: {
                maxDiffBytes:
                    mutationLimits.maxDiffBytes === undefined
                        ? DEFAULT_GLOWUP_CONFIG_JSON.mutations.limits.maxDiffBytes
                        : mutationLimits.maxDiffBytes,
                maxDiffLines:
                    mutationLimits.maxDiffLines === undefined
                        ? DEFAULT_GLOWUP_CONFIG_JSON.mutations.limits.maxDiffLines
                        : mutationLimits.maxDiffLines,
                maxWritePreviewBytes:
                    mutationLimits.maxWritePreviewBytes === undefined
                        ? DEFAULT_GLOWUP_CONFIG_JSON.mutations.limits.maxWritePreviewBytes
                        : mutationLimits.maxWritePreviewBytes,
                maxDeletePreimageBytes:
                    mutationLimits.maxDeletePreimageBytes === undefined
                        ? DEFAULT_GLOWUP_CONFIG_JSON.mutations.limits.maxDeletePreimageBytes
                        : mutationLimits.maxDeletePreimageBytes,
            },
        },
        appearance: {
            diffBackgroundStyle:
                appearance.diffBackgroundStyle ??
                DEFAULT_GLOWUP_CONFIG_JSON.appearance.diffBackgroundStyle,
            diffLineNumberStyle:
                appearance.diffLineNumberStyle ??
                DEFAULT_GLOWUP_CONFIG_JSON.appearance.diffLineNumberStyle,
            narrowDiffLayout:
                appearance.narrowDiffLayout ??
                DEFAULT_GLOWUP_CONFIG_JSON.appearance.narrowDiffLayout,
            sideBySideLayout:
                appearance.sideBySideLayout ??
                DEFAULT_GLOWUP_CONFIG_JSON.appearance.sideBySideLayout,
            addedRowBackground:
                appearance.addedRowBackground === undefined
                    ? DEFAULT_GLOWUP_CONFIG_JSON.appearance.addedRowBackground
                    : appearance.addedRowBackground,
            deletedRowBackground:
                appearance.deletedRowBackground === undefined
                    ? DEFAULT_GLOWUP_CONFIG_JSON.appearance.deletedRowBackground
                    : appearance.deletedRowBackground,
            addedContentBackground:
                appearance.addedContentBackground === undefined
                    ? DEFAULT_GLOWUP_CONFIG_JSON.appearance.addedContentBackground
                    : appearance.addedContentBackground,
            deletedContentBackground:
                appearance.deletedContentBackground === undefined
                    ? DEFAULT_GLOWUP_CONFIG_JSON.appearance.deletedContentBackground
                    : appearance.deletedContentBackground,
            instructionPathColor:
                appearance.instructionPathColor ??
                DEFAULT_GLOWUP_CONFIG_JSON.appearance.instructionPathColor,
            dimUnchangedDiffText:
                appearance.dimUnchangedDiffText ??
                DEFAULT_GLOWUP_CONFIG_JSON.appearance.dimUnchangedDiffText,
        },
        debugLog: {
            enabled: debugLog.enabled ?? DEFAULT_GLOWUP_CONFIG_JSON.debugLog.enabled,
            path: debugLog.path ?? DEFAULT_GLOWUP_CONFIG_JSON.debugLog.path,
            maxBytes: debugLog.maxBytes ?? DEFAULT_GLOWUP_CONFIG_JSON.debugLog.maxBytes,
            memorySampleIntervalMs:
                debugLog.memorySampleIntervalMs ??
                DEFAULT_GLOWUP_CONFIG_JSON.debugLog.memorySampleIntervalMs,
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
            DEFAULT_GLOWUP_CONFIG_JSON.scriptPreview.maxCodePreviewLines,
        toolCallIndicator: {
            symbol: toolCallIndicator.symbol ?? DEFAULT_GLOWUP_CONFIG_JSON.toolCallIndicator.symbol,
            bold: toolCallIndicator.bold ?? DEFAULT_GLOWUP_CONFIG_JSON.toolCallIndicator.bold,
        },
        toolLabels: {
            mode: toolLabels.mode ?? DEFAULT_GLOWUP_CONFIG_JSON.toolLabels.mode,
        },
        writePreview: {
            movingViewport:
                writePreview.movingViewport ??
                DEFAULT_GLOWUP_CONFIG_JSON.writePreview.movingViewport,
        },
        syntax: {
            preloadLanguages:
                syntax.preloadLanguages ?? DEFAULT_GLOWUP_CONFIG_JSON.syntax.preloadLanguages,
            bracketPairColoring:
                syntax.bracketPairColoring ?? DEFAULT_GLOWUP_CONFIG_JSON.syntax.bracketPairColoring,
            projectLanguageDetection: {
                enabled:
                    projectLanguageDetection.enabled ??
                    DEFAULT_GLOWUP_CONFIG_JSON.syntax.projectLanguageDetection.enabled,
            },
        },
        patches: {
            assistantSeparator:
                patches.assistantSeparator ?? DEFAULT_GLOWUP_CONFIG_JSON.patches.assistantSeparator,
            workingWidgetSpacing:
                patches.workingWidgetSpacing ??
                DEFAULT_GLOWUP_CONFIG_JSON.patches.workingWidgetSpacing,
            autocompleteCleanup:
                patches.autocompleteCleanup ??
                DEFAULT_GLOWUP_CONFIG_JSON.patches.autocompleteCleanup,
            markdownSyntax:
                patches.markdownSyntax ?? DEFAULT_GLOWUP_CONFIG_JSON.patches.markdownSyntax,
            thirdPartyToolRenderers:
                patches.thirdPartyToolRenderers ??
                DEFAULT_GLOWUP_CONFIG_JSON.patches.thirdPartyToolRenderers,
        },
    };
}

function parseGlowupConfigInput(
    input: unknown,
    options: {
        readonly source?: string;
        readonly reportWarning?: ConfigWarningReporter;
    },
): GlowupConfigInput {
    if (Schema.Check(GlowupConfigSchema, input)) {
        return Schema.Parse(GlowupConfigSchema, input);
    }

    options.reportWarning?.(
        `[pi-glowup] Ignoring invalid ${options.source ?? "config"}: ${configSchemaErrorSummary(input)}`,
    );
    return {};
}

function configSchemaErrorSummary(input: unknown): string {
    const [, errors] = Schema.Errors(GlowupConfigSchema, input);
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
        reportWarning(`[pi-glowup] Failed to create ${filePath}: ${message}`);
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
        reportWarning(`[pi-glowup] Failed to write ${filePath}: ${message}`);
    }
}

function readConfigInput(configPath: string, reportWarning: ConfigWarningReporter): unknown {
    if (!existsSync(configPath)) return undefined;

    try {
        const rawConfig: unknown = JSON.parse(readFileSync(configPath, "utf8"));
        return rawConfig;
    } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        reportWarning(`[pi-glowup] Failed to read ${configPath}: ${message}`);
        return undefined;
    }
}

function mergeConfigInputs(base: unknown, override: unknown): unknown {
    if (!isRecord(base) || !isRecord(override)) return override;

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
