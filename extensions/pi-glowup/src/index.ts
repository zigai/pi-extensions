import {
    isEditToolResult,
    isToolCallEventType,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    createCommandScriptFormatter,
    parseScriptFormatterCommands,
    type ScriptBlockFormatter,
    type ScriptFormatterCommands,
} from "./script-preview/formatters.ts";
import {
    getGlowupDiagnosticsDirectory,
    readGlowupConfig,
    type GlowupConfig,
} from "./config/config.ts";
import { DebugFileLogger, type DebugLogFields } from "./diagnostics/debug-logger.ts";
import { configureAssistantSeparatorPatch } from "./patches/assistant-separator.ts";
import { configureWorkingWidgetSpacingPatch } from "./patches/working-widget-spacing.ts";
import { configureAutocompleteCleanupPatch } from "./patches/autocomplete-cleanup.ts";
import {
    ExplorationGroupStore,
    type ExplorationRenderContext,
} from "./rendering/exploration-groups.ts";
import {
    configureRenderingAppearance,
    configureToolCallIndicator,
    emptyComponent,
    formatFindAction,
    formatGrepAction,
    formatLsAction,
    formatPathTarget,
    formatReadAction,
    makeComponent,
    parseDiffSections,
    parseScriptInvocation,
    renderGlowupCall,
    renderGlowupDiff,
    renderGlowupExplore,
    renderGlowupOutput,
    renderMutationCall,
    renderScriptCall,
    type GlowupRenderTheme,
    type FindActionArgs,
    type GrepActionArgs,
    type LsActionArgs,
    type MutationSummary,
    type ReadActionArgs,
    type ScriptPreviewHeaderLayout,
} from "./rendering/core.ts";
import { renderBashCommandCall } from "./rendering/bash-call.ts";
import { captureDeletedTextPreview, type DeletedTextPreview } from "./rendering/delete-preview.ts";
import {
    isActiveToolCall,
    shouldDeferSimpleToolCall,
    toolStatusLabel,
    type ToolLabelMode,
} from "./rendering/status-labels.ts";
import { buildEditPreview, EditPreviewStore } from "./rendering/edit-preview.ts";
import { summarizeEditCall } from "./rendering/edit-call-rendering.ts";
import {
    buildLargeDiffSummaryPayload,
    buildPierreDiffPayload,
    createEditSnapshot,
    type DiffRenderLimits,
    type EditSnapshotState,
} from "./diffs/diff.ts";
import type { PierreDiffPayload } from "./diffs/types.ts";
import {
    clearQueuedDiffHighlights,
    getPierreDiffPayloadFromDetails,
    pierreDiffHighlightStats,
    renderPierreDiff,
} from "./diffs/renderer.ts";
import {
    parsePreservedThirdPartyToolNames,
    type ThirdPartyToolRenderingOptions,
} from "./third-party-tools/renderers.ts";
import { parseScriptPreviewHeaderLayout } from "./script-preview/settings.ts";
import { boundedScriptPreview, createScriptPreviewStore } from "./script-preview/store.ts";
import {
    canonicalBuiltInToolName,
    compatBuiltInToolName,
    configureBuiltInToolRendererPatch,
    configureThirdPartyToolRendererPatch,
    toolRendererPatchStats,
    type BuiltInToolRendererOptions,
    type BuiltInToolName,
} from "./patches/tool-execution-patch.ts";
import { detectStructuredOutputLanguage } from "./syntax/code-component.ts";
import {
    disposeSyntaxHighlighting,
    configureSyntaxBracketPairColoring,
    initializeSyntaxHighlighting,
    isSyntaxHighlightingReady,
    refreshSyntaxHighlighting,
    syntaxHighlighterDiagnostics,
} from "./syntax/highlighter.ts";
import { configureMarkdownSyntaxPatch, markdownSyntaxPatchStats } from "./syntax/markdown-patch.ts";
import {
    renderSuccessfulWriteResultFallback,
    renderWriteCallPreview,
} from "./rendering/write-rendering.ts";
import {
    rememberRawScriptPreview,
    scheduleFormattedScriptPreview,
} from "./script-preview/events.ts";
import { StreamingScriptIdentityStore } from "./script-preview/streaming-identity.ts";
import type { MutationSettings } from "./mutations/settings.ts";
import { hasNonWhitespaceText } from "./text-boundaries.ts";
import { isRecord, stringField } from "./unknown-values.ts";

type TextResult = {
    readonly content?: unknown;
    readonly details?: unknown;
};

type BuiltInRenderTheme = Parameters<BuiltInToolRendererOptions["renderCall"]>[2];
type BuiltInRenderContext = Parameters<BuiltInToolRendererOptions["renderCall"]>[3];
type BuiltInResultOptions = Parameters<BuiltInToolRendererOptions["renderResult"]>[2];

const editPreviews = new EditPreviewStore(300);
const scriptPreviews = createScriptPreviewStore();
const explorationGroups = new ExplorationGroupStore();
const PARTIAL_BASH_COMMAND_PREVIEW_CHARS = 4_000;
const PRESERVE_TOOLS_ENV = "PI_GLOWUP_PRESERVE_TOOLS";
const SCRIPT_FORMATTERS_ENV = "PI_GLOWUP_SCRIPT_FORMATTERS";
const SCRIPT_HEADER_LAYOUT_ENV = "PI_GLOWUP_SCRIPT_HEADER_LAYOUT";
const MUTATION_LABEL_COLUMN_WIDTH = "Writing".length;
const ACTIVE_MUTATION_ALIGNMENT_KEY = "glowupActiveMutationAlignment";
const MUTATION_RESULT_RENDERED_KEY = "glowupMutationResultRendered";
const EXTENSION_LOADED_KEY = Symbol.for("zigai.pi-glowup.extension-loaded");
const builtInRenderCallCounts: Record<string, number> = {};
const builtInRenderResultCounts: Record<string, number> = {};
const streamingScriptIdentities = new StreamingScriptIdentityStore();
const bashRenderInvalidations = new Map<string, () => void>();
const MAX_BASH_RENDER_INVALIDATIONS = 300;

