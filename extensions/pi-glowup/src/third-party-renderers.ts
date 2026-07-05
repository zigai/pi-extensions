import type { Component } from "@earendil-works/pi-tui";
import { createApplyPatchRenderer } from "./apply-patch-rendering.ts";
import {
    emptyComponent,
    formatPathTarget,
    renderCodexCall,
    renderCodexOutput,
    type CodexCallState,
    type CodexRenderTheme,
} from "./rendering.ts";
import { detectStructuredOutputLanguage } from "./syntax/code-component.ts";
import { RENDER_THEME_TOKENS } from "./syntax/palette.ts";

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

type AskUserQuestionOption = {
    readonly label: string;
    readonly description: string | undefined;
    readonly hasPreview: boolean;
};

type AskUserQuestionItem = {
    readonly header: string | undefined;
    readonly question: string;
    readonly options: ReadonlyArray<AskUserQuestionOption>;
    readonly multiSelect: boolean;
};

type AskUserQuestionAnswer = {
    readonly question: string;
    readonly answer: string;
};

const MAX_PREVIEW_CHARACTERS = 700;
const MAX_PREVIEW_ARRAY_ITEMS = 20;
const MAX_PREVIEW_OBJECT_PROPERTIES = 30;
const MAX_WEB_RUN_HIGHLIGHTS = 3;
const WEB_RUN_COLLAPSED_SOURCE_LIMIT = 4;
const WEB_RUN_EXPANDED_SOURCE_LIMIT = 100;
const NAMESPACED_TOOL_PREFIX_PATTERN = /^[A-Za-z0-9_-]+__(?<name>.+)$/;
const CHROME_DEVTOOLS_PREFIX_PATTERN = /(?:^|__)chrome[-_]?devtools(?:__|_|$)/i;
const WEB_RUN_TITLE_URL_PATTERN = /^(?<title>.+?)\s+\((?<url>https?:\/\/[^)]+)\)$/u;
const WEB_RUN_TOTAL_LINES_PATTERN = /Total lines:\s*(?<lines>\d+)/u;
const WEB_RUN_CONTENT_TYPE_PATTERN = /Content type:\s*(?<type>[^;]+)/u;
const WEB_RUN_SOURCE_PATTERN = /Source:\s*(?<source>[^;]+)/u;
const WEB_RUN_LINE_PATTERN = /^L\d+:\s*(?<text>.*)$/u;
const WEB_RUN_CITATION_PATTERN = /cite[^]*/gu;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gu;

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

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

function isNonEmptyString(value: string | undefined): value is string {
    return value !== undefined && value.length > 0;
}

function getString(record: UnknownRecord, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function getNonEmptyString(record: UnknownRecord, key: string): string | undefined {
    const value = getString(record, key);
    return isNonEmptyString(value) ? value : undefined;
}

function getNumber(record: UnknownRecord, key: string): number | undefined {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getBoolean(record: UnknownRecord, key: string): boolean | undefined {
    const value = record[key];
    return typeof value === "boolean" ? value : undefined;
}

function getArray(record: UnknownRecord, key: string): ReadonlyArray<unknown> | undefined {
    const value = record[key];
    return Array.isArray(value) ? value : undefined;
}

function displayToolName(toolName: string): string {
    return toolName.length > 0 ? toolName : "tool";
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
        return value.description === undefined || value.description.length === 0
            ? "Symbol"
            : `Symbol(${value.description})`;
    }
    if (typeof value === "function") {
        return value.name.length > 0 ? `[Function ${value.name}]` : "[Function]";
    }

    const seen = new WeakSet<object>();
    try {
        const json = JSON.stringify(
            value,
            (_key, nestedValue: unknown) => {
                return boundedPreviewValue(nestedValue, seen);
            },
            2,
        );
        return json;
    } catch (cause: unknown) {
        if (cause instanceof Error) {
            return cause.message;
        }
        if (typeof cause === "string") {
            return cause;
        }
        return undefined;
    }
}

function boundedPreviewValue(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") {
        return truncateText(value, MAX_PREVIEW_CHARACTERS);
    }
    if (typeof value === "bigint") {
        return `${value.toString()}n`;
    }
    if (typeof value === "function") {
        return value.name.length > 0 ? `[Function ${value.name}]` : "[Function]";
    }
    if (typeof value === "symbol") {
        return value.description === undefined || value.description.length === 0
            ? "Symbol"
            : `Symbol(${value.description})`;
    }
    if (typeof value !== "object" || value === null) {
        return value;
    }
    if (seen.has(value)) {
        return "[Circular]";
    }
    seen.add(value);

    if (Array.isArray(value) && value.length > MAX_PREVIEW_ARRAY_ITEMS) {
        return [
            ...value.slice(0, MAX_PREVIEW_ARRAY_ITEMS),
            `… +${value.length - MAX_PREVIEW_ARRAY_ITEMS} items`,
        ];
    }
    if (!Array.isArray(value)) {
        return boundedPreviewObject(value);
    }
    return value;
}

