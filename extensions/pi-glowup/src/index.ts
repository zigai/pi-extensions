import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
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
import { installAssistantSeparatorPatch } from "./assistant-separator.ts";
import { installWorkingWidgetSpacingPatch } from "./working-widget-spacing.ts";
import { installAutocompleteCleanupPatch } from "./autocomplete-cleanup.ts";
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
  type MutationSummary,
  type ScriptInvocation,
  type ScriptPreviewHeaderLayout,
} from "./rendering.ts";
import { buildEditPreview, EditPreviewStore, PreviewStore } from "./edit-preview.ts";
import { summarizeEditCall } from "./edit-call-rendering.ts";
import { buildPierreDiffPayload, createEditSnapshot, createWriteSnapshot } from "./pierre-diff.ts";
import type { PierreDiffPayload } from "./pierre-diff-types.ts";
import { getPierreDiffPayloadFromDetails, renderPierreDiff } from "./pierre-diff-renderer.ts";
import {
  parsePreservedThirdPartyToolNames,
  type ThirdPartyToolRenderingOptions,
} from "./third-party-renderers.ts";
import { parseScriptPreviewHeaderLayout } from "./script-preview-settings.ts";
import { installThirdPartyToolRendererPatch } from "./tool-execution-patch.ts";
import { detectStructuredOutputLanguage } from "./syntax/code-component.ts";
import { clearSyntaxHighlightCache, initializeSyntaxHighlighting } from "./syntax/highlighter.ts";
import { installMarkdownSyntaxPatch } from "./syntax/markdown-patch.ts";

type ToolTextContent = {
  readonly type: string;
  readonly text?: string;
};

type TextResult = {
  readonly content: ReadonlyArray<ToolTextContent>;
  readonly details?: unknown;
};

const editPreviews = new EditPreviewStore(300);
const scriptPreviews = new PreviewStore<ScriptInvocation>(300);
const explorationGroups = new ExplorationGroupStore();
const toolCache = new Map<string, BuiltInToolDefinitions>();
const PRESERVE_TOOLS_ENV = "PI_CODEX_LOOK_PRESERVE_TOOLS";
const SCRIPT_FORMATTERS_ENV = "PI_CODEX_LOOK_SCRIPT_FORMATTERS";
const SCRIPT_HEADER_LAYOUT_ENV = "PI_CODEX_LOOK_SCRIPT_HEADER_LAYOUT";

type BuiltInToolDefinitions = ReturnType<typeof createBuiltInToolDefinitions>;

function createBuiltInToolDefinitions(cwd: string) {
  return {
    read: createReadToolDefinition(cwd),
    bash: createBashToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    grep: createGrepToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
  };
}

function getBuiltInToolDefinitions(cwd: string): BuiltInToolDefinitions {
  const cachedTools = toolCache.get(cwd);
  if (cachedTools) {
    return cachedTools;
  }

  const tools = createBuiltInToolDefinitions(cwd);
  toolCache.set(cwd, tools);
  return tools;
}

function textOutput(result: TextResult): string | undefined {
  const content = result.content.find((item) => item.type === "text");
  return content?.text;
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

function attachPierreDiffPayload<TResult extends { readonly details?: unknown }>(
  result: TResult,
  payload: PierreDiffPayload | undefined,
): TResult {
  if (!payload) {
    return result;
  }

  return {
    ...result,
    details: {
      ...(isRecord(result.details) ? result.details : {}),
      pierreDiff: payload,
    },
  };
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

function registerReadTool(pi: ExtensionAPI, baseTools: BuiltInToolDefinitions): void {
  const tool: BuiltInToolDefinitions["read"] = {
    ...baseTools.read,
    label: "Read",
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInToolDefinitions(ctx.cwd).read.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
    },
    renderCall(args, theme, context) {
      return renderExplorationCall(theme, context, formatReadAction(theme, args));
    },
    renderResult(result, options, theme, context) {
      const imageContent = result.content.find((item) => item.type === "image");
      if (imageContent) {
        const fallbackRenderResult = baseTools.read.renderResult;
        if (fallbackRenderResult) {
          return fallbackRenderResult(result, options, theme, context);
        }
        return emptyComponent();
      }
      return renderExplorationResult(result, options.expanded, theme, {
        syntaxPath: syntaxPathFromToolArg(context.args.path),
      });
    },
  };
  pi.registerTool(tool);
}

function registerFindTool(pi: ExtensionAPI, baseTools: BuiltInToolDefinitions): void {
  const tool: BuiltInToolDefinitions["find"] = {
    ...baseTools.find,
    label: "Find",
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInToolDefinitions(ctx.cwd).find.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
    },
    renderCall(args, theme, context) {
      return renderExplorationCall(theme, context, formatFindAction(theme, args));
    },
    renderResult(result, options, theme) {
      return renderExplorationResult(result, options.expanded, theme);
    },
  };
  pi.registerTool(tool);
}