function rememberBashRenderInvalidation(
    toolCallId: string,
    invalidate: (() => void) | undefined,
): void {
    if (invalidate === undefined) return;
    bashRenderInvalidations.delete(toolCallId);
    bashRenderInvalidations.set(toolCallId, invalidate);
    while (bashRenderInvalidations.size > MAX_BASH_RENDER_INVALIDATIONS) {
        const oldest = bashRenderInvalidations.keys().next().value;
        if (typeof oldest !== "string") return;
        bashRenderInvalidations.delete(oldest);
    }
}

function recordBuiltInRender(kind: "call" | "result", toolName: BuiltInToolName): void {
    const counts = kind === "call" ? builtInRenderCallCounts : builtInRenderResultCounts;
    counts[toolName] = (counts[toolName] ?? 0) + 1;
}

function diagnosticSnapshot(): DebugLogFields {
    const memory = process.memoryUsage();
    const editStats = editPreviews.stats();
    const scriptStats = scriptPreviews.stats();
    const explorationStats = explorationGroups.stats();
    const diffStats = pierreDiffHighlightStats();
    const syntaxStats = syntaxHighlighterDiagnostics();
    const markdownStats = markdownSyntaxPatchStats();
    const rendererStats = toolRendererPatchStats();
    return {
        memory: {
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            heapTotalBytes: memory.heapTotal,
            externalBytes: memory.external,
            arrayBuffersBytes: memory.arrayBuffers,
        },
        stores: {
            editPreviewEntries: editStats.entries,
            editPreviewBytes: editStats.bytes,
            nativeEditSnapshots: nativeEditSnapshots.size,
            nativeEditPierrePayloads: nativeEditPierrePayloads.size,
            scriptPreviewEntries: scriptStats.entries,
            scriptPreviewBytes: scriptStats.bytes,
            explorationGroups: explorationStats.groups,
            explorationToolCalls: explorationStats.toolCalls,
        },
        syntax: {
            ready: isSyntaxHighlightingReady(),
            ...syntaxStats,
            markdownHighlightingEnabled: markdownStats.highlightingEnabled,
            markdownRenderPatchEnabled: markdownStats.renderPatchEnabled,
            markdownRenderInjections: markdownStats.renderInjections,
            markdownThemePatchAttempts: markdownStats.themePatchAttempts,
            markdownThemePatches: markdownStats.themePatches,
            markdownThemePatchHits: markdownStats.themePatchHits,
            markdownThemePatchFailures: markdownStats.themePatchFailures,
            markdownThinkingThemeSuppressions: markdownStats.thinkingThemeSuppressions,
            markdownThinkingThemeSuppressionFailures:
                markdownStats.thinkingThemeSuppressionFailures,
        },
        diffHighlights: {
            queuedHighlights: diffStats.queuedHighlights,
            activeTimers: diffStats.activeTimers,
            queueRunning: diffStats.queueRunning,
        },
        renderers: {
            builtInPatchEnabled: rendererStats.builtInPatchEnabled,
            thirdPartyPatchEnabled: rendererStats.thirdPartyPatchEnabled,
            thirdPartyRendererCacheEntries: rendererStats.thirdPartyRendererCacheEntries,
            builtInRenderCalls: { ...builtInRenderCallCounts },
            builtInRenderResults: { ...builtInRenderResultCounts },
        },
    };
}

function configDiagnostics(config: GlowupConfig): DebugLogFields {
    return {
        appearance: {
            diffBackgroundStyle: config.appearance.diffBackgroundStyle,
            diffLineNumberStyle: config.appearance.diffLineNumberStyle,
            narrowDiffLayout: config.appearance.narrowDiffLayout,
            sideBySideLayout: config.appearance.sideBySideLayout,
            customRowBackgrounds:
                config.appearance.addedRowBackground !== null ||
                config.appearance.deletedRowBackground !== null,
            customContentBackgrounds:
                config.appearance.addedContentBackground !== null ||
                config.appearance.deletedContentBackground !== null,
        },
        mutations: {
            defaultView: config.mutations.defaultView,
            previewLines: config.mutations.previewLines,
            ...config.mutations.limits,
        },
        debugLog: {
            enabled: config.debugLog.enabled,
            maxBytes: config.debugLog.maxBytes,
            memorySampleIntervalMs: config.debugLog.memorySampleIntervalMs,
        },
        scriptPreview: {
            headerLayout: config.scriptHeaderLayout,
            maxCodePreviewLines: config.scriptMaxCodePreviewLines,
            showPrologueOmission: config.scriptShowPrologueOmission,
            shellLayout: config.shellLayout,
            formatterCount: config.scriptFormatters.size,
        },
        toolLabels: {
            mode: config.toolLabels.mode,
        },
        writePreview: {
            movingViewport: config.writePreview.movingViewport,
        },
        syntax: {
            preloadLanguages: config.syntax.preloadLanguages,
            bracketPairColoring: config.syntax.bracketPairColoring,
            projectLanguageDetection: config.syntax.projectLanguageDetection.enabled,
        },
        patches: {
            assistantSeparator: config.patches.assistantSeparator,
            workingWidgetSpacing: config.patches.workingWidgetSpacing,
            autocompleteCleanup: config.patches.autocompleteCleanup,
            markdownSyntax: config.patches.markdownSyntax,
            thirdPartyToolRenderers: config.patches.thirdPartyToolRenderers,
        },
        preserveToolCount: config.preserveTools.length,
    };
}

function textOutput(result: TextResult): string | undefined {
    if (!Array.isArray(result.content)) {
        return undefined;
    }
    const content = result.content.find(
        (item) => isRecord(item) && item.type === "text" && typeof item.text === "string",
    );
    return isRecord(content) && typeof content.text === "string" ? content.text : undefined;
}

function syntaxPathFromToolArg(path: string | undefined): string | undefined {
    return path === undefined || path.length === 0 ? undefined : path;
}

function renderExplorationResult(
    result: TextResult,
    expanded: boolean,
    theme: GlowupRenderTheme,
    options?: { readonly syntaxPath: string | undefined },
) {
    const output = textOutput(result);
    if (output === undefined) {
        return emptyComponent();
    }
    return renderGlowupOutput(theme, output, {
        expanded,
        mode: "hidden",
        prefixFirst: "",
        prefixRest: "",
        noOutputLabel: null,
        ...(options?.syntaxPath === undefined ? {} : { syntax: { path: options.syntaxPath } }),
    });
}