function boundedPreviewObject(value: object): object {
    const output: Record<string, unknown> = {};
    let copied = 0;
    let omitted = 0;

    for (const key in value) {
        if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
            continue;
        }
        if (copied < MAX_PREVIEW_OBJECT_PROPERTIES) {
            output[key] = Reflect.get(value, key);
            copied += 1;
        } else {
            omitted += 1;
        }
    }

    if (omitted === 0) {
        return value;
    }

    output["…"] = `+${omitted} properties`;
    return output;
}

function trimAndTruncateText(text: string, maxCharacters: number): string | undefined {
    let start = 0;
    let end = text.length;
    while (start < end && text.charAt(start).trim().length === 0) {
        start += 1;
    }
    while (end > start && text.charAt(end - 1).trim().length === 0) {
        end -= 1;
    }
    if (start === end) {
        return undefined;
    }
    if (end - start <= maxCharacters) {
        return text.slice(start, end);
    }
    return `${text.slice(start, start + Math.max(0, maxCharacters - 1))}…`;
}

function previewValue(value: unknown): string | undefined {
    if (typeof value === "string") {
        return trimAndTruncateText(value, MAX_PREVIEW_CHARACTERS);
    }

    const preview = stringifyPreview(value)?.trim();
    if (preview === undefined || preview.length === 0 || preview === "{}" || preview === "[]") {
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

    let firstText: string | undefined;
    let texts: string[] | undefined;
    for (const item of content) {
        if (!isRecord(item)) {
            continue;
        }
        const contentItem: TextContent = item;
        if (contentItem.type !== "text" || typeof contentItem.text !== "string") {
            continue;
        }
        if (firstText === undefined) {
            firstText = contentItem.text;
            continue;
        }
        texts ??= [firstText];
        texts.push(contentItem.text);
    }

    return texts === undefined ? firstText : texts.join("\n");
}

function compactWhitespaceText(text: string, maxCharacters: number): string | undefined {
    let output = "";
    let pendingWhitespace = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index] ?? "";
        if (char.trim().length === 0) {
            pendingWhitespace = output.length > 0;
            continue;
        }
        if (pendingWhitespace) {
            if (output.length >= maxCharacters - 1) {
                return `${output.slice(0, Math.max(0, maxCharacters - 1))}…`;
            }
            output += " ";
            pendingWhitespace = false;
        }
        if (output.length >= maxCharacters) {
            return `${output.slice(0, Math.max(0, maxCharacters - 1))}…`;
        }
        output += char;
    }

    return output.length > 0 ? output : undefined;
}

function compactQuotedText(text: string | undefined, maxCharacters = 96): string | undefined {
    if (text === undefined || text.length === 0) {
        return undefined;
    }
    const compact = compactWhitespaceText(text, maxCharacters);
    return compact === undefined ? undefined : `"${compact}"`;
}

