import { closeSync, openSync, readSync } from "node:fs";
import type { Component } from "@earendil-works/pi-tui";
import {
  emptyComponent,
  formatPathTarget,
  renderCodexCall,
  renderCodexOutput,
  type CodexCallState,
  type CodexRenderTheme,
} from "./rendering.ts";
import { detectStructuredOutputLanguage } from "./syntax/code-component.ts";

/** Optional property third-party tools can set to preserve their own renderer. */
export const CODEX_LOOK_RENDERING_PROPERTY = "codexLookRendering";

/** Rendering preference read from third-party tool definitions when present. */
export type CodexLookRenderingPreference = "auto" | "preserve";

/** Matcher used to opt selected third-party tools out of Codex-look conversion. */
export type ToolNameMatcher = string | RegExp | ((toolName: string) => boolean);

/** Minimal render context consumed by Codex-look third-party renderers. */
export type ThirdPartyToolRenderContext = {
  readonly args: unknown;
  readonly toolCallId: string;
  readonly executionStarted: boolean;
  readonly argsComplete: boolean;
  readonly isPartial: boolean;
  readonly expanded: boolean;
  readonly showImages: boolean;
  readonly isError: boolean;
};

/** Minimal result shape consumed by Codex-look third-party renderers. */
export type ThirdPartyToolResult = {
  readonly content?: unknown;
  readonly details?: unknown;
};

/** Codex-look renderer pair for a non-native tool. */
export type ThirdPartyToolRenderer = {
  readonly renderCall: (
    args: unknown,
    theme: CodexRenderTheme,
    context: ThirdPartyToolRenderContext,
  ) => Component;
  readonly renderResult: (
    result: ThirdPartyToolResult,
    options: { readonly expanded: boolean; readonly isPartial: boolean },
    theme: CodexRenderTheme,
    context: ThirdPartyToolRenderContext,
  ) => Component;
};

/** Registry entry for a known third-party tool family. */
export type ThirdPartyToolRendererPlugin = {
  readonly name: string;
  readonly matches: (toolName: string) => boolean;
  readonly createRenderer: (toolName: string) => ThirdPartyToolRenderer;
};

/** Policy for automatic third-party tool renderer conversion. */
export type ThirdPartyToolRenderingOptions = {
  readonly enabled?: boolean;
  readonly preserveTools?: ReadonlyArray<ToolNameMatcher>;
  readonly renderers?: ReadonlyArray<ThirdPartyToolRendererPlugin>;
};

type UnknownRecord = {
  readonly [key: string]: unknown;
};

type TextContent = {
  readonly type?: unknown;
  readonly text?: unknown;
};

type CallSummary = {
  readonly label: string;
  readonly body: string | undefined;
};

type CallOptions = {
  readonly state: CodexCallState;
  readonly statusText: string;
  readonly body: string | undefined;
  readonly maxRenderedLines: number;
  readonly expanded: boolean;
  readonly expandable?: boolean;
};

type GoalRecord = {
  readonly objective: string;
  readonly status: string;
  readonly tokensUsed: number | undefined;
  readonly timeUsedSeconds: number | undefined;
};

const MAX_PREVIEW_CHARACTERS = 700;
const MAX_WEB_RUN_FILE_BYTES = 64 * 1024;
const MAX_WEB_RUN_HIGHLIGHTS = 3;
const WEB_RUN_COLLAPSED_SOURCE_LIMIT = 4;
const NAMESPACED_TOOL_PREFIX_PATTERN = /^[A-Za-z0-9_-]+__(?<name>.+)$/;
const CHROME_DEVTOOLS_PREFIX_PATTERN = /(?:^|__)chrome[-_]?devtools(?:__|_|$)/i;
const WEB_RUN_TITLE_URL_PATTERN = /^(?<title>.+?)\s+\((?<url>https?:\/\/[^)]+)\)$/u;
const WEB_RUN_TOTAL_LINES_PATTERN = /Total lines:\s*(?<lines>\d+)/u;
const WEB_RUN_CONTENT_TYPE_PATTERN = /Content type:\s*(?<type>[^;]+)/u;
const WEB_RUN_SOURCE_PATTERN = /Source:\s*(?<source>[^;]+)/u;
const WEB_RUN_LINE_PATTERN = /^L\d+:\s*(?<text>.*)$/u;
const WEB_RUN_CITATION_PATTERN = /cite[^]*/gu;