function makeMutationSummary(options: {
    readonly label: string;
    readonly path: string;
    readonly added: number;
    readonly removed: number;
}): MutationSummary {
    return {
        label: options.label,
        path: options.path,
        added: options.added,
        removed: options.removed,
    };
}

type MutableRenderState = {
    [key: string]: unknown;
};

function isMutableRenderState(value: unknown): value is MutableRenderState {
    return isRecord(value);
}

function mutationLabelColumnWidth(
    context: BuiltInRenderContext,
    labelMode: ToolLabelMode,
): number | undefined {
    if (labelMode !== "lifecycle") {
        return undefined;
    }

    const state = isMutableRenderState(context.state) ? context.state : undefined;
    if (state === undefined) {
        return undefined;
    }

    if (context.isPartial) {
        state[ACTIVE_MUTATION_ALIGNMENT_KEY] = true;
        state[MUTATION_RESULT_RENDERED_KEY] = false;
    }

    if (
        state[ACTIVE_MUTATION_ALIGNMENT_KEY] === true &&
        state[MUTATION_RESULT_RENDERED_KEY] !== true
    ) {
        return MUTATION_LABEL_COLUMN_WIDTH;
    }

    return undefined;
}

function markMutationResultRendered(context: BuiltInRenderContext): void {
    const state = isMutableRenderState(context.state) ? context.state : undefined;
    if (state === undefined) {
        return;
    }

    const hadActiveMutationLayout = state[ACTIVE_MUTATION_ALIGNMENT_KEY] === true;
    if (!hadActiveMutationLayout) return;

    if (state[MUTATION_RESULT_RENDERED_KEY] !== true) {
        state[MUTATION_RESULT_RENDERED_KEY] = true;
        queueMicrotask(context.invalidate);
    }
}

function renderExplorationCall(
    theme: GlowupRenderTheme,
    context: ExplorationRenderContext,
    action: string,
    labelMode: ToolLabelMode,
) {
    const decision = explorationGroups.register(context, action);
    if (decision.kind === "child") {
        return emptyComponent();
    }
    return renderGlowupExplore(theme, decision.actions, {
        statusText: toolStatusLabel(
            labelMode,
            { isPartial: decision.active },
            { static: "Explore", active: "Exploring", completed: "Explored" },
        ),
        state: decision.active ? "running" : "muted",
    });
}

function registerExplorationBoundary(toolCallId: string): void {
    explorationGroups.registerBoundary(toolCallId);
}

function thirdPartyToolRenderingOptions(config: GlowupConfig): ThirdPartyToolRenderingOptions {
    const preservedFromEnv = process.env[PRESERVE_TOOLS_ENV];
    return {
        labelMode: config.toolLabels.mode,
        mutationSettings: config.mutations,
        preserveTools:
            preservedFromEnv === undefined
                ? config.preserveTools
                : parsePreservedThirdPartyToolNames(preservedFromEnv),
    };
}

function diffRenderLimits(settings: MutationSettings): DiffRenderLimits {
    return {
        maxBytes: settings.limits.maxDiffBytes,
        maxLines: settings.limits.maxDiffLines,
    };
}

function stringFieldFrom(args: unknown, keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = stringField(args, key);
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
}

function pathField(args: unknown): string | undefined {
    return stringFieldFrom(args, ["path", "file_path"]);
}

function commandField(args: unknown): string | undefined {
    return stringFieldFrom(args, ["command", "cmd"]);
}

function partialBashCommandPreview(command: string): string {
    if (command.length <= PARTIAL_BASH_COMMAND_PREVIEW_CHARS) {
        return command;
    }
    return `${command.slice(0, PARTIAL_BASH_COMMAND_PREVIEW_CHARS)}\n… command preview truncated while streaming`;
}

function numberField(args: unknown, key: string): number | undefined {
    if (!isRecord(args)) {
        return undefined;
    }
    const value = args[key];
    return typeof value === "number" ? value : undefined;
}

function normalizedWriteArgs(args: unknown): unknown {
    const path = pathField(args);
    const content = stringFieldFrom(args, ["content", "contents"]);
    return {
        ...(isRecord(args) ? args : {}),
        ...(path === undefined ? {} : { path }),
        ...(content === undefined ? {} : { content }),
    };
}

function replacementEditFromArgs(args: unknown): ReadonlyArray<Record<string, string>> | undefined {
    const oldText = stringFieldFrom(args, ["oldText", "old_string"]);
    const newText = stringFieldFrom(args, ["newText", "new_string"]);
    if (oldText === undefined || newText === undefined) {
        return undefined;
    }
    return [{ oldText, newText }];
}

function normalizedEditArgs(args: unknown): unknown {
    const path = pathField(args);
    const existingEdits = isRecord(args) && Array.isArray(args.edits) ? args.edits : undefined;
    const edits = existingEdits ?? replacementEditFromArgs(args);
    return {
        ...(isRecord(args) ? args : {}),
        ...(path === undefined ? {} : { path }),
        ...(edits === undefined ? {} : { edits }),
    };
}

function readActionArgs(args: unknown): ReadActionArgs {
    const path = pathField(args);
    const offset = numberField(args, "offset");
    const limit = numberField(args, "limit");
    return {
        ...(path === undefined ? {} : { path }),
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
    };
}

function findActionArgs(args: unknown): FindActionArgs {
    const pattern = stringFieldFrom(args, ["pattern", "glob"]);
    const path = pathField(args);
    const limit = numberField(args, "limit");
    return {
        ...(pattern === undefined ? {} : { pattern }),
        ...(path === undefined ? {} : { path }),
        ...(limit === undefined ? {} : { limit }),
    };
}

function grepActionArgs(args: unknown): GrepActionArgs {
    const pattern = stringFieldFrom(args, ["pattern", "query"]);
    const path = pathField(args);
    const glob = stringFieldFrom(args, ["glob", "include", "glob_filter"]);
    const limit = numberField(args, "limit");
    return {
        ...(pattern === undefined ? {} : { pattern }),
        ...(path === undefined ? {} : { path }),
        ...(glob === undefined ? {} : { glob }),
        ...(limit === undefined ? {} : { limit }),
    };
}

function lsActionArgs(args: unknown): LsActionArgs {
    const path = pathField(args);
    const limit = numberField(args, "limit");
    return {
        ...(path === undefined ? {} : { path }),
        ...(limit === undefined ? {} : { limit }),
    };
}