function registerGrepTool(pi: ExtensionAPI, baseTools: BuiltInToolDefinitions): void {
  const tool: BuiltInToolDefinitions["grep"] = {
    ...baseTools.grep,
    label: "Grep",
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInToolDefinitions(ctx.cwd).grep.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
    },
    renderCall(args, theme, context) {
      return renderExplorationCall(theme, context, formatGrepAction(theme, args));
    },
    renderResult(result, options, theme) {
      return renderExplorationResult(result, options.expanded, theme);
    },
  };
  pi.registerTool(tool);
}

function registerLsTool(pi: ExtensionAPI, baseTools: BuiltInToolDefinitions): void {
  const tool: BuiltInToolDefinitions["ls"] = {
    ...baseTools.ls,
    label: "Ls",
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInToolDefinitions(ctx.cwd).ls.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
    },
    renderCall(args, theme, context) {
      return renderExplorationCall(theme, context, formatLsAction(theme, args));
    },
    renderResult(result, options, theme) {
      return renderExplorationResult(result, options.expanded, theme);
    },
  };
  pi.registerTool(tool);
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

function registerBashTool(
  pi: ExtensionAPI,
  baseTools: BuiltInToolDefinitions,
  formatter: ScriptBlockFormatter | undefined,
  headerLayout: ScriptPreviewHeaderLayout,
): void {
  const tool: BuiltInToolDefinitions["bash"] = {
    ...baseTools.bash,
    label: "Bash",
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const script = parseScriptInvocation(params.command);
      if (script !== undefined) {
        scriptPreviews.set(
          toolCallId,
          formatter === undefined
            ? script
            : await formatScriptInvocation(
                script,
                formatter,
                signal === undefined ? {} : { signal },
              ),
        );
      }

      return getBuiltInToolDefinitions(ctx.cwd).bash.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
    },
    renderCall(args, theme, context) {
      closeExplorationGroup();
      const state = context.isError ? "error" : context.isPartial ? "running" : "success";
      const script = scriptPreviews.get(context.toolCallId) ??
        parseScriptInvocation(args.command) ?? {
          label: "Bash",
          language: "bash",
          code: args.command ?? "",
        };
      return renderScriptCall(theme, script, {
        state,
        expanded: context.expanded,
        maxCodePreviewLines: script.language === "bash" ? 3 : 8,
        headerLayout,
      });
    },
    renderResult(result, options, theme, context) {
      const output = textOutput(result);
      const language = detectStructuredOutputLanguage(output);
      const script = parseScriptInvocation(context.args.command);
      return renderCodexOutput(theme, output, {
        expanded: options.expanded,
        mode: "headTail",
        maxPreviewLines: 5,
        ...(script !== undefined && headerLayout === "block"
          ? { prefixFirst: theme.fg("dim", "  → "), prefixRest: "    " }
          : {}),
        ...(language === undefined ? {} : { syntax: { language } }),
      });
    },
  };
  pi.registerTool(tool);
}

function registerWriteTool(pi: ExtensionAPI, baseTools: BuiltInToolDefinitions): void {
  const tool: BuiltInToolDefinitions["write"] = {
    ...baseTools.write,
    label: "Write",
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const snapshot = await createWriteSnapshot(ctx.cwd, params.path, params.content);
      const result = await getBuiltInToolDefinitions(ctx.cwd).write.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
      return attachPierreDiffPayload(result, buildPierreDiffPayload(snapshot));
    },
    renderCall(args, theme, context) {
      closeExplorationGroup();
      return renderCodexCall(theme, {
        state: context.isError ? "error" : context.isPartial ? "muted" : "success",
        statusText: context.isPartial ? "Write" : "Wrote",
        body: formatPathTarget(theme, args.path),
      });
    },
    renderResult(result, options, theme, context) {
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
    },
  };
  pi.registerTool(tool);
}