const BROWSER_COMMAND_LABELS = new Map<string, string>([
  ["open", "Browser Open"],
  ["snapshot", "Browser Snapshot"],
  ["click", "Browser Click"],
  ["fill", "Browser Fill"],
  ["type", "Browser Type"],
  ["select", "Browser Select"],
  ["wait", "Browser Wait"],
  ["screenshot", "Browser Screenshot"],
  ["qa", "Browser QA"],
  ["sourceLookup", "Browser Source Lookup"],
  ["networkSourceLookup", "Browser Network Lookup"],
  ["electron", "Electron"],
  ["evaluate", "Browser Evaluate"],
  ["eval", "Browser Evaluate"],
]);

const MCP_COMMAND_LABELS = new Map<string, string>([
  ["take_snapshot", "Browser Snapshot"],
  ["take_screenshot", "Browser Screenshot"],
  ["click", "Browser Click"],
  ["fill", "Browser Fill"],
  ["hover", "Browser Hover"],
  ["evaluate_script", "Browser Evaluate"],
  ["navigate_page", "Browser Navigate"],
  ["new_page", "Browser Open"],
  ["list_pages", "Browser Pages"],
  ["select_page", "Browser Select Page"],
  ["close_page", "Browser Close Page"],
  ["resize_page", "Browser Resize"],
  ["performance_analyze_insight", "Browser Performance"],
]);

const CORE_TOOL_LABELS = new Map<string, string>([
  ["web_run", "Web Search"],
  ["imagegen", "Image Generate"],
  ["view_image", "View Image"],
  ["finalize_plan", "Plan Finalized"],
  ["ask_user_question", "Asked User"],
]);

const AGENT_TOOL_LABELS = new Map<string, string>([
  ["Agent", "Launched Agent"],
  ["agent", "Launched Agent"],
  ["get_subagent_result", "Checked Agent"],
  ["steer_subagent", "Steered Agent"],
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getNumber(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getArray(record: UnknownRecord, key: string): ReadonlyArray<unknown> | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

function displayToolName(toolName: string): string {
  return toolName || "tool";
}

function baseToolName(toolName: string): string {
  const match = NAMESPACED_TOOL_PREFIX_PATTERN.exec(toolName);
  return match?.groups?.name ?? toolName;
}

function hasChromeDevtoolsName(toolName: string): boolean {
  return CHROME_DEVTOOLS_PREFIX_PATTERN.test(toolName);
}

function callState(context: ThirdPartyToolRenderContext): CodexCallState {
  if (context.isError) {
    return "error";
  }
  if (context.isPartial || !context.argsComplete) {
    return "running";
  }
  return "success";
}

function truncateText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

function stringifyPreview(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol";
  }
  if (typeof value === "function") {
    return value.name ? `[Function ${value.name}]` : "[Function]";
  }

  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(
      value,
      (_key, nestedValue: unknown) => {
        if (typeof nestedValue === "bigint") {
          return `${nestedValue.toString()}n`;
        }
        if (typeof nestedValue === "function") {
          return nestedValue.name ? `[Function ${nestedValue.name}]` : "[Function]";
        }
        if (typeof nestedValue === "symbol") {
          return nestedValue.description ? `Symbol(${nestedValue.description})` : "Symbol";
        }
        if (typeof nestedValue === "object" && nestedValue !== null) {
          if (seen.has(nestedValue)) {
            return "[Circular]";
          }
          seen.add(nestedValue);
        }
        return nestedValue;
      },
      2,
    );
    return json ?? String(value);
  } catch (cause: unknown) {
    return String(cause);
  }
}

function previewValue(value: unknown): string | undefined {
  const preview = stringifyPreview(value)?.trim();
  if (!preview || preview === "{}" || preview === "[]") {
    return undefined;
  }
  return truncateText(preview, MAX_PREVIEW_CHARACTERS);
}

function previewArgs(args: unknown, fallback?: string): string | undefined {
  return fallback ?? previewValue(args);
}

function textOutput(result: ThirdPartyToolResult): string | undefined {
  const content = result.content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const texts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }
    const contentItem: TextContent = item;
    if (contentItem.type === "text" && typeof contentItem.text === "string") {
      texts.push(contentItem.text);
    }
  }

  if (texts.length === 0) {
    return undefined;
  }
  return texts.join("\n");
}