function countedSummary(
    label: string,
    values: ReadonlyArray<unknown> | undefined,
): string | undefined {
    if (values === undefined || values.length === 0) {
        return undefined;
    }
    const prefix = label.length > 0 ? `${label} ` : "";
    const first = values[0];
    if (isRecord(first)) {
        const query =
            getString(first, "q") ?? getString(first, "ref_id") ?? getString(first, "url");
        const quoted = compactQuotedText(query);
        if (quoted !== undefined) {
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
        ...(language === undefined ? {} : { syntax: { language } }),
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
        const action = getNonEmptyString(args.electron, "action");
        const appName =
            getNonEmptyString(args.electron, "appName") ??
            getNonEmptyString(args.electron, "bundleId");
        const summary = [action, appName].filter(isDefined).join(" ");
        return {
            label: BROWSER_COMMAND_LABELS.get("electron") ?? "Electron",
            body: summary.length > 0 ? summary : previewArgs(args.electron),
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
            return {
                label: BROWSER_COMMAND_LABELS.get(key) ?? "Browser",
                body: previewArgs(args[key]),
            };
        }
    }

    const commandArgs = getArray(args, "args");
    const rawCommand = commandArgs?.[0];
    const command =
        typeof rawCommand === "string" && rawCommand.length > 0 ? rawCommand : undefined;
    if (command !== undefined && commandArgs !== undefined) {
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

    const tool =
        getNonEmptyString(args, "tool") ??
        getNonEmptyString(args, "describe") ??
        getNonEmptyString(args, "search");
    if (tool !== undefined) {
        return {
            label: MCP_COMMAND_LABELS.get(tool) ?? `MCP ${tool}`,
            body: previewArgs(args.args ?? args),
        };
    }

    const connect = getNonEmptyString(args, "connect") ?? getNonEmptyString(args, "server");
    if (connect !== undefined) {
        return { label: "MCP Connect", body: connect };
    }

    return { label: "MCP", body: previewArgs(args) };
}

function createBrowserRenderer(toolName: string): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const summary =
                toolName === "mcp" ? summarizeMcpArgs(args) : summarizeBrowserArgs(args);
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

    const objective = getNonEmptyString(value, "objective");
    const status = getNonEmptyString(value, "status");
    if (objective === undefined || status === undefined) {
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
    if (output === undefined || output.length === 0) {
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

function getBracketOpener(closingBracket: string): string {
    if (closingBracket === ")") {
        return "(";
    }
    if (closingBracket === "]") {
        return "[";
    }
    return "{";
}

function trimUrlEnd(text: string): string {
    let result = text.replace(/[.,;:!?]+$/u, "");
    while (result.length > 0) {
        const last = result.at(-1);
        if (last !== ")" && last !== "]" && last !== "}") {
            break;
        }

        const opener = getBracketOpener(last);
        const openingCount = result.split(opener).length - 1;
        const closingCount = result.split(last).length - 1;
        if (closingCount <= openingCount) {
            break;
        }
        result = result.slice(0, -1);
    }
    return result;
}

function styleUrlText(theme: CodexRenderTheme, text: string): string {
    return theme.fg(RENDER_THEME_TOKENS.url, text);
}

function highlightUrlText(theme: CodexRenderTheme, text: string): string {
    let output = "";
    let cursor = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
        if (match.index === undefined) {
            continue;
        }

        const rawUrl = match[0];
        const url = trimUrlEnd(rawUrl);
        if (url.length === 0) {
            continue;
        }

        const start = match.index;
        const end = start + url.length;
        output += text.slice(cursor, start);
        output += styleUrlText(theme, url);
        cursor = end;
    }

    if (cursor === 0) {
        return text;
    }
    return `${output}${text.slice(cursor)}`;
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
            if (formatted !== undefined && formatted.length > 0) {
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

function summarizeWebRunArgs(args: unknown, theme: CodexRenderTheme): string | undefined {
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
        .filter(isDefined);
    return parts.length > 0 ? highlightUrlText(theme, parts.join(" • ")) : previewArgs(args);
}

function summarizeImagegenArgs(args: unknown): string | undefined {
    if (!isRecord(args)) {
        return previewArgs(args);
    }
    const prompt = compactQuotedText(getString(args, "prompt"), 140);
    const referenced = getArray(args, "referenced_image_paths") ?? getArray(args, "images");
    const recentCount = getNumber(args, "num_last_images_to_include");
    const metadata = [
        referenced !== undefined && referenced.length > 0 ? `${referenced.length} refs` : undefined,
        recentCount === undefined ? undefined : `${recentCount} recent`,
    ].filter(isDefined);
    const summary = [prompt, metadata.join(" • ")].filter(isNonEmptyString).join("\n");
    return summary.length > 0 ? summary : undefined;
}

function summarizeViewImageArgs(args: unknown, theme: CodexRenderTheme): string | undefined {
    if (!isRecord(args)) {
        return previewArgs(args);
    }
    const path =
        getString(args, "path") ?? getString(args, "file_path") ?? getString(args, "image_path");
    const detail = getString(args, "detail");
    const pathText = isNonEmptyString(path) ? formatPathTarget(theme, path) : undefined;
    const detailText = isNonEmptyString(detail) ? `detail: ${detail}` : undefined;
    const summary = [pathText, detailText].filter(isDefined).join(" · ");
    return summary.length > 0 ? summary : undefined;
}

function imagegenResultSummary(result: ThirdPartyToolResult): string | undefined {
    if (!isRecord(result.details)) {
        return undefined;
    }
    const images = getArray(result.details, "images");
    if (images === undefined || images.length === 0) {
        return undefined;
    }
    const first = images[0];
    const path = isRecord(first)
        ? (getString(first, "latestPath") ?? getString(first, "path"))
        : undefined;
    return `Generated ${images.length} image${images.length === 1 ? "" : "s"}${isNonEmptyString(path) ? ` → ${path}` : ""}`;
}

function hasNonWhitespaceText(text: string): boolean {
    for (let index = 0; index < text.length; index += 1) {
        if (text.charAt(index).trim().length > 0) {
            return true;
        }
    }
    return false;
}

function visitNormalizedOutputLines(text: string, visit: (line: string) => void): boolean {
    let lineStart = 0;
    let sawLine = false;

    for (let index = 0; index <= text.length; index += 1) {
        if (index < text.length) {
            const charCode = text.charCodeAt(index);
            if (charCode !== 10 && charCode !== 13) {
                continue;
            }
        }

        const line = text.slice(lineStart, index);
        if (hasNonWhitespaceText(line)) {
            sawLine = true;
            visit(line);
        }

        if (
            index < text.length &&
            text.charCodeAt(index) === 13 &&
            text.charCodeAt(index + 1) === 10
        ) {
            index += 1;
        }
        lineStart = index + 1;
    }

    return sawLine;
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

function formatWebRunSourceLabel(theme: CodexRenderTheme, text: string): string | undefined {
    const match = WEB_RUN_TITLE_URL_PATTERN.exec(text.trim());
    const groups = match?.groups;
    if (!groups) {
        return undefined;
    }

    const url = groups.url ?? "";
    const sourceUrl = styleUrlText(theme, compactUrl(url));
    if (!isUsefulWebRunTitle(groups.title ?? "")) {
        return sourceUrl;
    }
    return `${truncateText(normalizeWebRunText(groups.title ?? ""), 72)} — ${sourceUrl}`;
}

type WebRunSourceCollection = {
    readonly labels: string[];
    readonly seenLabels: Set<string>;
    readonly maxLabels: number | undefined;
    readonly sourceCountKnown: boolean;
    count: number;
};

function collectWebRunSourceLabel(
    theme: CodexRenderTheme,
    line: string,
    collection: WebRunSourceCollection,
): void {
    const label = formatWebRunSourceLabel(theme, line);
    if (label === undefined || label.length === 0) {
        return;
    }

    if (
        collection.sourceCountKnown &&
        collection.maxLabels !== undefined &&
        collection.labels.length >= collection.maxLabels
    ) {
        return;
    }

    const key = label.toLowerCase();
    if (collection.seenLabels.has(key)) {
        return;
    }

    collection.seenLabels.add(key);
    collection.count += 1;
    if (collection.maxLabels === undefined || collection.labels.length < collection.maxLabels) {
        collection.labels.push(label);
    }
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
    if (options.expanded && isNonEmptyString(options.metadata)) {
        details.push(`metadata: ${options.metadata}`);
    }
    if (options.expanded && isNonEmptyString(options.highlights)) {
        details.push(`preview: ${options.highlights}`);
    }

    if (headline === undefined && details.length === 0) {
        return undefined;
    }
    return [headline, ...details].filter(isDefined).join("\n");
}

function compactWebRunSource(source: string): string {
    const normalized = source
        .replace(/\(\{.+\}/u, "(")
        .replace(/\s+/gu, " ")
        .trim();
    return truncateText(normalized, 48);
}

function webRunMetadataFromLine(line: string): string | undefined {
    if (!WEB_RUN_CONTENT_TYPE_PATTERN.test(line)) {
        return undefined;
    }

    const contentType = WEB_RUN_CONTENT_TYPE_PATTERN.exec(line)?.groups?.type?.trim();
    const source = WEB_RUN_SOURCE_PATTERN.exec(line)?.groups?.source?.trim();
    const totalLines = WEB_RUN_TOTAL_LINES_PATTERN.exec(line)?.groups?.lines;
    const parts = [
        isNonEmptyString(source) ? compactWebRunSource(source) : undefined,
        contentType,
        isNonEmptyString(totalLines) ? `${totalLines} lines` : undefined,
    ].filter(isDefined);
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

type WebRunHighlightCandidate = {
    readonly text: string;
    readonly index: number;
    readonly score: number;
};

type WebRunHighlightCollection = {
    readonly candidates: WebRunHighlightCandidate[];
    nextIndex: number;
};

function collectWebRunHighlight(line: string, collection: WebRunHighlightCollection): void {
    const match = WEB_RUN_LINE_PATTERN.exec(line.trim());
    const rawText = match?.groups?.text;
    if (rawText === undefined) {
        return;
    }

    const normalized = normalizeWebRunText(rawText);
    const key = normalized.toLowerCase();
    if (
        normalized.length === 0 ||
        isWebRunBoilerplate(normalized) ||
        collection.candidates.some((candidate) => candidate.text.toLowerCase() === key)
    ) {
        return;
    }

    collection.candidates.push({
        text: normalized,
        index: collection.nextIndex,
        score: webRunHighlightScore(normalized),
    });
    collection.nextIndex += 1;
    collection.candidates.sort(
        (left, right) => right.score - left.score || left.index - right.index,
    );
    if (collection.candidates.length > MAX_WEB_RUN_HIGHLIGHTS) {
        collection.candidates.pop();
    }
}

function formatWebRunHighlights(
    candidates: ReadonlyArray<WebRunHighlightCandidate>,
): string | undefined {
    if (candidates.length === 0) {
        return undefined;
    }

    return [...candidates]
        .sort((left, right) => left.index - right.index)
        .map((highlight) => truncateText(highlight.text, 115))
        .join(" · ");
}

function webRunOutputSummary(
    theme: CodexRenderTheme,
    output: string | undefined,
    sourceCount: number | undefined,
    options: { readonly expanded: boolean },
): string | undefined {
    if (output === undefined || output.length === 0) {
        return undefined;
    }

    const sourceCollection: WebRunSourceCollection = {
        labels: [],
        seenLabels: new Set<string>(),
        maxLabels: options.expanded
            ? WEB_RUN_EXPANDED_SOURCE_LIMIT
            : WEB_RUN_COLLAPSED_SOURCE_LIMIT,
        sourceCountKnown: sourceCount !== undefined,
        count: 0,
    };
    const highlightCollection: WebRunHighlightCollection = {
        candidates: [],
        nextIndex: 0,
    };
    let metadata: string | undefined;

    const sawOutput = visitNormalizedOutputLines(output, (line) => {
        collectWebRunSourceLabel(theme, line, sourceCollection);
        metadata ??= webRunMetadataFromLine(line);
        collectWebRunHighlight(line, highlightCollection);
    });
    if (!sawOutput) {
        return undefined;
    }

    const highlights = formatWebRunHighlights(highlightCollection.candidates);
    if (
        sourceCollection.count === 0 &&
        !isNonEmptyString(metadata) &&
        !isNonEmptyString(highlights)
    ) {
        return undefined;
    }

    return formatWebRunSummary({
        sourceCount: sourceCount ?? sourceCollection.count,
        sources: sourceCollection.labels,
        metadata,
        highlights,
        expanded: options.expanded,
    });
}

function webRunResultSummary(
    theme: CodexRenderTheme,
    result: ThirdPartyToolResult,
    options: { readonly expanded: boolean },
): string | undefined {
    if (!isRecord(result.details)) {
        return undefined;
    }
    const sourceCount = getNumber(result.details, "sourceCount");
    const outputPath = getString(result.details, "fullOutputPath");
    if (sourceCount === undefined && outputPath === undefined) {
        return undefined;
    }

    const inlineSummary = webRunOutputSummary(theme, textOutput(result), sourceCount, options);
    if (inlineSummary !== undefined) {
        return inlineSummary;
    }

    if (sourceCount !== undefined) {
        return `${sourceCount} source${sourceCount === 1 ? "" : "s"}`;
    }

    return outputPath === undefined ? undefined : "Full output saved";
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
        return summarizeWebRunArgs(args, theme);
    }
    if (normalized === "imagegen") {
        return summarizeImagegenArgs(args);
    }
    if (normalized === "view_image") {
        return summarizeViewImageArgs(args, theme);
    }
    return previewArgs(args);
}

function parseAskUserQuestionOption(value: unknown): AskUserQuestionOption | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const label = getNonEmptyString(value, "label");
    if (label === undefined) {
        return undefined;
    }

    return {
        label,
        description: getString(value, "description"),
        hasPreview: getNonEmptyString(value, "preview") !== undefined,
    };
}

function parseAskUserQuestionItem(value: unknown): AskUserQuestionItem | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const question = getNonEmptyString(value, "question");
    if (question === undefined) {
        return undefined;
    }

    const rawOptions = getArray(value, "options") ?? [];
    const options = rawOptions.map(parseAskUserQuestionOption).filter(isDefined);
    return {
        header: getNonEmptyString(value, "header"),
        question,
        options,
        multiSelect: getBoolean(value, "multiSelect") === true,
    };
}

function parseAskUserQuestions(args: unknown): ReadonlyArray<AskUserQuestionItem> {
    if (!isRecord(args)) {
        return [];
    }

    const rawQuestions = getArray(args, "questions") ?? [];
    return rawQuestions.map(parseAskUserQuestionItem).filter(isDefined);
}

function formatAskUserQuestionHeadline(
    theme: CodexRenderTheme,
    item: AskUserQuestionItem,
    index: number,
    totalQuestions: number,
): string {
    const header = item.header ?? (totalQuestions > 1 ? `Question ${index + 1}` : undefined);
    if (header === undefined) {
        return item.question;
    }
    return `${theme.fg("accent", header)} ${theme.fg("dim", "·")} ${item.question}`;
}

function formatAskUserQuestionOptions(
    theme: CodexRenderTheme,
    item: AskUserQuestionItem,
    expanded: boolean,
): ReadonlyArray<string> {
    if (item.options.length === 0) {
        return [];
    }

    const choiceLabel = item.multiSelect ? "Choose any" : "Choose one";
    if (!expanded) {
        const labels = item.options.map((option) => option.label).join(" · ");
        return [`${theme.fg("muted", `${choiceLabel}:`)} ${labels}`];
    }

    return [
        theme.fg("muted", `${choiceLabel}:`),
        ...item.options.map((option) => {
            const description = isNonEmptyString(option.description)
                ? ` — ${option.description}`
                : "";
            const preview = option.hasPreview ? theme.fg("dim", " (preview)") : "";
            return `  ${theme.fg("dim", "○")} ${option.label}${description}${preview}`;
        }),
    ];
}

function summarizeAskUserQuestionArgs(
    args: unknown,
    theme: CodexRenderTheme,
    expanded: boolean,
): string | undefined {
    const questions = parseAskUserQuestions(args);
    if (questions.length === 0) {
        return previewArgs(args);
    }

    const lines: string[] = [];
    for (const [index, item] of questions.entries()) {
        if (index > 0) {
            lines.push("");
        }
        lines.push(formatAskUserQuestionHeadline(theme, item, index, questions.length));
        lines.push(...formatAskUserQuestionOptions(theme, item, expanded));
    }

    return lines.join("\n");
}

const ASK_USER_QUESTION_ANSWER_PATTERN =
    /"(?<rawQuestion>(?:\\.|[^"\\])*)"\s*=\s*"(?<rawAnswer>(?:\\.|[^"\\])*)"/gu;

function decodeAskUserQuotedText(rawText: string): string {
    try {
        const parsed: unknown = JSON.parse(`"${rawText}"`);
        if (typeof parsed === "string") {
            return parsed;
        }
    } catch {
        return rawText.replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
    }
    return rawText;
}

function parseAskUserQuestionAnswers(output: string): ReadonlyArray<AskUserQuestionAnswer> {
    const answers: AskUserQuestionAnswer[] = [];
    for (const match of output.matchAll(ASK_USER_QUESTION_ANSWER_PATTERN)) {
        const rawQuestion = match.groups?.rawQuestion;
        const rawAnswer = match.groups?.rawAnswer;
        if (rawQuestion === undefined || rawAnswer === undefined) {
            continue;
        }

        answers.push({
            question: decodeAskUserQuotedText(rawQuestion),
            answer: decodeAskUserQuotedText(rawAnswer),
        });
    }

    return answers;
}

function findAskUserQuestionItem(
    questions: ReadonlyArray<AskUserQuestionItem>,
    answer: AskUserQuestionAnswer,
    answerIndex: number,
): AskUserQuestionItem | undefined {
    return questions.find((item) => item.question === answer.question) ?? questions[answerIndex];
}

function summarizeAskUserQuestionResult(
    result: ThirdPartyToolResult,
    args: unknown,
    theme: CodexRenderTheme,
    expanded: boolean,
): string | undefined {
    const output = textOutput(result);
    if (output === undefined || output.length === 0) {
        return undefined;
    }

    const answers = parseAskUserQuestionAnswers(output);
    if (answers.length === 0) {
        return undefined;
    }

    const questions = parseAskUserQuestions(args);
    const lines: string[] = [];
    for (const [index, answer] of answers.entries()) {
        const item = findAskUserQuestionItem(questions, answer, index);
        const header = item?.header ?? (answers.length > 1 ? `Question ${index + 1}` : "Answer");
        lines.push(
            `${theme.fg("success", "✓")} ${theme.fg("accent", header)} ${theme.fg("muted", "→")} ${answer.answer}`,
        );
        if (expanded || answers.length === 1) {
            lines.push(theme.fg("dim", answer.question));
        }
    }

    return lines.join("\n");
}

function createAskUserQuestionRenderer(toolName: string): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: coreCallLabel(toolName),
                body: summarizeAskUserQuestionArgs(args, theme, context.expanded),
                maxRenderedLines: 5,
                expanded: context.expanded,
            });
        },
        renderResult(result, options, theme, context) {
            const summary = summarizeAskUserQuestionResult(
                result,
                context.args,
                theme,
                options.expanded,
            );
            if (summary !== undefined && summary.length > 0) {
                return renderCodexOutput(theme, summary, {
                    expanded: options.expanded,
                    mode: "head",
                    maxPreviewLines: 6,
                    dimContent: false,
                    noOutputLabel: null,
                });
            }
            return renderSimpleResult(theme, result, options);
        },
    };
}