function webSearchQuery(args: unknown): string | undefined {
    return stringFieldFrom(args, ["query", "search_term"]);
}

function hasImageContent(result: TextResult): boolean {
    return (
        Array.isArray(result.content) &&
        result.content.some((item) => isRecord(item) && item.type === "image")
    );
}

function scriptFormatterCommands(
    config: GlowupConfig,
    reportWarning: (message: string) => void,
): ScriptFormatterCommands {
    const formattersFromEnv = process.env[SCRIPT_FORMATTERS_ENV];
    return formattersFromEnv === undefined
        ? config.scriptFormatters
        : parseScriptFormatterCommands(formattersFromEnv, {
              source: SCRIPT_FORMATTERS_ENV,
              reportWarning,
          });
}

function scriptBlockFormatter(
    config: GlowupConfig,
    reportWarning: (message: string) => void,
): ScriptBlockFormatter | undefined {
    return createCommandScriptFormatter(scriptFormatterCommands(config, reportWarning));
}

function scriptPreviewHeaderLayout(config: GlowupConfig): ScriptPreviewHeaderLayout {
    const headerLayoutFromEnv = process.env[SCRIPT_HEADER_LAYOUT_ENV];
    return headerLayoutFromEnv === undefined
        ? config.scriptHeaderLayout
        : parseScriptPreviewHeaderLayout(headerLayoutFromEnv);
}

function renderBuiltInToolCall(options: {
    readonly headerLayout: () => ScriptPreviewHeaderLayout;
    readonly maxCodePreviewLines: () => number;
    readonly showPrologueOmission: () => boolean;
    readonly shellLayout: () => GlowupConfig["shellLayout"];
    readonly labelMode: ToolLabelMode;
    readonly movingWriteViewport: boolean;
    readonly mutationSettings: MutationSettings;
    readonly recordRender: (kind: "call", toolName: BuiltInToolName) => void;
}): BuiltInToolRendererOptions["renderCall"] {
    return (toolName, args, theme, context) => {
        options.recordRender("call", toolName);
        switch (toolName) {
            case "read":
                if (shouldDeferSimpleToolCall(context)) return emptyComponent();
                return renderExplorationCall(
                    theme,
                    context,
                    formatReadAction(theme, readActionArgs(args)),
                    options.labelMode,
                );
            case "find":
                if (shouldDeferSimpleToolCall(context)) return emptyComponent();
                return renderExplorationCall(
                    theme,
                    context,
                    formatFindAction(theme, findActionArgs(args)),
                    options.labelMode,
                );
            case "grep":
                if (shouldDeferSimpleToolCall(context)) return emptyComponent();
                return renderExplorationCall(
                    theme,
                    context,
                    formatGrepAction(theme, grepActionArgs(args)),
                    options.labelMode,
                );
            case "ls":
                if (shouldDeferSimpleToolCall(context)) return emptyComponent();
                return renderExplorationCall(
                    theme,
                    context,
                    formatLsAction(theme, lsActionArgs(args)),
                    options.labelMode,
                );
            case "bash":
                return renderBashCall(
                    args,
                    theme,
                    context,
                    options.headerLayout,
                    options.maxCodePreviewLines,
                    options.showPrologueOmission,
                    options.shellLayout,
                );
            case "write":
                return renderWriteCall(args, theme, context, {
                    labelMode: options.labelMode,
                    movingViewport: options.movingWriteViewport,
                    mutationSettings: options.mutationSettings,
                });
            case "edit":
                return renderEditCall(args, theme, context, options.labelMode);
            case "delete":
                return renderDeleteCall(
                    args,
                    theme,
                    context,
                    options.labelMode,
                    options.mutationSettings,
                );
            case "webSearch":
                return renderWebSearchCall(args, theme, context, options.labelMode);
        }
    };
}

function renderBuiltInToolResult(settings: {
    readonly headerLayout: () => ScriptPreviewHeaderLayout;
    readonly mutationSettings: MutationSettings;
    readonly recordRender: (kind: "result", toolName: BuiltInToolName) => void;
}): BuiltInToolRendererOptions["renderResult"] {
    return (toolName, result, options, theme, context) => {
        settings.recordRender("result", toolName);
        switch (toolName) {
            case "read":
                return hasImageContent(result)
                    ? undefined
                    : renderExplorationResult(result, options.expanded, theme, {
                          syntaxPath: syntaxPathFromToolArg(pathField(context.args)),
                      });
            case "find":
            case "grep":
            case "ls":
                return renderExplorationResult(result, options.expanded, theme);
            case "bash":
                return renderBashResult(result, options, theme, context, settings.headerLayout);
            case "write":
                return renderWriteResult(
                    result,
                    options,
                    theme,
                    context,
                    settings.mutationSettings,
                );
            case "edit":
                return renderEditResult(result, options, theme, context, settings.mutationSettings);
            case "delete":
                return context.isError
                    ? renderGlowupOutput(theme, textOutput(result), {
                          expanded: options.expanded,
                          mode: "head",
                          maxPreviewLines: 5,
                      })
                    : emptyComponent();
            case "webSearch":
                return renderGlowupOutput(theme, textOutput(result), {
                    expanded: options.expanded,
                    mode: "head",
                    maxPreviewLines: 5,
                });
        }
    };
}

function callState(context: BuiltInRenderContext) {
    return context.isError ? "error" : isActiveToolCall(context) ? "running" : "success";
}

const nativeDeletePreviews = new Map<string, DeletedTextPreview>();
const nativeEditSnapshots = new Map<string, EditSnapshotState>();
const nativeEditPierrePayloads = new Map<string, PierreDiffPayload>();

function nativeEditPierrePayload(toolCallId: string): PierreDiffPayload | undefined {
    return nativeEditPierrePayloads.get(toolCallId);
}

async function captureNativeEditSnapshot(
    toolCallId: string,
    cwd: string,
    filePath: string | undefined,
    mutationSettings: MutationSettings,
): Promise<void> {
    if (nativeEditSnapshots.has(toolCallId) || filePath === undefined || filePath.length === 0) {
        return;
    }
    const snapshot = await createEditSnapshot(cwd, filePath, diffRenderLimits(mutationSettings));
    nativeEditSnapshots.set(toolCallId, snapshot);
    trimOldestMapEntries(nativeEditSnapshots, 300);
}