function compactQuotedText(text: string | undefined, maxCharacters = 96): string | undefined {
  if (!text) {
    return undefined;
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  return `"${truncateText(compact, maxCharacters)}"`;
}

function countedSummary(
  label: string,
  values: ReadonlyArray<unknown> | undefined,
): string | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const prefix = label.length > 0 ? `${label} ` : "";
  const first = values[0];
  if (isRecord(first)) {
    const query = getString(first, "q") ?? getString(first, "ref_id") ?? getString(first, "url");
    const quoted = compactQuotedText(query);
    if (quoted) {
      return values.length === 1
        ? `${prefix}${quoted}`
        : `${prefix}${quoted} +${values.length - 1}`;
    }
  }
  return `${prefix}${values.length}`;
}

function renderSimpleResult(
  theme: CodexRenderTheme,
  result: ThirdPartyToolResult,
  options: { readonly expanded: boolean; readonly isPartial: boolean },
): Component {
  const output = textOutput(result);
  const language = detectStructuredOutputLanguage(output);
  return renderCodexOutput(theme, output, {
    expanded: options.expanded,
    mode: "headTail",
    maxPreviewLines: 4,
    noOutputLabel: null,
    ...(language ? { syntax: { language } } : {}),
  });
}

function renderThirdPartyCall(theme: CodexRenderTheme, options: CallOptions): Component {
  const maxRenderedLines =
    options.expanded && options.expandable !== false ? undefined : options.maxRenderedLines;
  if (options.body === undefined) {
    if (maxRenderedLines === undefined) {
      return renderCodexCall(theme, {
        state: options.state,
        statusText: options.statusText,
      });
    }
    return renderCodexCall(theme, {
      state: options.state,
      statusText: options.statusText,
      maxRenderedLines,
    });
  }

  if (maxRenderedLines === undefined) {
    return renderCodexCall(theme, {
      state: options.state,
      statusText: options.statusText,
      body: options.body,
    });
  }
  return renderCodexCall(theme, {
    state: options.state,
    statusText: options.statusText,
    body: options.body,
    maxRenderedLines,
  });
}

function createGenericRenderer(toolName: string, label?: string): ThirdPartyToolRenderer {
  return {
    renderCall(args, theme, context) {
      return renderThirdPartyCall(theme, {
        state: callState(context),
        statusText: label ?? `Called ${displayToolName(toolName)}`,
        body: previewArgs(args),
        maxRenderedLines: 4,
        expanded: context.expanded,
      });
    },
    renderResult(result, options, theme) {
      return renderSimpleResult(theme, result, options);
    },
  };
}

function summarizeBrowserArgs(args: unknown): CallSummary {
  if (!isRecord(args)) {
    return { label: "Browser", body: previewArgs(args) };
  }

  if (isRecord(args.electron)) {
    const action = getString(args.electron, "action");
    const appName = getString(args.electron, "appName") ?? getString(args.electron, "bundleId");
    return {
      label: BROWSER_COMMAND_LABELS.get("electron") ?? "Electron",
      body: [action, appName].filter(Boolean).join(" ") || previewArgs(args.electron),
    };
  }

  for (const key of [
    "qa",
    "job",
    "semanticAction",
    "sourceLookup",
    "networkSourceLookup",
  ] as const) {
    if (args[key] !== undefined) {
      return { label: BROWSER_COMMAND_LABELS.get(key) ?? "Browser", body: previewArgs(args[key]) };
    }
  }

  const commandArgs = getArray(args, "args");
  const command = typeof commandArgs?.[0] === "string" ? commandArgs[0] : undefined;
  if (command && commandArgs) {
    return {
      label: BROWSER_COMMAND_LABELS.get(command) ?? `Browser ${command}`,
      body: previewArgs(commandArgs.slice(1)),
    };
  }

  return { label: "Browser", body: previewArgs(args) };
}

