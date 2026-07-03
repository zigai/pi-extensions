import {
    isEditToolResult,
    isToolCallEventType,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
    createCommandScriptFormatter,
    formatScriptInvocation,
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
    renderPierreDiff,
} from "./pierre-diff-renderer.ts";
import {
    parsePreservedThirdPartyToolNames,
    type ThirdPartyToolRenderingOptions,
} from "./third-party-renderers.ts";
import { parseScriptPreviewHeaderLayout } from "./script-preview-settings.ts";
import { boundedScriptPreview, createScriptPreviewStore } from "./script-preview-store.ts";
import {
    installBuiltInToolRendererPatch,
    installThirdPartyToolRendererPatch,
    type BuiltInToolRendererOptions,
} from "./tool-execution-patch.ts";
import { detectStructuredOutputLanguage } from "./syntax/code-component.ts";
import { disposeSyntaxHighlighting, initializeSyntaxHighlighting } from "./syntax/highlighter.ts";
import { configureMarkdownSyntaxPatch } from "./syntax/markdown-patch.ts";

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
const PRESERVE_TOOLS_ENV = "PI_CODEX_LOOK_PRESERVE_TOOLS";
const SCRIPT_FORMATTERS_ENV = "PI_CODEX_LOOK_SCRIPT_FORMATTERS";
const SCRIPT_HEADER_LAYOUT_ENV = "PI_CODEX_LOOK_SCRIPT_HEADER_LAYOUT";

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

function numberField(args: unknown, key: string): number | undefined {
    if (!isRecord(args)) {
        return undefined;
    }
    const value = args[key];
    return typeof value === "number" ? value : undefined;
}

function readActionArgs(args: unknown): ReadActionArgs {
    const path = stringField(args, "path");
    const offset = numberField(args, "offset");
    const limit = numberField(args, "limit");
    return {
        ...(path === undefined ? {} : { path }),
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
    };
}

function findActionArgs(args: unknown): FindActionArgs {
    const pattern = stringField(args, "pattern");
    const path = stringField(args, "path");
    const limit = numberField(args, "limit");
    return {
        ...(pattern === undefined ? {} : { pattern }),
        ...(path === undefined ? {} : { path }),
        ...(limit === undefined ? {} : { limit }),
    };
}

function grepActionArgs(args: unknown): GrepActionArgs {
    const pattern = stringField(args, "pattern");
    const path = stringField(args, "path");
    const glob = stringField(args, "glob");
    const limit = numberField(args, "limit");
    return {
        ...(pattern === undefined ? {} : { pattern }),
        ...(path === undefined ? {} : { path }),
        ...(glob === undefined ? {} : { glob }),
        ...(limit === undefined ? {} : { limit }),
    };
}

function lsActionArgs(args: unknown): LsActionArgs {
    const path = stringField(args, "path");
    const limit = numberField(args, "limit");
    return {
        ...(path === undefined ? {} : { path }),
        ...(limit === undefined ? {} : { limit }),
    };
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

function renderBuiltInToolCall(
    headerLayout: () => ScriptPreviewHeaderLayout,
): BuiltInToolRendererOptions["renderCall"] {
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
                return renderBashCall(args, theme, context, headerLayout);
            case "write":
                return renderWriteCall(args, theme, context);
            case "edit":
                return renderEditCall(args, theme, context);
        }
    };
}

function renderBuiltInToolResult(
    headerLayout: () => ScriptPreviewHeaderLayout,
): BuiltInToolRendererOptions["renderResult"] {
    return (toolName, result, options, theme, context) => {
        switch (toolName) {
            case "read":
                return hasImageContent(result)
                    ? undefined
                    : renderExplorationResult(result, options.expanded, theme, {
                          syntaxPath: syntaxPathFromToolArg(stringField(context.args, "path")),
                      });
            case "find":
            case "grep":
            case "ls":
                return renderExplorationResult(result, options.expanded, theme);
            case "bash":
                return renderBashResult(result, options, theme, context, headerLayout);
            case "write":
                return renderWriteResult(result, options, theme, context);
            case "edit":
                return renderEditResult(result, options, theme, context);
        }
    };
}