async function finishNativeEditSnapshot(
    toolCallId: string,
    isError: boolean,
    mutationSettings: MutationSettings,
): Promise<PierreDiffPayload | undefined> {
    const snapshot = nativeEditSnapshots.get(toolCallId);
    nativeEditSnapshots.delete(toolCallId);
    if (snapshot === undefined || isError) {
        return undefined;
    }
    const payload = buildPierreDiffPayload(
        await snapshot.finish(),
        diffRenderLimits(mutationSettings),
    );
    if (payload !== undefined) {
        nativeEditPierrePayloads.set(toolCallId, payload);
        trimOldestMapEntries(nativeEditPierrePayloads, 300);
    }
    return payload;
}

function trimOldestMapEntries<T>(entries: Map<string, T>, limit: number): void {
    while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (typeof oldest !== "string") {
            return;
        }
        entries.delete(oldest);
    }
}

function nativeDeletePreview(toolCallId: string): DeletedTextPreview | undefined {
    return nativeDeletePreviews.get(toolCallId);
}

function persistedDeletePreview(
    result: TextResult | undefined,
    filePath: string | undefined,
): DeletedTextPreview | undefined {
    if (filePath === undefined || !isRecord(result?.details)) return undefined;
    const diff = result.details.diff;
    if (typeof diff !== "string" || !hasNonWhitespaceText(diff)) return undefined;
    const normalized = diff.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
    const pathHeader = `${filePath}\n`;
    const body = normalized.startsWith(pathHeader)
        ? normalized.slice(pathHeader.length)
        : normalized;
    const section = parseDiffSections(body, filePath)[0];
    if (section === undefined || section.removed === 0) return undefined;
    return { section, removed: section.removed };
}

async function captureNativeDeletePreview(
    toolCallId: string,
    cwd: string,
    filePath: string | undefined,
    mutationSettings: MutationSettings,
): Promise<void> {
    if (nativeDeletePreviews.has(toolCallId) || filePath === undefined || filePath.length === 0) {
        return;
    }
    const preview = await captureDeletedTextPreview(
        cwd,
        filePath,
        mutationSettings.limits.maxDeletePreimageBytes,
    );
    if (preview !== undefined) {
        nativeDeletePreviews.set(toolCallId, preview);
        while (nativeDeletePreviews.size > 300) {
            const oldest = nativeDeletePreviews.keys().next().value;
            if (typeof oldest !== "string") {
                break;
            }
            nativeDeletePreviews.delete(oldest);
        }
    }
}

function renderDeleteCall(
    args: unknown,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    labelMode: ToolLabelMode,
    mutationSettings: MutationSettings,
) {
    registerExplorationBoundary(context.toolCallId);
    const filePath = pathField(args);
    const preview =
        nativeDeletePreview(context.toolCallId) ?? persistedDeletePreview(context.result, filePath);
    const header = renderGlowupCall(theme, {
        state: callState(context),
        statusText: toolStatusLabel(labelMode, context, {
            static: "Delete",
            active: "Deleting",
            completed: "Deleted",
        }),
        body: `${formatPathTarget(theme, filePath)}${preview === undefined || preview.removed === 0 ? "" : ` (${theme.fg("toolDiffRemoved", `-${preview.removed}`)})`}`,
    });
    if (preview === undefined || preview.section.lines.length === 0) {
        return header;
    }
    const showAllRows = context.expanded || mutationSettings.defaultView === "full";
    const body = renderGlowupDiff(theme, [preview.section], showAllRows, {
        collapsedLineBudget: mutationSettings.previewLines,
        ...(showAllRows ? {} : { maxWrappedRows: 1 }),
    });
    return makeComponent((width) => [...header.render(width), ...body.render(width)]);
}

function renderWebSearchCall(
    args: unknown,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    labelMode: ToolLabelMode,
) {
    registerExplorationBoundary(context.toolCallId);
    const query = webSearchQuery(args);
    const active = context.isPartial || !context.argsComplete;
    return renderGlowupCall(theme, {
        state: callState(context),
        statusText: toolStatusLabel(labelMode, context, {
            static: "Web Search",
            active: "Searching the web",
            completed: "Searched the web",
        }),
        ...(query === undefined
            ? {}
            : { body: labelMode === "lifecycle" && !active ? `for ${query}` : query }),
    });
}

function renderBashCall(
    args: unknown,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    headerLayout: () => ScriptPreviewHeaderLayout,
    maxCodePreviewLines: () => number,
    showPrologueOmission: () => boolean,
    shellLayout: () => GlowupConfig["shellLayout"],
) {
    registerExplorationBoundary(context.toolCallId);
    rememberBashRenderInvalidation(context.toolCallId, context.invalidate);
    const state = context.isError ? "error" : context.isPartial ? "running" : "success";
    const command = commandField(args) ?? "";
    if (
        shouldDeferSimpleToolCall(context) &&
        scriptPreviews.get(context.toolCallId) === undefined
    ) {
        const partialScript = streamingScriptIdentities.resolve(
            context.toolCallId,
            partialBashCommandPreview(command),
        );
        if (partialScript === undefined) {
            return emptyComponent();
        }
        return renderScriptCall(theme, partialScript, {
            state,
            expanded: false,
            maxCodePreviewLines: maxCodePreviewLines(),
            showPrologueOmission: showPrologueOmission(),
            headerLayout: headerLayout(),
            invalidate: context.invalidate,
        });
    }
    const displayCommand = context.argsComplete ? command : partialBashCommandPreview(command);
    const parsedScript = parseScriptInvocation(displayCommand);
    const script =
        scriptPreviews.get(context.toolCallId) ??
        (parsedScript === undefined ? undefined : boundedScriptPreview(parsedScript));
    const stableScript = context.argsComplete
        ? streamingScriptIdentities.finalize(context.toolCallId, script)
        : script;
    return renderBashCommandCall(theme, displayCommand, {
        state,
        expanded: context.expanded,
        maxCodePreviewLines: maxCodePreviewLines(),
        showPrologueOmission: showPrologueOmission(),
        headerLayout: headerLayout(),
        shellLayout: shellLayout(),
        ...(stableScript === undefined ? {} : { pureScriptOverride: stableScript }),
        ...(context.invalidate === undefined ? {} : { invalidate: context.invalidate }),
    });
}