function summarizeMcpArgs(args: unknown): CallSummary {
  if (!isRecord(args)) {
    return { label: "MCP", body: previewArgs(args) };
  }

  const tool = getString(args, "tool") ?? getString(args, "describe") ?? getString(args, "search");
  if (tool) {
    return {
      label: MCP_COMMAND_LABELS.get(tool) ?? `MCP ${tool}`,
      body: previewArgs(args.args ?? args),
    };
  }

  const connect = getString(args, "connect") ?? getString(args, "server");
  if (connect) {
    return { label: "MCP Connect", body: connect };
  }

  return { label: "MCP", body: previewArgs(args) };
}

function createBrowserRenderer(toolName: string): ThirdPartyToolRenderer {
  return {
    renderCall(args, theme, context) {
      const summary = toolName === "mcp" ? summarizeMcpArgs(args) : summarizeBrowserArgs(args);
      return renderThirdPartyCall(theme, {
        state: callState(context),
        statusText: summary.label,
        body: summary.body,
        maxRenderedLines: 4,
        expanded: context.expanded,
      });
    },
    renderResult(result, options, theme) {
      return renderSimpleResult(theme, result, options);
    },
  };
}

function createMcpToolRenderer(toolName: string): ThirdPartyToolRenderer {
  return {
    renderCall(args, theme, context) {
      const command = baseToolName(toolName).replace(/^chrome[-_]?devtools(?:__|[_-])?/i, "");
      const label = MCP_COMMAND_LABELS.get(command) ?? `MCP ${baseToolName(toolName)}`;
      return renderThirdPartyCall(theme, {
        state: callState(context),
        statusText: label,
        body: previewArgs(args),
        maxRenderedLines: 4,
        expanded: context.expanded,
      });
    },
    renderResult(result, options, theme) {
      return renderSimpleResult(theme, result, options);
    },
  };
}

function normalizeGoalToolName(toolName: string): string {
  return baseToolName(toolName);
}

function parseGoalRecord(value: unknown): GoalRecord | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const objective = getString(value, "objective");
  const status = getString(value, "status");
  if (!objective || !status) {
    return undefined;
  }

  return {
    objective,
    status,
    tokensUsed: getNumber(value, "tokensUsed"),
    timeUsedSeconds: getNumber(value, "timeUsedSeconds"),
  };
}