function renderBashCall(
    args: unknown,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    headerLayout: () => ScriptPreviewHeaderLayout,
) {
    closeExplorationGroup();
    const state = context.isError ? "error" : context.isPartial ? "running" : "success";
    const command = stringField(args, "command") ?? "";
    const script = scriptPreviews.get(context.toolCallId) ??
        parseScriptInvocation(command) ?? {
            label: "Bash",
            language: "bash",
            code: command,
        };
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
    const script = parseScriptInvocation(stringField(context.args, "command"));
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

function renderWriteCall(args: unknown, theme: BuiltInRenderTheme, context: BuiltInRenderContext) {
    closeExplorationGroup();
    return renderCodexCall(theme, {
        state: context.isError ? "error" : context.isPartial ? "muted" : "success",
        statusText: context.isPartial ? "Write" : "Wrote",
        body: formatPathTarget(theme, stringField(args, "path")),
    });
}

function renderWriteResult(
    result: TextResult,
    options: BuiltInResultOptions,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
) {
    const pierrePayload = !context.isError
        ? getPierreDiffPayloadFromDetails(result.details)
        : undefined;
    if (pierrePayload) {
        return renderPierreDiff(pierrePayload, theme, { expanded: options.expanded }, context);
    }
    return renderCodexOutput(theme, textOutput(result), {
        expanded: options.expanded,
        mode: "head",
        maxPreviewLines: 5,
    });
}

function renderEditCall(args: unknown, theme: BuiltInRenderTheme, context: BuiltInRenderContext) {
    closeExplorationGroup();
    const preview = editPreviews.get(context.toolCallId);
    if (!context.isPartial && preview) {
        return renderMutationCall(
            theme,
            makeMutationSummary({
                label: "Edited",
                path: preview.path,
                added: preview.added,
                removed: preview.removed,
            }),
        );
    }

    const summary = summarizeEditCall(args, context);
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
) {
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
        const path = stringField(context.args, "path");
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

async function rememberFormattedScriptPreview(
    toolCallId: string,
    command: string,
    formatter: ScriptBlockFormatter | undefined,
    signal: AbortSignal | undefined,
): Promise<void> {
    const script = parseScriptInvocation(command);
    if (script === undefined || formatter === undefined) {
        return;
    }

    const formattedScript = await formatScriptInvocation(
        script,
        formatter,
        signal === undefined ? {} : { signal },
    );
    if (formattedScript.code !== script.code) {
        scriptPreviews.set(toolCallId, boundedScriptPreview(formattedScript));
    }
}

let deferredSyntaxPreload: ReturnType<typeof setTimeout> | undefined;

function scheduleDeferredSyntaxPreload(reportWarning: (message: string) => void): void {
    if (deferredSyntaxPreload !== undefined) {
        clearTimeout(deferredSyntaxPreload);
    }

    deferredSyntaxPreload = setTimeout(() => {
        deferredSyntaxPreload = undefined;
        void initializeSyntaxHighlighting().catch((cause: unknown) => {
            reportWarning(`[pi-codex-look] Deferred syntax preload failed: ${errorMessage(cause)}`);
        });
    }, 1_500);
}

async function startSyntaxPreload(
    config: CodexLookConfig,
    reportWarning: (message: string) => void,
): Promise<void> {
    if (!config.syntaxPreloadOnStartup) {
        scheduleDeferredSyntaxPreload(reportWarning);
        return;
    }

    try {
        await initializeSyntaxHighlighting();
    } catch (cause: unknown) {
        reportWarning(`[pi-codex-look] Syntax preload failed: ${errorMessage(cause)}`);
    }
}

function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

export default async function codexLookExtension(pi: ExtensionAPI): Promise<void> {
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
        installThirdPartyToolRendererPatch(
            config.patches.thirdPartyToolRenderers
                ? thirdPartyToolRenderingOptions(config)
                : { enabled: false },
        );
        installBuiltInToolRendererPatch({
            renderCall: renderBuiltInToolCall(() => headerLayout),
            renderResult: renderBuiltInToolResult(() => headerLayout),
        });
    };

    applyConfig(config);

    pi.on("tool_call", async (event, ctx) => {
        if (!isToolCallEventType("bash", event)) {
            return;
        }
        await rememberFormattedScriptPreview(
            event.toolCallId,
            event.input.command,
            formatter,
            ctx.signal,
        );
    });

    pi.on("tool_result", (event) => {
        if (!isEditToolResult(event) || event.isError || typeof event.details?.diff !== "string") {
            return;
        }
        editPreviews.set(
            event.toolCallId,
            buildEditPreview({
                path: stringField(event.input, "path") ?? "",
                diff: event.details.diff,
            }),
        );
    });

    pi.on("session_start", async (_event, ctx) => {
        applyConfig(
            readCodexLookConfig(
                { cwd: ctx.cwd, reportWarning },
                { includeProjectConfig: ctx.isProjectTrusted() },
            ),
        );
        await startSyntaxPreload(config, reportWarning);
    });

    pi.on("turn_start", () => {
        closeExplorationGroup();
    });

    pi.on("turn_end", () => {
        closeExplorationGroup();
    });

    pi.on("session_shutdown", async () => {
        if (deferredSyntaxPreload !== undefined) {
            clearTimeout(deferredSyntaxPreload);
            deferredSyntaxPreload = undefined;
        }
        editPreviews.clear();
        scriptPreviews.clear();
        explorationGroups.clear();
        clearQueuedDiffHighlights();
        configureAssistantSeparatorPatch(false);
        configureWorkingWidgetSpacingPatch(false);
        configureAutocompleteCleanupPatch(false);
        configureMarkdownSyntaxPatch(false);
        await disposeSyntaxHighlighting();
    });
}