function coreResultSummary(
    toolName: string,
    result: ThirdPartyToolResult,
    theme: CodexRenderTheme,
    options: { readonly expanded: boolean },
): string | undefined {
    const normalized = baseToolName(toolName);
    if (normalized === "web_run") {
        return webRunResultSummary(theme, result, options);
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
    if (baseToolName(toolName) === "ask_user_question") {
        return createAskUserQuestionRenderer(toolName);
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
            const summary = coreResultSummary(toolName, result, theme, {
                expanded: options.expanded,
            });
            if (summary !== undefined && summary.length > 0) {
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

function agentCallLabel(toolName: string): string {
    return AGENT_TOOL_LABELS.get(baseToolName(toolName)) ?? `Called ${displayToolName(toolName)}`;
}

function displaySubagentType(value: string | undefined): string | undefined {
    if (!isNonEmptyString(value) || value === ".") {
        return undefined;
    }
    return value;
}

function summarizeAgentLaunchArgs(args: unknown): string | undefined {
    if (!isRecord(args)) {
        return previewArgs(args);
    }

    const description = getNonEmptyString(args, "description");
    const prompt = compactQuotedText(getString(args, "prompt"), 120);
    const subagentType = displaySubagentType(getString(args, "subagent_type"));
    const isolation = getNonEmptyString(args, "isolation");
    const model = getNonEmptyString(args, "model");
    const thinking = getNonEmptyString(args, "thinking");
    const schedule = getNonEmptyString(args, "schedule");
    const maxTurns = getNumber(args, "max_turns");
    const metadata = [
        isNonEmptyString(subagentType) ? `${subagentType} agent` : undefined,
        getBoolean(args, "run_in_background") === true ? "running in background" : undefined,
        getBoolean(args, "inherit_context") === true ? "inherits context" : undefined,
        isolation === "worktree" ? "isolated worktree" : undefined,
        isNonEmptyString(isolation) && isolation !== "worktree"
            ? `isolation: ${isolation}`
            : undefined,
        isNonEmptyString(model) ? `model: ${model}` : undefined,
        isNonEmptyString(thinking) ? `thinking: ${thinking}` : undefined,
        maxTurns === undefined ? undefined : `max ${compactInteger(maxTurns)} turns`,
        isNonEmptyString(schedule) ? `scheduled ${schedule}` : undefined,
    ].filter(isDefined);

    const summary = [description ?? prompt, metadata.join(" · ")]
        .filter(isNonEmptyString)
        .join("\n");
    return summary.length > 0 ? summary : previewArgs(args);
}

function summarizeSubagentLookupArgs(args: unknown): string | undefined {
    if (!isRecord(args)) {
        return previewArgs(args);
    }

    const agentId = getNonEmptyString(args, "agent_id") ?? getNonEmptyString(args, "agentId");
    const metadata = [
        getBoolean(args, "wait") === true ? "wait" : undefined,
        getBoolean(args, "verbose") === true ? "verbose" : undefined,
    ].filter(isDefined);
    const summary = [agentId, metadata.join(" · ")].filter(isNonEmptyString).join(" · ");
    return summary.length > 0 ? summary : previewArgs(args);
}

function summarizeSubagentSteerArgs(args: unknown): string | undefined {
    if (!isRecord(args)) {
        return previewArgs(args);
    }

    const agentId = getNonEmptyString(args, "agent_id") ?? getNonEmptyString(args, "agentId");
    const message = compactQuotedText(getString(args, "message"), 140);
    const summary = [agentId, message].filter(isNonEmptyString).join("\n");
    return summary.length > 0 ? summary : previewArgs(args);
}

function agentCallBody(toolName: string, args: unknown): string | undefined {
    const normalized = baseToolName(toolName);
    if (normalized === "Agent" || normalized === "agent") {
        return summarizeAgentLaunchArgs(args);
    }
    if (normalized === "get_subagent_result") {
        return summarizeSubagentLookupArgs(args);
    }
    if (normalized === "steer_subagent") {
        return summarizeSubagentSteerArgs(args);
    }
    return previewArgs(args);
}

function isWhitespaceChar(text: string, index: number): boolean {
    return text.charAt(index).trim().length === 0;
}

function normalizeAgentResultLine(line: string): string {
    let start = 0;
    let end = line.length;
    while (start < end && isWhitespaceChar(line, start)) {
        start += 1;
    }
    if (line[start] === "└" || line[start] === "│") {
        start += 1;
        while (start < end && isWhitespaceChar(line, start)) {
            start += 1;
        }
    }
    while (end > start && isWhitespaceChar(line, end - 1)) {
        end -= 1;
    }
    return start === 0 && end === line.length ? line : line.slice(start, end);
}

function formatAgentStatusMetric(metric: string): string | undefined {
    const [rawLabel, ...rawValueParts] = metric.split(":");
    const label = rawLabel?.trim();
    const value = rawValueParts.join(":").trim();
    if (label === undefined || label.length === 0 || value.length === 0) {
        const trimmed = metric.trim();
        return trimmed.length > 0 ? trimmed.replace(/\s+tokens?$/iu, " tok") : undefined;
    }

    const normalizedLabel = label.toLowerCase();
    if (normalizedLabel === "tool uses") {
        return `${value} tools`;
    }
    if (normalizedLabel === "duration") {
        return value;
    }
    if (normalizedLabel === "context") {
        return `context ${value}`;
    }
    if (normalizedLabel === "tokens" || normalizedLabel === "token") {
        return `${value} tok`;
    }
    return `${normalizedLabel} ${value}`;
}

function subagentCompletionSummary(output: string): string | undefined {
    let agentLine: string | undefined;
    let statusLine: string | undefined;
    const bullets: string[] = [];

    visitNormalizedOutputLines(output, (line) => {
        const normalized = normalizeAgentResultLine(line);
        if (agentLine === undefined && normalized.startsWith("Agent:")) {
            agentLine = normalized;
        }
        if (statusLine === undefined && normalized.startsWith("Type:")) {
            statusLine = normalized;
        }
        if (bullets.length < 4 && /^[-•]\s+/u.test(normalized)) {
            bullets.push(normalized);
        }
    });

    if (!isNonEmptyString(agentLine) && !isNonEmptyString(statusLine)) {
        return undefined;
    }

    const agentId = agentLine?.replace(/^Agent:\s*/u, "").trim();
    const statusParts =
        statusLine
            ?.split("|")
            .map((part) => part.trim())
            .filter((part) => part.length > 0) ?? [];
    const type = statusParts[0]?.replace(/^Type:\s*/u, "").trim();
    const status = statusParts[1]?.replace(/^Status:\s*/u, "").trim();
    const metrics = statusParts.slice(2).map(formatAgentStatusMetric).filter(isDefined);
    const headline = [status, type, agentId].filter(isNonEmptyString).join(" · ");
    const metadata = metrics.length > 0 ? metrics.join(" · ") : undefined;

    return [headline, metadata, ...bullets].filter(isNonEmptyString).join("\n");
}

function subagentLaunchSummary(output: string): string | undefined {
    let sawAgentStart = false;
    let mode: string | undefined;
    let agentId: string | undefined;
    const notes: string[] = [];

    visitNormalizedOutputLines(output, (line) => {
        const normalized = normalizeAgentResultLine(line);
        const startMatch = /Agent started(?<mode>[^.\n]*)\./iu.exec(normalized);
        if (startMatch !== null) {
            sawAgentStart = true;
            mode ??= startMatch.groups?.mode?.trim();
        }
        agentId ??= /Agent ID:\s*(?<nextAgentId>\S+)/iu.exec(normalized)?.groups?.nextAgentId;
        if (
            notes.length < 3 &&
            (normalized.startsWith("Do not duplicate") ||
                normalized.startsWith("Worktree:") ||
                normalized.startsWith("Branch:"))
        ) {
            notes.push(normalized);
        }
    });

    if (!sawAgentStart && !isNonEmptyString(agentId)) {
        return undefined;
    }

    const headline = [`started${isNonEmptyString(mode) ? ` ${mode}` : ""}`, agentId]
        .filter(isNonEmptyString)
        .join(" · ");
    return [headline, ...notes].filter(isNonEmptyString).join("\n");
}

function agentResultSummary(result: ThirdPartyToolResult): string | undefined {
    const output = textOutput(result);
    if (output === undefined || output.length === 0) {
        return undefined;
    }
    return subagentCompletionSummary(output) ?? subagentLaunchSummary(output);
}

function createAgentRenderer(toolName: string): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: agentCallLabel(toolName),
                body: agentCallBody(toolName, args),
                maxRenderedLines: 4,
                expanded: context.expanded,
            });
        },
        renderResult(result, options, theme) {
            const summary = agentResultSummary(result);
            if (summary !== undefined && summary.length > 0) {
                return renderCodexOutput(theme, summary, {
                    expanded: options.expanded,
                    mode: "head",
                    maxPreviewLines: 6,
                    noOutputLabel: null,
                });
            }
            return renderSimpleResult(theme, result, options);
        },
    };
}

function isGoalTool(toolName: string): boolean {
    const normalized = normalizeGoalToolName(toolName);
    return (
        normalized === "get_goal" || normalized === "create_goal" || normalized === "update_goal"
    );
}

function isApplyPatchTool(toolName: string): boolean {
    return baseToolName(toolName) === "apply_patch";
}

function isCoreTool(toolName: string): boolean {
    return CORE_TOOL_LABELS.has(baseToolName(toolName));
}

function isAgentTool(toolName: string): boolean {
    return AGENT_TOOL_LABELS.has(baseToolName(toolName));
}

const DEFAULT_RENDERER_PLUGINS: ReadonlyArray<ThirdPartyToolRendererPlugin> = [
    {
        name: "apply-patch",
        matches: isApplyPatchTool,
        createRenderer: createApplyPatchRenderer,
    },
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
    if (value === undefined || value.length === 0) {
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