function parseGoalFromResult(result: ThirdPartyToolResult): GoalRecord | null | undefined {
  if (isRecord(result.details)) {
    const goal = parseGoalRecord(result.details.goal);
    if (goal !== undefined) {
      return goal;
    }
  }

  const output = textOutput(result);
  if (!output) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(output);
    if (isRecord(parsed)) {
      return parseGoalRecord(parsed.goal);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function compactInteger(value: number): string {
  const normalized = Math.max(0, Math.trunc(value));
  if (normalized < 100_000) {
    return normalized.toLocaleString("en-US");
  }
  if (normalized < 1_000_000) {
    return `${(normalized / 1_000).toLocaleString("en-US", { maximumFractionDigits: 0 })}K`;
  }
  return `${(normalized / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
}

function compactDuration(seconds: number): string {
  const normalized = Math.max(0, Math.trunc(seconds));
  const hours = Math.floor(normalized / 3_600);
  const minutes = Math.floor((normalized % 3_600) / 60);
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${normalized}s`;
}

function formatGoalResult(goal: GoalRecord | null | undefined): string | undefined {
  if (goal === null) {
    return "No active goal";
  }
  if (goal === undefined) {
    return undefined;
  }

  const metadata = [
    goal.tokensUsed === undefined ? undefined : `${compactInteger(goal.tokensUsed)} tok`,
    goal.timeUsedSeconds === undefined ? undefined : compactDuration(goal.timeUsedSeconds),
  ].filter(Boolean);
  const suffix = metadata.length > 0 ? ` (${metadata.join(", ")})` : "";
  return `${goal.status}: ${goal.objective}${suffix}`;
}

function goalCallLabel(toolName: string, args: unknown): string {
  const normalized = normalizeGoalToolName(toolName);
  if (normalized === "get_goal") {
    return "Goal Check";
  }
  if (normalized === "create_goal") {
    return "Goal Create";
  }
  if (normalized === "update_goal") {
    if (isRecord(args) && getString(args, "status") === "complete") {
      return "Goal Complete";
    }
    return "Goal Update";
  }
  return "Goal";
}

function createGoalRenderer(toolName: string): ThirdPartyToolRenderer {
  return {
    renderCall(args, theme, context) {
      const body = isRecord(args) ? getString(args, "objective") : undefined;
      return renderThirdPartyCall(theme, {
        state: callState(context),
        statusText: goalCallLabel(toolName, args),
        body,
        maxRenderedLines: 3,
        expanded: context.expanded,
      });
    },
    renderResult(result, options, theme) {
      const formatted = formatGoalResult(parseGoalFromResult(result));
      if (formatted) {
        return renderCodexOutput(theme, formatted, {
          expanded: options.expanded,
          mode: "head",
          maxPreviewLines: 2,
          noOutputLabel: null,
        });
      }
      return renderSimpleResult(theme, result, options);
    },
  };
}

function summarizeWebRunArgs(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return previewArgs(args);
  }

  const webRunActions = [
    { label: "search", values: getArray(args, "search_query") },
    { label: "image", values: getArray(args, "image_query") },
    { label: "open", values: getArray(args, "open") },
    { label: "click", values: getArray(args, "click") },
    { label: "find", values: getArray(args, "find") },
    { label: "screenshot", values: getArray(args, "screenshot") },
    { label: "finance", values: getArray(args, "finance") },
    { label: "weather", values: getArray(args, "weather") },
    { label: "sports", values: getArray(args, "sports") },
    { label: "time", values: getArray(args, "time") },
  ].filter((action) => action.values !== undefined && action.values.length > 0);
  const parts = webRunActions
    .map((action) =>
      countedSummary(
        webRunActions.length === 1 && action.label === "search" ? "" : action.label,
        action.values,
      ),
    )
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" • ") : previewArgs(args);
}

function summarizeImagegenArgs(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return previewArgs(args);
  }
  const prompt = compactQuotedText(getString(args, "prompt"), 140);
  const referenced = getArray(args, "referenced_image_paths") ?? getArray(args, "images");
  const recentCount = getNumber(args, "num_last_images_to_include");
  const metadata = [
    referenced && referenced.length > 0 ? `${referenced.length} refs` : undefined,
    recentCount === undefined ? undefined : `${recentCount} recent`,
  ].filter(Boolean);
  return [prompt, metadata.join(" • ")].filter(Boolean).join("\n") || undefined;
}

function summarizeViewImageArgs(args: unknown, theme: CodexRenderTheme): string | undefined {
  if (!isRecord(args)) {
    return previewArgs(args);
  }
  const path =
    getString(args, "path") ?? getString(args, "file_path") ?? getString(args, "image_path");
  const detail = getString(args, "detail");
  const pathText = path ? formatPathTarget(theme, path) : undefined;
  const detailText = detail ? `detail: ${detail}` : undefined;
  return [pathText, detailText].filter(Boolean).join(" · ") || undefined;
}

function imagegenResultSummary(result: ThirdPartyToolResult): string | undefined {
  if (!isRecord(result.details)) {
    return undefined;
  }
  const images = getArray(result.details, "images");
  if (!images || images.length === 0) {
    return undefined;
  }
  const first = images[0];
  const path = isRecord(first)
    ? (getString(first, "latestPath") ?? getString(first, "path"))
    : undefined;
  return `Generated ${images.length} image${images.length === 1 ? "" : "s"}${path ? ` → ${path}` : ""}`;
}

function readBoundedFileText(path: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_WEB_RUN_FILE_BYTES);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        descriptor = undefined;
      }
    }
  }
}

