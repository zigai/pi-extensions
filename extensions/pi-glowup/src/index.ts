import {
    isEditToolResult,
    isToolCallEventType,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
    createCommandScriptFormatter,
    parseScriptFormatterCommands,
    type ScriptBlockFormatter,
    type ScriptFormatterCommands,
} from "./script-formatters.ts";
import { readCodexLookConfig, type CodexLookConfig } from "./config.ts";
import { configureAssistantSeparatorPatch } from "./assistant-separator.ts";
import { configureWorkingWidgetSpacingPatch } from "./working-widget-spacing.ts";
import { configureAutocompleteCleanupPatch } from "./autocomplete-cleanup.ts";
import { ExplorationGroupStore, type ExplorationRenderContext } from "./exploration-groups.ts";
import {
    emptyComponent,
    formatFindAction,
    formatGrepAction,
    formatLsAction,
    formatPathTarget,
    formatReadAction,
    parseDiffSections,
    parseScriptInvocation,
    renderCodexCall,
    renderCodexDiff,
    renderCodexExplore,
    renderCodexOutput,
    renderMutationCall,
    renderScriptCall,
    type CodexRenderTheme,
    type FindActionArgs,
    type GrepActionArgs,
    type LsActionArgs,
    type MutationSummary,
    type ReadActionArgs,
    type ScriptPreviewHeaderLayout,
} from "./rendering.ts";
import { buildEditPreview, EditPreviewStore } from "./edit-preview.ts";
import { summarizeEditCall } from "./edit-call-rendering.ts";
import { buildLargeDiffSummaryPayload } from "./pierre-diff.ts";
import {
    clearQueuedDiffHighlights,
    getPierreDiffPayloadFromDetails,
    pierreDiffHighlightStats,
    renderPierreDiff,
} from "./pierre-diff-renderer.ts";
import {
    parsePreservedThirdPartyToolNames,
    type ThirdPartyToolRenderingOptions,
} from "./third-party-renderers.ts";
import { parseScriptPreviewHeaderLayout } from "./script-preview-settings.ts";
import { boundedScriptPreview, createScriptPreviewStore } from "./script-preview-store.ts";
import {
    compatBuiltInToolName,
    configureBuiltInToolRendererPatch,
    configureThirdPartyToolRendererPatch,
    type BuiltInToolRendererOptions,
} from "./tool-execution-patch.ts";
import { detectStructuredOutputLanguage } from "./syntax/code-component.ts";
import { disposeSyntaxHighlighting, initializeSyntaxHighlighting } from "./syntax/highlighter.ts";
import { configureMarkdownSyntaxPatch } from "./syntax/markdown-patch.ts";
import { renderSuccessfulWriteResultFallback, renderWriteCallPreview } from "./write-rendering.ts";
import {
    rememberRawScriptPreview,
    scheduleFormattedScriptPreview,
} from "./script-preview-events.ts";

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
const PRESERVE_TOOLS_ENV = "PI_CODEX_LOOK_PRESERVE_TOOLS";
const SCRIPT_FORMATTERS_ENV = "PI_CODEX_LOOK_SCRIPT_FORMATTERS";
const SCRIPT_HEADER_LAYOUT_ENV = "PI_CODEX_LOOK_SCRIPT_HEADER_LAYOUT";
const MEMORY_LOG_ENV = "PI_CODEX_LOOK_MEMORY_LOG";
const MUTATION_LABEL_COLUMN_WIDTH = "Writing".length;
const ACTIVE_MUTATION_ALIGNMENT_KEY = "codexLookActiveMutationAlignment";
const MUTATION_RESULT_RENDERED_KEY = "codexLookMutationResultRendered";
const EXTENSION_LOADED_KEY = Symbol.for("zigai.pi-codex-look.extension-loaded");

function textOutput(result: TextResult): string | undefined {
    if (!Array.isArray(result.content)) {
        return undefined;
    }
    const content = result.content.find(
        (item) => isRecord(item) && item.type === "text" && typeof item.text === "string",
    );
    return isRecord(content) && typeof content.text === "string" ? content.text : undefined;
}