function registerEditTool(pi: ExtensionAPI, baseTools: BuiltInToolDefinitions): void {
  const tool: BuiltInToolDefinitions["edit"] = {
    ...baseTools.edit,
    label: "Edit",
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const snapshotState = await createEditSnapshot(ctx.cwd, params.path);
      const result = await getBuiltInToolDefinitions(ctx.cwd).edit.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
      if (typeof result.details?.diff === "string") {
        editPreviews.set(
          toolCallId,
          buildEditPreview({
            path: params.path,
            diff: result.details.diff,
          }),
        );
      }
      const snapshot = await snapshotState.finish();
      return attachPierreDiffPayload(result, buildPierreDiffPayload(snapshot));
    },
    renderCall(args, theme, context) {
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
    },
    renderResult(result, options, theme, context) {
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
        result.details.diff.trim()
      ) {
        return renderCodexDiff(
          theme,
          parseDiffSections(result.details.diff, context.args.path),
          options.expanded,
        );
      }
      return renderCodexOutput(theme, textOutput(result), {
        expanded: options.expanded,
        mode: "head",
        maxPreviewLines: 5,
      });
    },
  };
  pi.registerTool(tool);
}

let deferredSyntaxPreload: ReturnType<typeof setTimeout> | undefined;

function scheduleDeferredSyntaxPreload(reportWarning: (message: string) => void): void {
  if (deferredSyntaxPreload !== undefined) {
    clearTimeout(deferredSyntaxPreload);
  }

  deferredSyntaxPreload = setTimeout(() => {
    deferredSyntaxPreload = undefined;
    void initializeSyntaxHighlighting().catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      reportWarning(`[pi-codex-look] Deferred syntax preload failed: ${message}`);
    });
  }, 1_500);
}

export default async function codexLookExtension(pi: ExtensionAPI): Promise<void> {
  const cwd = process.cwd();
  const reportWarning = (message: string): void => console.warn(message);
  const config = readCodexLookConfig({ cwd, reportWarning });
  if (config.syntaxPreloadOnStartup) {
    await initializeSyntaxHighlighting();
  } else {
    scheduleDeferredSyntaxPreload(reportWarning);
  }
  if (config.patches.assistantSeparator) {
    installAssistantSeparatorPatch();
  }
  if (config.patches.workingWidgetSpacing) {
    installWorkingWidgetSpacingPatch();
  }
  if (config.patches.autocompleteCleanup) {
    installAutocompleteCleanupPatch();
  }
  if (config.patches.markdownSyntax) {
    installMarkdownSyntaxPatch();
  }
  if (config.patches.thirdPartyToolRenderers) {
    installThirdPartyToolRendererPatch(thirdPartyToolRenderingOptions(config));
  }
  const baseTools = getBuiltInToolDefinitions(cwd);
  const formatter = scriptBlockFormatter(config, reportWarning);
  const headerLayout = scriptPreviewHeaderLayout(config);

  registerReadTool(pi, baseTools);
  registerBashTool(pi, baseTools, formatter, headerLayout);
  registerEditTool(pi, baseTools);
  registerWriteTool(pi, baseTools);
  registerFindTool(pi, baseTools);
  registerGrepTool(pi, baseTools);
  registerLsTool(pi, baseTools);

  pi.on("turn_start", () => {
    closeExplorationGroup();
  });

  pi.on("turn_end", () => {
    closeExplorationGroup();
  });

  pi.on("session_shutdown", () => {
    if (deferredSyntaxPreload !== undefined) {
      clearTimeout(deferredSyntaxPreload);
      deferredSyntaxPreload = undefined;
    }
    editPreviews.clear();
    scriptPreviews.clear();
    explorationGroups.clear();
    clearSyntaxHighlightCache();
  });
}