function renderBashResult(
    result: TextResult,
    options: BuiltInResultOptions,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    headerLayout: () => ScriptPreviewHeaderLayout,
) {
    const output = textOutput(result);
    const language = detectStructuredOutputLanguage(output);
    const script = parseScriptInvocation(commandField(context.args));
    return renderGlowupOutput(theme, output, {
        expanded: options.expanded,
        mode: "headTail",
        maxPreviewLines: 5,
        ...(script !== undefined && headerLayout() === "block"
            ? { prefixFirst: theme.fg("dim", "  → "), prefixRest: "    " }
            : {}),
        ...(language === undefined ? {} : { syntax: { language } }),
    });
}

function renderWriteCall(
    args: unknown,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    options: {
        readonly labelMode: ToolLabelMode;
        readonly movingViewport: boolean;
        readonly mutationSettings: MutationSettings;
    },
) {
    registerExplorationBoundary(context.toolCallId);
    const labelColumnWidth = mutationLabelColumnWidth(context, options.labelMode);
    return renderWriteCallPreview(normalizedWriteArgs(args), theme, {
        ...context,
        labelMode: options.labelMode,
        movingViewport: options.movingViewport,
        mutationSettings: options.mutationSettings,
        ...(labelColumnWidth === undefined ? {} : { mutationLabelColumnWidth: labelColumnWidth }),
    });
}

function renderWriteResult(
    result: TextResult,
    options: BuiltInResultOptions,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    mutationSettings: MutationSettings,
) {
    if (!options.isPartial) {
        markMutationResultRendered(context);
    }

    const pierrePayload = !context.isError
        ? getPierreDiffPayloadFromDetails(result.details, diffRenderLimits(mutationSettings))
        : undefined;
    if (pierrePayload) {
        return renderPierreDiff(
            pierrePayload,
            theme,
            { expanded: options.expanded, mutationSettings },
            context,
        );
    }
    if (!context.isError) {
        const fallback = renderSuccessfulWriteResultFallback(normalizedWriteArgs(context.args));
        if (fallback !== undefined) {
            return fallback;
        }
    }
    return renderGlowupOutput(theme, textOutput(result), {
        expanded: options.expanded || (!context.isError && mutationSettings.defaultView === "full"),
        mode: "head",
        maxPreviewLines: 5,
    });
}

function renderEditCall(
    args: unknown,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    labelMode: ToolLabelMode,
) {
    registerExplorationBoundary(context.toolCallId);
    const labelColumnWidth = mutationLabelColumnWidth(context, labelMode);
    const cachedPreview = editPreviews.get(context.toolCallId);
    const resultDetails = context.result?.details;
    const preview =
        cachedPreview ??
        (isRecord(resultDetails) &&
        typeof resultDetails.diff === "string" &&
        hasNonWhitespaceText(resultDetails.diff)
            ? buildEditPreview({
                  path: pathField(args) ?? "",
                  diff: resultDetails.diff,
              })
            : undefined);
    if (!isActiveToolCall(context) && preview) {
        return renderMutationCall(
            theme,
            makeMutationSummary({
                label: labelMode === "lifecycle" ? "Edited" : "Edit",
                path: preview.path,
                added: preview.added,
                removed: preview.removed,
            }),
            {
                ...(labelColumnWidth === undefined ? {} : { labelColumnWidth }),
                state: "success",
            },
        );
    }

    const normalizedArgs = normalizedEditArgs(args);
    if (isActiveToolCall(context)) {
        return renderGlowupCall(theme, {
            state: "running",
            statusText: toolStatusLabel(labelMode, context, {
                static: "Edit",
                active: "Editing",
                completed: "Edited",
            }),
            body: formatPathTarget(theme, pathField(normalizedArgs)),
        });
    }

    const summary = summarizeEditCall(normalizedArgs, {
        ...context,
        labelMode,
    });
    const state = summary.hasInvalidEdits || context.isError ? "error" : "success";
    return renderGlowupCall(theme, {
        state,
        statusText: summary.statusText,
        body: `${formatPathTarget(theme, summary.path)}${summary.suffix}`,
    });
}

function renderEditResult(
    result: TextResult,
    options: BuiltInResultOptions,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    mutationSettings: MutationSettings,
) {
    if (!options.isPartial) {
        markMutationResultRendered(context);
    }

    const pierrePayload = !context.isError
        ? (nativeEditPierrePayload(context.toolCallId) ??
          getPierreDiffPayloadFromDetails(result.details, diffRenderLimits(mutationSettings)))
        : undefined;
    if (pierrePayload) {
        return renderPierreDiff(
            pierrePayload,
            theme,
            { expanded: options.expanded, mutationSettings },
            context,
        );
    }

    if (
        !context.isError &&
        isRecord(result.details) &&
        typeof result.details.diff === "string" &&
        hasNonWhitespaceText(result.details.diff)
    ) {
        const path = pathField(context.args);
        const summaryPayload = buildLargeDiffSummaryPayload(
            {
                path: path ?? "",
                diffText: result.details.diff,
            },
            diffRenderLimits(mutationSettings),
        );
        if (summaryPayload !== undefined) {
            return renderPierreDiff(
                summaryPayload,
                theme,
                { expanded: options.expanded, mutationSettings },
                context,
            );
        }
        const sections = parseDiffSections(result.details.diff, path);
        const showAllRows = options.expanded || mutationSettings.defaultView === "full";
        return renderGlowupDiff(theme, sections, showAllRows, {
            collapsedLineBudget: mutationSettings.previewLines,
            ...(showAllRows ? {} : { maxWrappedRows: 1 }),
        });
    }
    return renderGlowupOutput(theme, textOutput(result), {
        expanded: options.expanded || (!context.isError && mutationSettings.defaultView === "full"),
        mode: "head",
        maxPreviewLines: 5,
    });
}

type SyntaxHighlightingLifecycleOptions = {
    readonly config: GlowupConfig;
    readonly cwd: string | undefined;
    readonly reportWarning: (message: string) => void;
};

async function loadSyntaxHighlighting(
    loader: typeof initializeSyntaxHighlighting,
    options: SyntaxHighlightingLifecycleOptions,
): Promise<void> {
    try {
        await loader(process.env, {
            preloadLanguages: options.config.syntax.preloadLanguages,
            projectLanguageDetection: {
                enabled: options.config.syntax.projectLanguageDetection.enabled,
                ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            },
            reportWarning: options.reportWarning,
        });
    } catch (cause: unknown) {
        options.reportWarning(`[pi-glowup] Syntax preload failed: ${errorMessage(cause)}`);
    }
}