function hasNonWhitespaceText(text: string): boolean {
    for (let index = 0; index < text.length; index += 1) {
        const charCode = text.charCodeAt(index);
        if (
            charCode !== 9 &&
            charCode !== 10 &&
            charCode !== 11 &&
            charCode !== 12 &&
            charCode !== 13 &&
            charCode !== 32
        ) {
            return true;
        }
    }
    return false;
}

function syntaxPathFromToolArg(path: string | undefined): string | undefined {
    return path === undefined || path.length === 0 ? undefined : path;
}

function renderExplorationResult(
    result: TextResult,
    expanded: boolean,
    theme: CodexRenderTheme,
    options?: { readonly syntaxPath: string | undefined },
) {
    const output = textOutput(result);
    if (output === undefined) {
        return emptyComponent();
    }
    return renderCodexOutput(theme, output, {
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MutableRenderState = {
    [key: string]: unknown;
};

function isMutableRenderState(value: unknown): value is MutableRenderState {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mutationLabelColumnWidth(
    context: BuiltInRenderContext,
    dynamicStatusLabels: boolean,
): number | undefined {
    if (!dynamicStatusLabels) {
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

function markMutationResultRendered(
    context: BuiltInRenderContext,
    dynamicStatusLabels: boolean,
): void {
    if (!dynamicStatusLabels) {
        return;
    }

    const state = isMutableRenderState(context.state) ? context.state : undefined;
    if (state?.[ACTIVE_MUTATION_ALIGNMENT_KEY] !== true) {
        return;
    }

    if (state[MUTATION_RESULT_RENDERED_KEY] !== true) {
        state[MUTATION_RESULT_RENDERED_KEY] = true;
        context.invalidate();
    }
}

function renderExplorationCall(
    theme: CodexRenderTheme,
    context: ExplorationRenderContext,
    action: string,
) {
    const decision = explorationGroups.register(context, action);
    if (decision.kind === "child") {
        return emptyComponent();
    }
    return renderCodexExplore(theme, decision.actions);
}

function closeExplorationGroup(): void {
    explorationGroups.closeActiveGroup();
}

function thirdPartyToolRenderingOptions(config: CodexLookConfig): ThirdPartyToolRenderingOptions {
    const preservedFromEnv = process.env[PRESERVE_TOOLS_ENV];
    return {
        preserveTools:
            preservedFromEnv === undefined
                ? config.preserveTools
                : parsePreservedThirdPartyToolNames(preservedFromEnv),
    };
}

function stringField(args: unknown, key: string): string | undefined {
    if (!isRecord(args)) {
        return undefined;
    }
    const value = args[key];
    return typeof value === "string" ? value : undefined;
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
    config: CodexLookConfig,
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
    config: CodexLookConfig,
    reportWarning: (message: string) => void,
): ScriptBlockFormatter | undefined {
    return createCommandScriptFormatter(scriptFormatterCommands(config, reportWarning));
}

function scriptPreviewHeaderLayout(config: CodexLookConfig): ScriptPreviewHeaderLayout {
    const headerLayoutFromEnv = process.env[SCRIPT_HEADER_LAYOUT_ENV];
    return headerLayoutFromEnv === undefined
        ? config.scriptHeaderLayout
        : parseScriptPreviewHeaderLayout(headerLayoutFromEnv);
}

function renderBuiltInToolCall(options: {
    readonly headerLayout: () => ScriptPreviewHeaderLayout;
    readonly dynamicStatusLabels: boolean;
}): BuiltInToolRendererOptions["renderCall"] {
    return (toolName, args, theme, context) => {
        switch (toolName) {
            case "read":
                return renderExplorationCall(
                    theme,
                    context,
                    formatReadAction(theme, readActionArgs(args)),
                );
            case "find":
                return renderExplorationCall(
                    theme,
                    context,
                    formatFindAction(theme, findActionArgs(args)),
                );
            case "grep":
                return renderExplorationCall(
                    theme,
                    context,
                    formatGrepAction(theme, grepActionArgs(args)),
                );
            case "ls":
                return renderExplorationCall(
                    theme,
                    context,
                    formatLsAction(theme, lsActionArgs(args)),
                );
            case "bash":
                return renderBashCall(args, theme, context, options.headerLayout);
            case "write":
                return renderWriteCall(args, theme, context, options.dynamicStatusLabels);
            case "edit":
                return renderEditCall(args, theme, context, options.dynamicStatusLabels);
            case "delete":
                return renderDeleteCall(args, theme, context);
            case "webSearch":
                return renderWebSearchCall(args, theme, context);
        }
    };
}

function renderBuiltInToolResult(settings: {
    readonly headerLayout: () => ScriptPreviewHeaderLayout;
    readonly dynamicStatusLabels: boolean;
}): BuiltInToolRendererOptions["renderResult"] {
    return (toolName, result, options, theme, context) => {
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
                    settings.dynamicStatusLabels,
                );
            case "edit":
                return renderEditResult(
                    result,
                    options,
                    theme,
                    context,
                    settings.dynamicStatusLabels,
                );
            case "delete":
            case "webSearch":
                return renderCodexOutput(theme, textOutput(result), {
                    expanded: options.expanded,
                    mode: "head",
                    maxPreviewLines: 5,
                });
        }
    };
}

function callState(context: BuiltInRenderContext) {
    return context.isError ? "error" : context.isPartial ? "muted" : "success";
}

function renderDeleteCall(args: unknown, theme: BuiltInRenderTheme, context: BuiltInRenderContext) {
    closeExplorationGroup();
    return renderCodexCall(theme, {
        state: callState(context),
        statusText: "Delete",
        body: formatPathTarget(theme, pathField(args)),
    });
}

function renderWebSearchCall(
    args: unknown,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
) {
    closeExplorationGroup();
    const query = webSearchQuery(args);
    return renderCodexCall(theme, {
        state: callState(context),
        statusText: "Web Search",
        ...(query === undefined ? {} : { body: query }),
    });
}

function renderBashCall(
    args: unknown,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    headerLayout: () => ScriptPreviewHeaderLayout,
) {
    closeExplorationGroup();
    const state = context.isError ? "error" : context.isPartial ? "running" : "success";
    const command = commandField(args) ?? "";
    if (context.isPartial && scriptPreviews.get(context.toolCallId) === undefined) {
        return renderScriptCall(
            theme,
            {
                label: "Bash",
                language: "bash",
                code: partialBashCommandPreview(command),
            },
            {
                state,
                expanded: false,
                maxCodePreviewLines: 3,
                headerLayout: headerLayout(),
            },
        );
    }
    const parsedScript = parseScriptInvocation(
        context.expanded ? command : partialBashCommandPreview(command),
    );
    const script =
        scriptPreviews.get(context.toolCallId) ??
        (context.expanded
            ? (parsedScript ?? {
                  label: "Bash",
                  language: "bash",
                  code: command,
              })
            : boundedScriptPreview(
                  parsedScript ?? {
                      label: "Bash",
                      language: "bash",
                      code: partialBashCommandPreview(command),
                  },
              ));
    return renderScriptCall(theme, script, {
        state,
        expanded: context.expanded,
        maxCodePreviewLines: script.language === "bash" ? 3 : 8,
        headerLayout: headerLayout(),
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
    return renderCodexOutput(theme, output, {
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
    dynamicStatusLabels: boolean,
) {
    closeExplorationGroup();
    const labelColumnWidth = mutationLabelColumnWidth(context, dynamicStatusLabels);
    return renderWriteCallPreview(normalizedWriteArgs(args), theme, {
        ...context,
        dynamicStatusLabels,
        ...(labelColumnWidth === undefined ? {} : { mutationLabelColumnWidth: labelColumnWidth }),
    });
}

function renderWriteResult(
    result: TextResult,
    options: BuiltInResultOptions,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    dynamicStatusLabels: boolean,
) {
    if (!options.isPartial) {
        markMutationResultRendered(context, dynamicStatusLabels);
    }

    const pierrePayload = !context.isError
        ? getPierreDiffPayloadFromDetails(result.details)
        : undefined;
    if (pierrePayload) {
        return renderPierreDiff(pierrePayload, theme, { expanded: options.expanded }, context);
    }
    if (!context.isError) {
        const fallback = renderSuccessfulWriteResultFallback(normalizedWriteArgs(context.args));
        if (fallback !== undefined) {
            return fallback;
        }
    }
    return renderCodexOutput(theme, textOutput(result), {
        expanded: options.expanded,
        mode: "head",
        maxPreviewLines: 5,
    });
}

function renderEditCall(
    args: unknown,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    dynamicStatusLabels: boolean,
) {
    closeExplorationGroup();
    const labelColumnWidth = mutationLabelColumnWidth(context, dynamicStatusLabels);
    const preview = editPreviews.get(context.toolCallId);
    if (!context.isPartial && preview) {
        return renderMutationCall(
            theme,
            makeMutationSummary({
                label: dynamicStatusLabels ? "Edited" : "Edit",
                path: preview.path,
                added: preview.added,
                removed: preview.removed,
            }),
            labelColumnWidth === undefined ? {} : { labelColumnWidth },
        );
    }

    const summary = summarizeEditCall(normalizedEditArgs(args), {
        ...context,
        dynamicStatusLabels,
    });
    const state = summary.hasInvalidEdits || context.isError ? "error" : "muted";
    return renderCodexCall(theme, {
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
    dynamicStatusLabels: boolean,
) {
    if (!options.isPartial) {
        markMutationResultRendered(context, dynamicStatusLabels);
    }

    const pierrePayload = !context.isError
        ? getPierreDiffPayloadFromDetails(result.details)
        : undefined;
    if (pierrePayload) {
        return renderPierreDiff(pierrePayload, theme, { expanded: options.expanded }, context);
    }

    if (
        !context.isError &&
        isRecord(result.details) &&
        typeof result.details.diff === "string" &&
        hasNonWhitespaceText(result.details.diff)
    ) {
        const path = pathField(context.args);
        const summaryPayload = buildLargeDiffSummaryPayload({
            path: path ?? "",
            diffText: result.details.diff,
        });
        if (summaryPayload !== undefined) {
            return renderPierreDiff(summaryPayload, theme, { expanded: options.expanded }, context);
        }
        return renderCodexDiff(
            theme,
            parseDiffSections(result.details.diff, path),
            options.expanded,
        );
    }
    return renderCodexOutput(theme, textOutput(result), {
        expanded: options.expanded,
        mode: "head",
        maxPreviewLines: 5,
    });
}

async function startSyntaxHighlighting(reportWarning: (message: string) => void): Promise<void> {
    try {
        await initializeSyntaxHighlighting();
    } catch (cause: unknown) {
        reportWarning(`[pi-codex-look] Syntax preload failed: ${errorMessage(cause)}`);
    }
}

function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

function clearSessionState(): void {
    editPreviews.clear();
    scriptPreviews.clear();
    explorationGroups.clear();
    clearQueuedDiffHighlights();
}

function formatMb(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function shouldReportMemory(): boolean {
    const value = process.env[MEMORY_LOG_ENV]?.trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes";
}

function reportMemory(label: string): void {
    if (!shouldReportMemory()) {
        return;
    }

    const memory = process.memoryUsage();
    const editStats = editPreviews.stats();
    const scriptStats = scriptPreviews.stats();
    const explorationStats = explorationGroups.stats();
    const diffStats = pierreDiffHighlightStats();
    console.warn(
        `[pi-codex-look] ${label} ` +
            `rss=${formatMb(memory.rss)} ` +
            `heapUsed=${formatMb(memory.heapUsed)} ` +
            `heapTotal=${formatMb(memory.heapTotal)} ` +
            `external=${formatMb(memory.external)} ` +
            `arrayBuffers=${formatMb(memory.arrayBuffers)} ` +
            `state=${JSON.stringify({
                editPreviews: editStats.entries,
                editPreviewBytes: editStats.bytes,
                scriptPreviews: scriptStats.entries,
                scriptPreviewBytes: scriptStats.bytes,
                explorationGroups: explorationStats.groups,
                explorationToolCalls: explorationStats.toolCalls,
                queuedDiffHighlights: diffStats.queuedHighlights,
                activeDiffHighlightTimers: diffStats.activeTimers,
            })}`,
    );
}

export default async function codexLookExtension(pi: ExtensionAPI): Promise<void> {
    // SAFETY: The symbol property is extension-private metadata on the concrete
    // ExtensionAPI object. It does not alter Pi's public API or handler semantics.
    const guardedPi = pi as ExtensionAPI & { [key: symbol]: boolean | undefined };
    if (guardedPi[EXTENSION_LOADED_KEY] === true) {
        return;
    }
    guardedPi[EXTENSION_LOADED_KEY] = true;

    const reportWarning = (message: string): void => console.warn(message);
    let config = readCodexLookConfig({ reportWarning });
    let formatter = scriptBlockFormatter(config, reportWarning);
    let headerLayout = scriptPreviewHeaderLayout(config);

    const applyConfig = (nextConfig: CodexLookConfig): void => {
        config = nextConfig;
        formatter = scriptBlockFormatter(config, reportWarning);
        headerLayout = scriptPreviewHeaderLayout(config);
        configureAssistantSeparatorPatch(config.patches.assistantSeparator);
        configureWorkingWidgetSpacingPatch(config.patches.workingWidgetSpacing);
        configureAutocompleteCleanupPatch(config.patches.autocompleteCleanup);
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
                dynamicStatusLabels: config.toolLabels.dynamicStatus,
            }),
            renderResult: renderBuiltInToolResult({
                headerLayout: () => headerLayout,
                dynamicStatusLabels: config.toolLabels.dynamicStatus,
            }),
        });
    };

    applyConfig(config);

    pi.on("tool_call", (event) => {
        if (
            !isToolCallEventType("bash", event) &&
            compatBuiltInToolName(event.toolName) !== "bash"
        ) {
            return;
        }
        const command = commandField(event.input);
        if (command !== undefined) {
            rememberRawScriptPreview(scriptPreviews, event.toolCallId, command);
        }
    });

    pi.on("tool_result", (event, ctx) => {
        if (event.toolName === "bash" || compatBuiltInToolName(event.toolName) === "bash") {
            const command = commandField(event.input);
            if (command !== undefined) {
                rememberRawScriptPreview(scriptPreviews, event.toolCallId, command);
                scheduleFormattedScriptPreview({
                    sink: scriptPreviews,
                    toolCallId: event.toolCallId,
                    command,
                    formatter,
                    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
                });
            }
        }

        const rendersAsEdit =
            isEditToolResult(event) || compatBuiltInToolName(event.toolName) === "edit";
        if (
            !rendersAsEdit ||
            event.isError ||
            !isRecord(event.details) ||
            typeof event.details.diff !== "string"
        ) {
            return;
        }
        editPreviews.set(
            event.toolCallId,
            buildEditPreview({
                path: pathField(event.input) ?? "",
                diff: event.details.diff,
            }),
        );
    });

    pi.on("session_start", async (_event, ctx) => {
        reportMemory("session_start");
        clearSessionState();
        await disposeSyntaxHighlighting();
        applyConfig(
            readCodexLookConfig(
                { cwd: ctx.cwd, reportWarning },
                { includeProjectConfig: ctx.isProjectTrusted() },
            ),
        );
        await startSyntaxHighlighting(reportWarning);
    });

    pi.on("turn_start", () => {
        reportMemory("turn_start");
        closeExplorationGroup();
    });

    pi.on("turn_end", () => {
        closeExplorationGroup();
        reportMemory("turn_end");
    });

    pi.on("session_shutdown", async () => {
        reportMemory("session_shutdown");
        clearSessionState();
        configureAssistantSeparatorPatch(false);
        configureWorkingWidgetSpacingPatch(false);
        configureAutocompleteCleanupPatch(false);
        configureMarkdownSyntaxPatch(false);
        configureThirdPartyToolRendererPatch(false);
        configureBuiltInToolRendererPatch(false);
        await disposeSyntaxHighlighting();
        guardedPi[EXTENSION_LOADED_KEY] = false;
    });
}
