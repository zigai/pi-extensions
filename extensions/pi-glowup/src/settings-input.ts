import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";
import Type, { type StaticDecode } from "typebox";
import { DEFAULT_MUTATION_SETTINGS } from "./rendering/preview-settings.ts";

const DEFAULT_APPEARANCE = {
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
} as const;

const DEFAULT_DEBUG_LOG = {
    enabled: false,
    path: "debug.log",
    maxBytes: null,
    memorySampleIntervalMs: 10_000,
} as const;

const DEFAULT_RENDER_CACHE = {
    maxBytes: 64 * 1024 * 1024,
    maxEntries: 10_000,
} as const;

const DEFAULT_TOOL_CALL_INDICATOR = {
    symbol: "•",
    bold: true,
} as const;

const DEFAULT_TOOL_LABELS = {
    mode: "static",
} as const;

const DEFAULT_WRITE_PREVIEW = {
    movingViewport: true,
} as const;

const DEFAULT_SYNTAX = {
    preloadLanguages: ["markdown", "bash", "python", "typescript", "javascript", "json"],
    bracketPairColoring: true,
    projectLanguageDetection: {
        enabled: true,
    },
} as const;

const DEFAULT_PATCHES = {
    assistantSeparator: true,
    workingWidgetSpacing: false,
    autocompleteCleanup: true,
    markdownSyntax: true,
    thirdPartyToolRenderers: true,
} as const;

const DEFAULT_SCRIPT_PREVIEW = {
    maxCodePreviewLines: 8,
    showPrologueOmission: false,
    shellLayout: "auto",
    shellOperatorPosition: "trailing",
    shellOutputStyle: "terminal",
    formatters: {},
} as const;

const streamingSchema = Type.Object(
    {
        prose: Type.Union(
            [Type.Literal("token"), Type.Literal("sentence"), Type.Literal("paragraph")],
            {
                default: "token",
                description:
                    "Reveal assistant/thinking prose and declared generated tool previews as tokens, completed sentences, or Markdown paragraphs and list items. Completed content blocks always reveal their remaining tail.",
            },
        ),
        code: Type.Union(
            [Type.Literal("token"), Type.Literal("statement"), Type.Literal("block")],
            {
                default: "token",
                description:
                    "Reveal generated code in assistant/thinking Markdown, writes, and script/protocol previews as tokens, completed statements, or whole blocks. Statement mode supports JavaScript, TypeScript, Python, and Bash; unknown languages and indented code wait for completion. Configured formatters format each statement separately in both views. Diffs, ordinary tool output, and the user shell are unchanged.",
            },
        ),
    },
    { additionalProperties: false, default: { prose: "token", code: "token" } },
);

const HEX_COLOR_PATTERN = "^#[0-9A-Fa-f]{6}$";

function optionalHexColor(description: string) {
    return Type.Union([Type.String({ pattern: HEX_COLOR_PATTERN }), Type.Null()], {
        description,
    });
}

function optionalPositiveInteger(description: string) {
    return Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], { description });
}

const mutationLimitsSchema = Type.Object(
    {
        maxDiffBytes: optionalPositiveInteger(
            "Maximum combined diff snapshot or metadata bytes; null disables this limit.",
        ),
        maxDiffLines: optionalPositiveInteger(
            "Maximum diff rows before rendering a summary; null disables this limit.",
        ),
        maxWritePreviewBytes: optionalPositiveInteger(
            "Maximum native-write content bytes retained for rendering; null disables this limit.",
        ),
        maxDeletePreimageBytes: optionalPositiveInteger(
            "Maximum file bytes captured before deletion; null disables this limit.",
        ),
    },
    {
        additionalProperties: false,
        default: DEFAULT_MUTATION_SETTINGS.limits,
    },
);