async function startSyntaxHighlighting(options: SyntaxHighlightingLifecycleOptions): Promise<void> {
    await loadSyntaxHighlighting(initializeSyntaxHighlighting, options);
}

async function restartSyntaxHighlighting(
    options: SyntaxHighlightingLifecycleOptions,
): Promise<void> {
    await loadSyntaxHighlighting(refreshSyntaxHighlighting, options);
}

function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

function clearSessionState(): void {
    nativeDeletePreviews.clear();
    nativeEditSnapshots.clear();
    nativeEditPierrePayloads.clear();
    editPreviews.clear();
    scriptPreviews.clear();
    bashRenderInvalidations.clear();
    streamingScriptIdentities.clear();
    explorationGroups.clear();
    clearQueuedDiffHighlights();
}

function valueKind(value: unknown): string {
    if (Array.isArray(value)) {
        return "array";
    }
    return value === null ? "null" : typeof value;
}

function textByteLength(text: string | undefined): number | undefined {
    return text === undefined ? undefined : Buffer.byteLength(text, "utf8");
}

function detailsDiagnostics(details: unknown): DebugLogFields {
    if (!isRecord(details)) {
        return { detailsKind: valueKind(details) };
    }
    const diff = details.diff;
    const pierreDiff = details.pierreDiff;
    return {
        detailsKind: "object",
        detailKeyCount: Object.keys(details).length,
        detailsDiffBytes: typeof diff === "string" ? Buffer.byteLength(diff, "utf8") : undefined,
        pierreDiffKind:
            isRecord(pierreDiff) && typeof pierreDiff.kind === "string"
                ? pierreDiff.kind
                : undefined,
    };
}

function diagnosticBuiltInToolName(toolName: string): BuiltInToolName | undefined {
    return canonicalBuiltInToolName(toolName);
}

function isExplorationToolName(toolName: string): boolean {
    const builtInToolName = diagnosticBuiltInToolName(toolName);
    return (
        builtInToolName === "read" ||
        builtInToolName === "find" ||
        builtInToolName === "grep" ||
        builtInToolName === "ls"
    );
}

function restoreExplorationGroupStarts(entries: readonly unknown[]): void {
    for (const entry of entries) {
        if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
        if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
        let previousWasExploration = false;
        for (const content of entry.message.content) {
            if (!isRecord(content) || content.type !== "toolCall") continue;
            const toolName = typeof content.name === "string" ? content.name : undefined;
            const toolCallId = typeof content.id === "string" ? content.id : undefined;
            const exploration = toolName !== undefined && isExplorationToolName(toolName);
            if (exploration && !previousWasExploration && toolCallId !== undefined) {
                explorationGroups.registerGroupStart(toolCallId);
            }
            previousWasExploration = exploration;
        }
    }
}

function hasVisibleAssistantText(message: unknown): boolean {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
        return false;
    }

    return message.content.some(
        (content) =>
            isRecord(content) &&
            content.type === "text" &&
            typeof content.text === "string" &&
            content.text.trim().length > 0,
    );
}

function refreshToolRows(context: Pick<ExtensionContext, "mode" | "ui">): void {
    if (context.mode === "tui") {
        context.ui.setToolsExpanded(context.ui.getToolsExpanded());
    }
}