function normalizeWebRunText(text: string): string {
  return text
    .replace(WEB_RUN_CITATION_PATTERN, "")
    .replace(/[`*_#]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function compactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./u, "");
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/u, "");
    return truncateText(`${host}${path}`, 70);
  } catch {
    return truncateText(url, 70);
  }
}

function isUsefulWebRunTitle(title: string): boolean {
  const normalized = normalizeWebRunText(title);
  return normalized.length > 2 && !/^\d+[.)]?$/u.test(normalized);
}

function formatWebRunSourceLabel(text: string): string | undefined {
  const match = WEB_RUN_TITLE_URL_PATTERN.exec(text.trim());
  const groups = match?.groups;
  if (!groups) {
    return undefined;
  }

  const url = groups.url ?? "";
  if (!isUsefulWebRunTitle(groups.title ?? "")) {
    return compactUrl(url);
  }
  return `${truncateText(normalizeWebRunText(groups.title ?? ""), 72)} — ${compactUrl(url)}`;
}

function webRunSourceLabels(lines: ReadonlyArray<string>): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const label = formatWebRunSourceLabel(line);
    if (!label || seen.has(label.toLowerCase())) {
      continue;
    }
    seen.add(label.toLowerCase());
    labels.push(label);
  }
  return labels;
}

function formatWebRunSummary(options: {
  readonly sourceCount: number | undefined;
  readonly sources: ReadonlyArray<string>;
  readonly metadata: string | undefined;
  readonly highlights: string | undefined;
  readonly expanded: boolean;
}): string | undefined {
  const sourceTotal = options.sourceCount ?? options.sources.length;
  const headline =
    sourceTotal > 0 ? `${sourceTotal} source${sourceTotal === 1 ? "" : "s"}` : undefined;
  const sourceLimit = options.expanded ? options.sources.length : WEB_RUN_COLLAPSED_SOURCE_LIMIT;
  const sources = options.sources.slice(0, sourceLimit);
  const remainingSourceCount = Math.max(0, sourceTotal - sources.length);
  const details = [...sources];

  if (remainingSourceCount > 0) {
    details.push(`… +${remainingSourceCount} sources`);
  }
  if (options.expanded && options.metadata) {
    details.push(`metadata: ${options.metadata}`);
  }
  if (options.expanded && options.highlights) {
    details.push(`preview: ${options.highlights}`);
  }

  if (!headline && details.length === 0) {
    return undefined;
  }
  return [headline, ...details].filter(Boolean).join("\n");
}

function compactWebRunSource(source: string): string {
  const normalized = source
    .replace(/\(\{.+\}/u, "(")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateText(normalized, 48);
}

function webRunMetadataLine(lines: ReadonlyArray<string>): string | undefined {
  const metadata = lines.find((line) => WEB_RUN_CONTENT_TYPE_PATTERN.test(line));
  if (!metadata) {
    return undefined;
  }

  const contentType = WEB_RUN_CONTENT_TYPE_PATTERN.exec(metadata)?.groups?.type?.trim();
  const source = WEB_RUN_SOURCE_PATTERN.exec(metadata)?.groups?.source?.trim();
  const totalLines = WEB_RUN_TOTAL_LINES_PATTERN.exec(metadata)?.groups?.lines;
  const parts = [
    source ? compactWebRunSource(source) : undefined,
    contentType,
    totalLines ? `${totalLines} lines` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" • ") : undefined;
}

function isWebRunBoilerplate(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.length < 4 ||
    lower === "skip to content" ||
    lower === "main navigation" ||
    lower === "sidebar navigation" ||
    lower === "return to top" ||
    lower === "on this page" ||
    lower === "appearance" ||
    lower === "english" ||
    lower === "menu" ||
    lower === "references" ||
    lower === "guide" ||
    lower === "blog" ||
    lower.startsWith("search⌘") ||
    /^v\d+\.\d+\.\d+/u.test(lower)
  );
}

function webRunHighlightScore(text: string): number {
  if (/^#{1,3}\s/u.test(text)) {
    return 8;
  }
  if (/^\s*[*-]\s/u.test(text)) {
    return 5;
  }
  if (text.length >= 80) {
    return 4;
  }
  return 2;
}

function webRunHighlightLine(lines: ReadonlyArray<string>): string | undefined {
  const highlights: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const match = WEB_RUN_LINE_PATTERN.exec(line);
    const rawText = match?.groups?.text;
    if (rawText === undefined) {
      continue;
    }
    const normalized = normalizeWebRunText(rawText);
    if (!normalized || isWebRunBoilerplate(normalized) || seen.has(normalized.toLowerCase())) {
      continue;
    }
    seen.add(normalized.toLowerCase());
    highlights.push(normalized);
  }

  if (highlights.length === 0) {
    return undefined;
  }

  const selected = highlights
    .map((text, index) => ({ text, index, score: webRunHighlightScore(text) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_WEB_RUN_HIGHLIGHTS)
    .sort((left, right) => left.index - right.index)
    .map((highlight) => truncateText(highlight.text, 115));

  return selected.join(" · ");
}

function webRunOutputSummary(
  output: string | undefined,
  sourceCount: number | undefined,
  options: { readonly expanded: boolean },
): string | undefined {
  const normalizedOutput = output?.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalizedOutput) {
    return undefined;
  }

  const lines = normalizedOutput.split("\n").filter((line) => line.trim().length > 0);
  const sources = webRunSourceLabels(lines);
  const metadata = webRunMetadataLine(lines);
  const highlights = webRunHighlightLine(lines);
  if (sources.length === 0 && !metadata && !highlights) {
    return undefined;
  }

  return formatWebRunSummary({
    sourceCount,
    sources,
    metadata,
    highlights,
    expanded: options.expanded,
  });
}

function webRunResultSummary(
  result: ThirdPartyToolResult,
  options: { readonly expanded: boolean },
): string | undefined {
  if (!isRecord(result.details)) {
    return undefined;
  }
  const sourceCount = getNumber(result.details, "sourceCount");
  const outputPath = getString(result.details, "fullOutputPath");
  if (sourceCount === undefined && !outputPath) {
    return undefined;
  }

  const inlineSummary = webRunOutputSummary(textOutput(result), sourceCount, options);
  if (inlineSummary) {
    return inlineSummary;
  }

  const fileSummary = outputPath
    ? webRunOutputSummary(readBoundedFileText(outputPath), sourceCount, options)
    : undefined;
  if (fileSummary) {
    return fileSummary;
  }

  return sourceCount === undefined
    ? undefined
    : `${sourceCount} source${sourceCount === 1 ? "" : "s"}`;
}

function coreCallLabel(toolName: string): string {
  return CORE_TOOL_LABELS.get(baseToolName(toolName)) ?? `Called ${displayToolName(toolName)}`;
}

function coreCallBody(
  toolName: string,
  args: unknown,
  theme: CodexRenderTheme,
): string | undefined {
  const normalized = baseToolName(toolName);
  if (normalized === "web_run") {
    return summarizeWebRunArgs(args);
  }
  if (normalized === "imagegen") {
    return summarizeImagegenArgs(args);
  }
  if (normalized === "view_image") {
    return summarizeViewImageArgs(args, theme);
  }
  return previewArgs(args);
}

function coreResultSummary(
  toolName: string,
  result: ThirdPartyToolResult,
  options: { readonly expanded: boolean },
): string | undefined {
  const normalized = baseToolName(toolName);
  if (normalized === "web_run") {
    return webRunResultSummary(result, options);
  }
  if (normalized === "imagegen") {
    return imagegenResultSummary(result);
  }
  return undefined;
}

function coreResultPreviewLines(toolName: string): number {
  return baseToolName(toolName) === "web_run" ? WEB_RUN_COLLAPSED_SOURCE_LIMIT + 2 : 2;
}

function createFinalizePlanRenderer(toolName: string): ThirdPartyToolRenderer {
  return {
    renderCall(_args, theme, context) {
      return renderThirdPartyCall(theme, {
        state: callState(context),
        statusText: coreCallLabel(toolName),
        body: undefined,
        maxRenderedLines: 1,
        expanded: context.expanded,
        expandable: false,
      });
    },
    renderResult(result, options, theme, context) {
      if (context.isError || options.isPartial) {
        return renderSimpleResult(theme, result, options);
      }
      return emptyComponent();
    },
  };
}

function createCoreRenderer(toolName: string): ThirdPartyToolRenderer {
  if (baseToolName(toolName) === "finalize_plan") {
    return createFinalizePlanRenderer(toolName);
  }

  return {
    renderCall(args, theme, context) {
      return renderThirdPartyCall(theme, {
        state: callState(context),
        statusText: coreCallLabel(toolName),
        body: coreCallBody(toolName, args, theme),
        maxRenderedLines: 4,
        expanded: context.expanded,
      });
    },
    renderResult(result, options, theme) {
      const summary = coreResultSummary(toolName, result, { expanded: options.expanded });
      if (summary) {
        return renderCodexOutput(theme, summary, {
          expanded: options.expanded,
          mode: "head",
          maxPreviewLines: coreResultPreviewLines(toolName),
          noOutputLabel: null,
        });
      }
      return renderSimpleResult(theme, result, options);
    },
  };
}

function createAgentRenderer(toolName: string): ThirdPartyToolRenderer {
  return createGenericRenderer(toolName, AGENT_TOOL_LABELS.get(baseToolName(toolName)));
}

function isGoalTool(toolName: string): boolean {
  const normalized = normalizeGoalToolName(toolName);
  return normalized === "get_goal" || normalized === "create_goal" || normalized === "update_goal";
}

function isCoreTool(toolName: string): boolean {
  return CORE_TOOL_LABELS.has(baseToolName(toolName));
}

function isAgentTool(toolName: string): boolean {
  return AGENT_TOOL_LABELS.has(baseToolName(toolName));
}

const DEFAULT_RENDERER_PLUGINS: ReadonlyArray<ThirdPartyToolRendererPlugin> = [
  {
    name: "browser-mcp-gateway",
    matches: (toolName) => toolName === "agent_browser" || toolName === "mcp",
    createRenderer: createBrowserRenderer,
  },
  {
    name: "chrome-devtools-mcp-tools",
    matches: hasChromeDevtoolsName,
    createRenderer: createMcpToolRenderer,
  },
  {
    name: "goal-tools",
    matches: isGoalTool,
    createRenderer: createGoalRenderer,
  },
  {
    name: "codex-core-tools",
    matches: isCoreTool,
    createRenderer: createCoreRenderer,
  },
  {
    name: "agent-tools",
    matches: isAgentTool,
    createRenderer: createAgentRenderer,
  },
];

function matcherMatches(toolName: string, matcher: ToolNameMatcher): boolean {
  if (typeof matcher === "string") {
    return matcher === toolName || matcher === baseToolName(toolName);
  }
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    const matchesToolName = matcher.test(toolName);
    matcher.lastIndex = 0;
    const matchesBaseName = matcher.test(baseToolName(toolName));
    matcher.lastIndex = 0;
    return matchesToolName || matchesBaseName;
  }
  return matcher(toolName);
}

function hasPreservePreference(toolDefinition: unknown): boolean {
  if (!isRecord(toolDefinition)) {
    return false;
  }
  return toolDefinition[CODEX_LOOK_RENDERING_PROPERTY] === "preserve";
}

/** Parses comma-separated tool names for `PI_CODEX_LOOK_PRESERVE_TOOLS`. */
export function parsePreservedThirdPartyToolNames(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** Returns whether Codex-look should leave a third-party tool renderer untouched. */
export function shouldPreserveThirdPartyToolRenderer(options: {
  readonly toolName: string;
  readonly toolDefinition: unknown;
  readonly renderingOptions?: ThirdPartyToolRenderingOptions;
}): boolean {
  if (options.renderingOptions?.enabled === false) {
    return true;
  }
  if (hasPreservePreference(options.toolDefinition)) {
    return true;
  }

  const preserveTools = options.renderingOptions?.preserveTools ?? [];
  return preserveTools.some((matcher) => matcherMatches(options.toolName, matcher));
}

/** Creates the best known Codex-look renderer for a third-party tool. */
export function createThirdPartyToolRenderer(
  toolName: string,
  options?: ThirdPartyToolRenderingOptions,
): ThirdPartyToolRenderer {
  const plugins = [...(options?.renderers ?? []), ...DEFAULT_RENDERER_PLUGINS];
  const plugin = plugins.find((candidate) => candidate.matches(toolName));
  return plugin?.createRenderer(toolName) ?? createGenericRenderer(toolName);
}