const mutationsSchema = Type.Object(
    {
        defaultView: Type.Union([Type.Literal("full"), Type.Literal("preview")], {
            description:
                "Show every available completed-mutation row or a bounded semantic preview.",
        }),
        previewLines: Type.Integer({
            minimum: 1,
            description: "Changed/content rows retained per file in preview view.",
        }),
        limits: mutationLimitsSchema,
    },
    {
        additionalProperties: false,
        default: DEFAULT_MUTATION_SETTINGS,
    },
);

const appearanceSchema = Type.Object(
    {
        diffBackgroundStyle: Type.Union(
            [Type.Literal("changed-spans"), Type.Literal("two-tone"), Type.Literal("full-row")],
            {
                description: "Background treatment for changed diff rows and intraline spans.",
            },
        ),
        diffLineNumberStyle: Type.Union([Type.Literal("single"), Type.Literal("dual")], {
            description:
                "Show one relevant line number or aligned old and new line-number columns.",
        }),
        narrowDiffLayout: Type.Union([Type.Literal("paired"), Type.Literal("traditional")], {
            description: "Order similar deletion/addition rows together or in traditional blocks.",
        }),
        sideBySideLayout: Type.Union([Type.Literal("content-aware"), Type.Literal("fixed")], {
            description: "Choose split diffs from content fit or a fixed terminal-width threshold.",
        }),
        addedRowBackground: optionalHexColor(
            "Subtle addition-row background; null derives it from the active Pi theme.",
        ),
        deletedRowBackground: optionalHexColor(
            "Subtle deletion-row background; null derives it from the active Pi theme.",
        ),
        addedContentBackground: optionalHexColor(
            "Stronger added intraline-span background; null derives a contrasting shade.",
        ),
        deletedContentBackground: optionalHexColor(
            "Stronger deleted intraline-span background; null derives a contrasting shade.",
        ),
        instructionPathColor: optionalHexColor(
            "Instruction-file path foreground; null inherits the active Pi theme.",
        ),
        dimUnchangedDiffText: Type.Boolean({
            description: "Dim unchanged text around changed intraline spans.",
        }),
    },
    {
        additionalProperties: false,
        default: DEFAULT_APPEARANCE,
    },
);

const debugLogSchema = Type.Object(
    {
        enabled: Type.Boolean({
            description: "Write bounded renderer and lifecycle diagnostics.",
        }),
        path: Type.String({
            minLength: 1,
            description:
                "Diagnostics path relative to the pi-glowup data directory unless absolute.",
        }),
        maxBytes: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
            description: "Rotate diagnostics after this size; null disables rotation.",
        }),
        memorySampleIntervalMs: Type.Integer({
            minimum: 0,
            description: "Memory sampling interval; 0 disables sampling.",
        }),
    },
    {
        additionalProperties: false,
        default: DEFAULT_DEBUG_LOG,
    },
);

const renderCacheSchema = Type.Object(
    {
        maxBytes: Type.Integer({
            minimum: 64 * 1024,
            maximum: 512 * 1024 * 1024,
            description: "Maximum bytes retained for completed rendered tool output.",
        }),
        maxEntries: Type.Integer({
            minimum: 1,
            maximum: 100_000,
            description: "Maximum completed tool components retained in the render cache.",
        }),
    },
    {
        additionalProperties: false,
        default: DEFAULT_RENDER_CACHE,
    },
);

const toolCallIndicatorSchema = Type.Object(
    {
        symbol: Type.String({
            minLength: 1,
            maxLength: 8,
            pattern: "\\S",
            description: "Prefix shown before compact tool calls.",
        }),
        bold: Type.Boolean({ description: "Render the tool-call indicator in bold." }),
    },
    {
        additionalProperties: false,
        default: DEFAULT_TOOL_CALL_INDICATOR,
    },
);

const toolLabelsSchema = Type.Object(
    {
        mode: Type.Union([Type.Literal("static"), Type.Literal("lifecycle")], {
            description: "Use stable or lifecycle-aware tool labels.",
        }),
    },
    {
        additionalProperties: false,
        default: DEFAULT_TOOL_LABELS,
    },
);