export default async function glowupExtension(pi: ExtensionAPI): Promise<void> {
    // SAFETY: The symbol property is extension-private metadata on the concrete
    // ExtensionAPI object. It does not alter Pi's public API or handler semantics.
    const guardedPi = pi as ExtensionAPI & { [key: symbol]: boolean | undefined };
    if (guardedPi[EXTENSION_LOADED_KEY] === true) {
        return;
    }
    guardedPi[EXTENSION_LOADED_KEY] = true;

    const reportWarning = (message: string): void => console.warn(message);
    let config = readGlowupConfig({ reportWarning });
    const debugLogger = new DebugFileLogger({
        extensionDirectory: getGlowupDiagnosticsDirectory(),
        reportWarning,
    });
    debugLogger.configure(config.debugLog);
    let formatter = scriptBlockFormatter(config, reportWarning);
    let headerLayout = scriptPreviewHeaderLayout(config);
    let sessionGeneration = 0;

    const applyConfig = (nextConfig: GlowupConfig): void => {
        config = nextConfig;
        configureRenderingAppearance(config.appearance);
        configureToolCallIndicator(config.toolCallIndicator);
        debugLogger.configure(config.debugLog);
        formatter = scriptBlockFormatter(config, reportWarning);
        headerLayout = scriptPreviewHeaderLayout(config);
        configureAssistantSeparatorPatch(config.patches.assistantSeparator);
        configureWorkingWidgetSpacingPatch(config.patches.workingWidgetSpacing);
        configureAutocompleteCleanupPatch(config.patches.autocompleteCleanup);
        configureSyntaxBracketPairColoring(config.syntax.bracketPairColoring);
        configureMarkdownSyntaxPatch(config.patches.markdownSyntax);
        configureThirdPartyToolRendererPatch(
            true,
            config.patches.thirdPartyToolRenderers
                ? thirdPartyToolRenderingOptions(config)
                : { enabled: false },
        );
        configureBuiltInToolRendererPatch(true, {
            renderCall: renderBuiltInToolCall({
                headerLayout: () => headerLayout,
                maxCodePreviewLines: () => config.scriptMaxCodePreviewLines,
                showPrologueOmission: () => config.scriptShowPrologueOmission,
                shellLayout: () => config.shellLayout,
                labelMode: config.toolLabels.mode,
                movingWriteViewport: config.writePreview.movingViewport,
                mutationSettings: config.mutations,
                recordRender: recordBuiltInRender,
            }),
            renderResult: renderBuiltInToolResult({
                headerLayout: () => headerLayout,
                mutationSettings: config.mutations,
                recordRender: recordBuiltInRender,
            }),
        });
        debugLogger.record("config_applied", () => ({
            ...configDiagnostics(config),
            ...diagnosticSnapshot(),
        }));
    };

    await startSyntaxHighlighting({ config, cwd: process.cwd(), reportWarning });
    applyConfig(config);
    debugLogger.record("extension_loaded", diagnosticSnapshot);

    pi.on("tool_execution_start", (event) => {
        if (!isExplorationToolName(event.toolName)) {
            registerExplorationBoundary(event.toolCallId);
        }
    });

    pi.on("tool_call", (event, ctx) => {
        const command = commandField(event.input);
        const builtInToolName = diagnosticBuiltInToolName(event.toolName);
        const preimageCapture =
            builtInToolName === "edit"
                ? captureNativeEditSnapshot(
                      event.toolCallId,
                      ctx.cwd,
                      pathField(event.input),
                      config.mutations,
                  )
                : builtInToolName === "delete"
                  ? captureNativeDeletePreview(
                        event.toolCallId,
                        ctx.cwd,
                        pathField(event.input),
                        config.mutations,
                    )
                  : undefined;
        debugLogger.record("tool_call", () => ({
            toolName: event.toolName,
            builtInToolName: diagnosticBuiltInToolName(event.toolName),
            toolCallId: event.toolCallId,
            inputKind: valueKind(event.input),
            commandBytes: textByteLength(command),
            ...diagnosticSnapshot(),
        }));
        if (!isExplorationToolName(event.toolName)) {
            registerExplorationBoundary(event.toolCallId);
        }
        if (
            !isToolCallEventType("bash", event) &&
            compatBuiltInToolName(event.toolName) !== "bash"
        ) {
            return preimageCapture;
        }
        if (command !== undefined) {
            rememberRawScriptPreview(scriptPreviews, event.toolCallId, command);
            debugLogger.record("script_preview_remembered", () => ({
                toolCallId: event.toolCallId,
                commandBytes: textByteLength(command),
                ...diagnosticSnapshot(),
            }));
        }
        return preimageCapture;
    });

    pi.on("tool_result", async (event, ctx) => {
        let scheduledFormattedPreview = false;
        let storedEditPreview = false;
        let persistedEditPierrePayload: PierreDiffPayload | undefined;
        if (event.toolName === "bash" || compatBuiltInToolName(event.toolName) === "bash") {
            const command = commandField(event.input);
            if (command !== undefined) {
                const formatterGeneration = sessionGeneration;
                rememberRawScriptPreview(scriptPreviews, event.toolCallId, command);
                scheduleFormattedScriptPreview({
                    sink: scriptPreviews,
                    toolCallId: event.toolCallId,
                    command,
                    formatter,
                    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
                    isCurrent: () => sessionGeneration === formatterGeneration,
                    invalidate: () => {
                        bashRenderInvalidations.get(event.toolCallId)?.();
                        refreshToolRows(ctx);
                    },
                });
                scheduledFormattedPreview = formatter !== undefined;
            }
        }

        const rendersAsEdit =
            isEditToolResult(event) || compatBuiltInToolName(event.toolName) === "edit";
        if (rendersAsEdit) {
            persistedEditPierrePayload = await finishNativeEditSnapshot(
                event.toolCallId,
                event.isError === true,
                config.mutations,
            );
        }
        if (
            rendersAsEdit &&
            !event.isError &&
            isRecord(event.details) &&
            typeof event.details.diff === "string"
        ) {
            editPreviews.set(
                event.toolCallId,
                buildEditPreview({
                    path: pathField(event.input) ?? "",
                    diff: event.details.diff,
                }),
            );
            storedEditPreview = true;
        }

        const output = textOutput(event);
        debugLogger.record("tool_result", () => ({
            toolName: event.toolName,
            builtInToolName: diagnosticBuiltInToolName(event.toolName),
            toolCallId: event.toolCallId,
            isError: event.isError === true,
            outputTextBytes: textByteLength(output),
            scheduledFormattedPreview,
            storedEditPreview,
            ...detailsDiagnostics(event.details),
            ...diagnosticSnapshot(),
        }));
        if (persistedEditPierrePayload !== undefined) {
            return {
                details: {
                    ...(isRecord(event.details) ? event.details : {}),
                    pierreDiff: persistedEditPierrePayload,
                },
            };
        }
        return undefined;
    });

    pi.on("session_start", async (_event, ctx) => {
        sessionGeneration += 1;
        const nextConfig = readGlowupConfig(
            { cwd: ctx.cwd, reportWarning },
            { includeProjectConfig: ctx.isProjectTrusted() },
        );
        debugLogger.configure(nextConfig.debugLog);
        debugLogger.startMemorySampling(diagnosticSnapshot);
        debugLogger.record("session_start", () => ({
            phase: "before_reset",
            ...diagnosticSnapshot(),
        }));
        clearSessionState();
        restoreExplorationGroupStarts(ctx.sessionManager.getBranch());
        debugLogger.record("session_start", () => ({
            phase: "after_reset",
            ...diagnosticSnapshot(),
        }));
        await restartSyntaxHighlighting({ config: nextConfig, cwd: ctx.cwd, reportWarning });
        applyConfig(nextConfig);
        refreshToolRows(ctx);
        debugLogger.record("session_start", () => ({
            phase: "after_syntax",
            ...diagnosticSnapshot(),
        }));
    });

    pi.on("agent_start", () => {
        explorationGroups.closeActiveGroup();
    });

    pi.on("message_end", (event) => {
        if (hasVisibleAssistantText(event.message)) {
            explorationGroups.closeActiveGroup();
        }
    });

    pi.on("turn_start", () => {
        debugLogger.record("turn_start", diagnosticSnapshot);
    });

    pi.on("turn_end", () => {
        debugLogger.record("turn_end", diagnosticSnapshot);
    });

    pi.on("session_shutdown", async (event) => {
        sessionGeneration += 1;
        debugLogger.stopMemorySampling();
        debugLogger.record("session_shutdown", () => ({
            phase: "before_reset",
            ...diagnosticSnapshot(),
        }));
        clearSessionState();
        configureAssistantSeparatorPatch(false);
        configureWorkingWidgetSpacingPatch(false);
        configureAutocompleteCleanupPatch(false);
        configureMarkdownSyntaxPatch(false);
        configureThirdPartyToolRendererPatch(false);
        configureBuiltInToolRendererPatch(false);
        if (event.reason === "quit") {
            await disposeSyntaxHighlighting();
        }
        debugLogger.record("session_shutdown", () => ({
            phase: "after_reset",
            ...diagnosticSnapshot(),
        }));
        guardedPi[EXTENSION_LOADED_KEY] = false;
    });
}