const writePreviewSchema = Type.Object(
    {
        movingViewport: Type.Boolean({
            description: "Follow the newest rows while writes stream.",
        }),
    },
    {
        additionalProperties: false,
        default: DEFAULT_WRITE_PREVIEW,
    },
);

const syntaxSchema = Type.Object(
    {
        preloadLanguages: Type.Array(Type.String(), {
            description: "Language ids or aliases to preload for synchronous syntax highlighting.",
        }),
        bracketPairColoring: Type.Boolean({
            description: "Color matching bracket pairs; false preserves the syntax theme color.",
        }),
        projectLanguageDetection: Type.Object(
            {
                enabled: Type.Boolean({
                    description:
                        "Add languages inferred from project filenames to the preload set.",
                }),
            },
            {
                additionalProperties: false,
                default: DEFAULT_SYNTAX.projectLanguageDetection,
            },
        ),
    },
    {
        additionalProperties: false,
        default: DEFAULT_SYNTAX,
    },
);

const patchesSchema = Type.Object(
    {
        assistantSeparator: Type.Boolean({
            description: "Add spacing and separators around assistant messages.",
        }),
        workingWidgetSpacing: Type.Boolean({
            description: "Remove one blank line near the working indicator.",
        }),
        autocompleteCleanup: Type.Boolean({
            description: "Redraw after slash autocomplete closes.",
        }),
        markdownSyntax: Type.Boolean({
            description: "Highlight Markdown code fences.",
        }),
        thirdPartyToolRenderers: Type.Boolean({
            description: "Apply compact renderers to compatible third-party tools.",
        }),
    },
    {
        additionalProperties: false,
        default: DEFAULT_PATCHES,
    },
);

const formatterCommandSchema = Type.Array(Type.String({ minLength: 1, pattern: "^[^\\u0000]+$" }), {
    minItems: 1,
    description: "Executable followed by arguments; no shell expansion is performed.",
});

const formatterImportsSchema = Type.Optional(
    Type.Union([Type.Literal("show"), Type.Literal("omit")], {
        description:
            "Leading import/setup visibility in collapsed display; expansion retains all source.",
        default: "omit",
    }),
);

const javascriptFormatterProperties = {
    command: formatterCommandSchema,
    imports: formatterImportsSchema,
    tabWidth: Type.Optional(
        Type.Integer({ minimum: 1, default: 2, description: "Oxfmt indentation width." }),
    ),
    objectWrap: Type.Optional(
        Type.Union([Type.Literal("collapse"), Type.Literal("preserve")], {
            default: "collapse",
            description: "Collapse object literals when they fit the actual content width.",
        }),
    ),
};

export const scriptFormatterProfileSchema = Type.Union([
    Type.Object(
        {
            kind: Type.Literal("command", {
                description: "Run custom argv without generated formatter configuration.",
            }),
            command: formatterCommandSchema,
        },
        { additionalProperties: false, title: "CommandFormatter" },
    ),
    Type.Object(
        {
            kind: Type.Literal("python", { description: "Use Tuff's Python formatter." }),
            command: formatterCommandSchema,
            imports: formatterImportsSchema,
            indentWidth: Type.Optional(
                Type.Integer({ minimum: 1, default: 4, description: "Python indentation width." }),
            ),
            collections: Type.Optional(
                Type.Union([Type.Literal("fill"), Type.Literal("ruff-default")], {
                    default: "ruff-default",
                    description:
                        "Collapse collections that fit; fill instead packs items within multiline brackets.",
                }),
            ),
            magicTrailingComma: Type.Optional(
                Type.Boolean({
                    default: false,
                    description: "Treat trailing commas as requests for vertical expansion.",
                }),
            ),
        },
        { additionalProperties: false, title: "PythonFormatter" },
    ),
    Type.Object(
        {
            kind: Type.Literal("javascript", { description: "Use Oxfmt's JavaScript parser." }),
            ...javascriptFormatterProperties,
        },
        { additionalProperties: false, title: "JavaScriptFormatter" },
    ),
    Type.Object(
        {
            kind: Type.Literal("typescript", { description: "Use Oxfmt's TypeScript parser." }),
            ...javascriptFormatterProperties,
        },
        { additionalProperties: false, title: "TypeScriptFormatter" },
    ),
    Type.Object(
        {
            kind: Type.Literal("bash", {
                description: "Use shfmt's Bash formatter without minification.",
            }),
            command: formatterCommandSchema,
            indentWidth: Type.Optional(
                Type.Integer({ minimum: 1, default: 2, description: "Bash indentation width." }),
            ),
            caseIndent: Type.Optional(
                Type.Boolean({ default: true, description: "Indent Bash case arms." }),
            ),
            spaceRedirects: Type.Optional(
                Type.Boolean({
                    default: true,
                    description: "Separate redirect operators from targets.",
                }),
            ),
            binaryNextLine: Type.Optional(
                Type.Boolean({
                    default: false,
                    description: "Start continued Bash chains with their operator.",
                }),
            ),
        },
        { additionalProperties: false, title: "BashFormatter" },
    ),
]);

export type ScriptFormatterProfile = StaticDecode<typeof scriptFormatterProfileSchema>;

const scriptPreviewSchema = Type.Object(
    {
        maxCodePreviewLines: Type.Integer({
            minimum: 4,
            description: "Collapsed script content rows before a separate omission row.",
        }),
        showPrologueOmission: Type.Boolean({
            description: "Show a count row when collapsed previews omit leading setup imports.",
        }),
        shellLayout: Type.Union(
            [Type.Literal("preserve"), Type.Literal("auto"), Type.Literal("always")],
            {
                description:
                    "Choose when composed Bash commands are reflowed at safe syntax boundaries.",
            },
        ),
        shellOperatorPosition: Type.Union([Type.Literal("trailing"), Type.Literal("leading")], {
            description: "Place Bash chain operators before or after reflowed line breaks.",
        }),
        shellOutputStyle: Type.Union([Type.Literal("terminal"), Type.Literal("gutter")], {
            description:
                "Show Bash command output flush left like a terminal, or behind a dim │ gutter.",
        }),
        formatters: Type.Record(Type.String(), scriptFormatterProfileSchema, {
            description:
                "Display-only profiles keyed by language id; statement mode formats each unit in both views, otherwise expansion shows original source.",
        }),
    },
    {
        additionalProperties: false,
        default: DEFAULT_SCRIPT_PREVIEW,
    },
);

export const settingsSchema = Type.Object(
    {
        presentation: Type.String({
            default: "compact",
            minLength: 1,
            description:
                "Whole tool presentation: compact, outline, or an extension-registered name.",
        }),
        preserveTools: Type.Array(Type.String(), {
            default: [],
            description: "Keep selected third-party tools on their original renderer.",
        }),
        mutations: mutationsSchema,
        appearance: appearanceSchema,
        debugLog: debugLogSchema,
        renderCache: renderCacheSchema,
        toolCallIndicator: toolCallIndicatorSchema,
        toolLabels: toolLabelsSchema,
        writePreview: writePreviewSchema,
        syntax: syntaxSchema,
        patches: patchesSchema,
        scriptPreview: scriptPreviewSchema,
        streaming: streamingSchema,
    },
    { additionalProperties: false },
);

export type ExtensionSettings = StaticDecode<typeof settingsSchema>;

export const extensionSettingsInput = {
    id: "pi-glowup",
    title: "Pi Glowup",
    description: "High-signal rendering for Pi tool calls and results.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-glowup/config.schema.json",
    schema: settingsSchema,
    exampleSettings: {
        streaming: { prose: "paragraph", code: "statement" },
        scriptPreview: {
            formatters: {
                javascript: { kind: "javascript", command: ["oxfmt"], objectWrap: "collapse" },
                python: { kind: "python", command: ["tuff"], collections: "ruff-default" },
            },
        },
    },
} as const satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;

export default extensionSettingsInput;
