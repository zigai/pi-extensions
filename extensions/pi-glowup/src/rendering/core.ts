import { keyHint, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
    truncateToWidth,
    type Component,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import ansiStyles from "ansi-styles";
import { highlightCodeOutput, type CodeOutputSyntax } from "../syntax/code-component.ts";
import { highlightSyntaxCode } from "../syntax/highlighter.ts";

const ANSI_SEQUENCE_PREFIX = ansiStyles.modifier.reset.open.slice(0, 2);
const ROW_BACKGROUND_SAFE_RESET = `${ansiStyles.modifier.bold.close}${ansiStyles.modifier.italic.close}${ansiStyles.modifier.underline.close}${ansiStyles.modifier.strikethrough.close}${ansiStyles.color.close}`;

type CodexRenderBg = "toolSuccessBg" | "toolErrorBg";

export type CodexRenderTheme = {
    readonly fg: (token: ThemeColor, text: string) => string;
    readonly bg?: (token: CodexRenderBg, text: string) => string;
    readonly bold: (text: string) => string;
};

export type DiffSection = {
    readonly path?: string;
    readonly lines: ReadonlyArray<string>;
    readonly added: number;
    readonly removed: number;
};

export type ReadActionArgs = {
    readonly path?: string;
    readonly offset?: number;
    readonly limit?: number;
};

export type FindActionArgs = {
    readonly pattern?: string;
    readonly path?: string;
    readonly limit?: number;
};

export type GrepActionArgs = {
    readonly pattern?: string;
    readonly path?: string;
    readonly glob?: string;
    readonly limit?: number;
};

export type LsActionArgs = {
    readonly path?: string;
    readonly limit?: number;
};

export type CodexCallState = "running" | "success" | "error" | "muted";

export type MutationSummary = {
    readonly label: string;
    readonly path: string;
    readonly added: number;
    readonly removed: number;
};

export type ScriptInvocation = {
    readonly label: string;
    readonly language: string;
    readonly code: string;
};

export type ScriptPreviewHeaderLayout = "auto" | "inline" | "block";

type ScriptPreview = {
    readonly code: string;
};

const diffLinePattern = /^([+\- ])(\s*\d*)\s(.*)$/;
const ellipsisLinePattern = /^\s+\.\.\.$/;
const addCountPattern = /^\+\s*\d+\s/;
const removeCountPattern = /^-\s*\d+\s/;
const heredocOpenPattern =
    /(?<operator><<-?)\s*(?:"(?<doubleMarker>[A-Za-z_][A-Za-z0-9_]*)"|'(?<singleMarker>[A-Za-z_][A-Za-z0-9_]*)'|(?<bareMarker>[A-Za-z_][A-Za-z0-9_]*))/u;
const MAX_COMPONENT_CACHE_LINES = 300;
const MAX_COMPONENT_CACHE_BYTES = 128 * 1024;
const MAX_COLLAPSED_OUTPUT_PREVIEW_BYTES = 64 * 1024;
const MAX_COLLAPSED_OUTPUT_LINE_BYTES = 4 * 1024;
const MIN_COLLAPSED_OUTPUT_LINE_BYTES = 256;
const MAX_COLLAPSED_OUTPUT_PREVIEW_LINES = Math.max(
    1,
    Math.floor(MAX_COLLAPSED_OUTPUT_PREVIEW_BYTES / MIN_COLLAPSED_OUTPUT_LINE_BYTES),
);
const MAX_COLLAPSED_SCRIPT_PREVIEW_BYTES = 64 * 1024;
const UTF8_TRUNCATION_SUFFIX = "…";
const RETAINED_OUTPUT_LOG_ENV = "PI_CODEX_LOOK_RETAINED_OUTPUT_LOG";

function fg(theme: CodexRenderTheme, token: ThemeColor, text: string): string {
    return theme.fg(token, text);
}

function bg(theme: CodexRenderTheme, token: CodexRenderBg, text: string): string {
    if (theme.bg === undefined) {
        return text;
    }
    return theme.bg(token, text);
}

function actionText(
    theme: CodexRenderTheme,
    text: string,
    options?: { readonly bold?: boolean },
): string {
    const styled = options?.bold === true ? theme.bold(text) : text;
    return fg(theme, "toolTitle", styled);
}

function shellCommand(theme: CodexRenderTheme, text: string): string {
    return fg(theme, "syntaxFunction", text);
}

function shellText(theme: CodexRenderTheme, text: string): string {
    return fg(theme, "toolOutput", text);
}

function shellOperator(theme: CodexRenderTheme, text: string): string {
    return fg(theme, "syntaxOperator", text);
}

function shellFlag(theme: CodexRenderTheme, text: string): string {
    return fg(theme, "toolDiffRemoved", text);
}

function shellString(theme: CodexRenderTheme, text: string): string {
    return fg(theme, "syntaxString", text);
}

function dim(theme: CodexRenderTheme, text: string): string {
    return fg(theme, "dim", text);
}

function muted(theme: CodexRenderTheme, text: string): string {
    return fg(theme, "muted", text);
}

function pathText(theme: CodexRenderTheme, text: string): string {
    return fg(theme, "accent", text);
}

function instructionPathText(theme: CodexRenderTheme, text: string): string {
    return fg(theme, "customMessageLabel", text);
}

function green(theme: CodexRenderTheme, text: string): string {
    return fg(theme, "toolDiffAdded", text);
}

function red(theme: CodexRenderTheme, text: string): string {
    return fg(theme, "toolDiffRemoved", text);
}

function success(theme: CodexRenderTheme, text: string): string {
    return fg(theme, "success", text);
}

export function collapseHome(path: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (home !== undefined && home.length > 0 && path.startsWith(home)) {
        return `~${path.slice(home.length)}`;
    }
    return path;
}

export function makeComponent(renderLines: (width: number) => string[]): Component {
    let cachedWidth: number | undefined;
    let cachedLines: string[] | undefined;

    return {
        render(width: number): string[] {
            const safeWidth = Math.max(1, Math.floor(width));
            if (cachedWidth === safeWidth && cachedLines !== undefined) {
                return cachedLines;
            }

            const rendered = renderLines(safeWidth).map((line) =>
                truncateToWidth(line, safeWidth, ""),
            );
            if (shouldCacheRenderedLines(rendered)) {
                cachedWidth = safeWidth;
                cachedLines = rendered;
            } else {
                cachedWidth = undefined;
                cachedLines = undefined;
            }
            return rendered;
        },
        invalidate(): void {
            cachedWidth = undefined;
            cachedLines = undefined;
        },
    };
}

function shouldCacheRenderedLines(lines: ReadonlyArray<string>): boolean {
    if (lines.length > MAX_COMPONENT_CACHE_LINES) {
        return false;
    }

    let bytes = 0;
    for (const line of lines) {
        bytes += Buffer.byteLength(line, "utf8");
        if (bytes > MAX_COMPONENT_CACHE_BYTES) {
            return false;
        }
    }
    return true;
}

export function emptyComponent(): Component {
    return makeComponent(() => []);
}

function wrapStyledText(text: string, width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const wrapped = wrapTextWithAnsi(text, safeWidth);
    if (wrapped.length === 0) {
        return [""];
    }
    return wrapped.map((line) => truncateToWidth(line, safeWidth, ""));
}

function fitToWidth(text: string, width: number): string {
    const safeWidth = Math.max(1, Math.floor(width));
    const truncated = truncateToWidth(text, safeWidth, "");
    const remaining = Math.max(0, safeWidth - visibleWidth(truncated));
    if (remaining === 0) {
        return truncated;
    }
    return `${truncated}${" ".repeat(remaining)}`;
}

function wrapSinglePhysicalLine(
    line: string,
    width: number,
    firstPrefix: string,
    restPrefix: string,
): string[] {
    return wrapSinglePhysicalLineWithContinuation(line, width, firstPrefix, restPrefix);
}

function wrapSinglePhysicalLineWithContinuation(
    line: string,
    width: number,
    firstPrefix: string,
    continuationPrefix: string,
): string[] {
    const contentWidth = Math.max(
        1,
        width - Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix)),
    );
    const segments = wrapStyledText(line, contentWidth);
    const rendered: string[] = [];

    for (const [index, segment] of segments.entries()) {
        const prefix = index === 0 ? firstPrefix : continuationPrefix;
        rendered.push(truncateToWidth(`${prefix}${segment}`, width, ""));
    }

    return rendered;
}

function wrapPrefixedLine(
    text: string | undefined,
    width: number,
    firstPrefix: string,
    restPrefix: string,
): string[] {
    const normalized = (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const physicalLines = normalized.split("\n");
    const rendered: string[] = [];

    for (const physicalLine of physicalLines) {
        const prefix = rendered.length === 0 ? firstPrefix : restPrefix;
        rendered.push(...wrapSinglePhysicalLine(physicalLine, width, prefix, restPrefix));
    }

    if (rendered.length === 0) {
        return [truncateToWidth(firstPrefix, width, "")];
    }
    return rendered;
}

function wrapPreviewPhysicalLines(
    text: string | undefined,
    width: number,
    firstPrefix: string,
    restPrefix: string,
    maxPhysicalLines: number | undefined,
    omittedHint: string,
    theme: CodexRenderTheme,
): string[] {
    if (maxPhysicalLines === undefined || text === undefined) {
        return wrapPrefixedLine(text, width, firstPrefix, restPrefix);
    }

    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const physicalLines = normalized.split("\n");
    const lineBudget = Math.max(1, Math.floor(maxPhysicalLines));
    if (physicalLines.length <= lineBudget) {
        return wrapPrefixedLine(text, width, firstPrefix, restPrefix);
    }

    const visibleText = physicalLines.slice(0, lineBudget).join("\n");
    const omitted = physicalLines.length - lineBudget;
    return [
        ...wrapPrefixedLine(visibleText, width, firstPrefix, restPrefix),
        ...wrapPrefixedLine(
            muted(theme, `… +${omitted} lines (${omittedHint})`),
            width,
            restPrefix,
            restPrefix,
        ),
    ];
}

function toolExpandHint(): string {
    try {
        return keyHint("app.tools.expand", "to expand");
    } catch {
        return "to expand";
    }
}

function trimEdgeBlankLines(lines: ReadonlyArray<string>): string[] {
    let start = 0;
    let end = lines.length;
    while (start < end && (lines[start] ?? "").trim() === "") {
        start += 1;
    }
    while (end > start && (lines[end - 1] ?? "").trim() === "") {
        end -= 1;
    }
    return start < end ? lines.slice(start, end) : [""];
}

function previewLines(
    lines: ReadonlyArray<string>,
    expanded: boolean,
    maxPreviewLines: number,
    mode: "headTail" | "head" | "hidden",
    omittedHint: string,
): string[] {
    if (expanded) {
        return [...lines];
    }
    return collapsedPreviewLines(lines, maxPreviewLines, mode, omittedHint);
}

function collapsedPreviewLines(
    lines: ReadonlyArray<string>,
    maxPreviewLines: number,
    mode: "headTail" | "head" | "hidden",
    omittedHint: string,
): string[] {
    if (mode === "hidden") {
        return [];
    }

    const lineBudget = Math.max(1, Math.floor(maxPreviewLines));
    if (lines.length <= lineBudget) {
        return [...lines];
    }
    if (lineBudget === 1) {
        return [`… +${lines.length} lines (${omittedHint})`];
    }
    if (mode === "head") {
        const visibleCount = lineBudget - 1;
        return [
            ...lines.slice(0, visibleCount),
            `… +${lines.length - visibleCount} lines (${omittedHint})`,
        ];
    }

    const visibleCount = lineBudget - 1;
    const headCount = Math.ceil(visibleCount / 2);
    const tailCount = Math.floor(visibleCount / 2);
    const tailLines = tailCount === 0 ? [] : lines.slice(lines.length - tailCount);
    const omitted = lines.length - headCount - tailLines.length;
    return [...lines.slice(0, headCount), `… +${omitted} lines (${omittedHint})`, ...tailLines];
}

type CollapsedTextPreview =
    | {
          readonly isEmpty: true;
      }
    | {
          readonly isEmpty: false;
          readonly lines: ReadonlyArray<string>;
      };

type RetainedOutput =
    | {
          readonly kind: "expanded";
          readonly text: string;
      }
    | {
          readonly kind: "collapsed";
          readonly preview: CollapsedTextPreview;
      };

function collapsedPreviewLinesFromText(
    text: string,
    maxPreviewLines: number,
    mode: "headTail" | "head" | "hidden",
    omittedHint: string,
): CollapsedTextPreview {
    if (mode === "hidden") {
        return { isEmpty: false, lines: [] };
    }

    const lineBudget = Math.max(
        1,
        Math.min(Math.floor(maxPreviewLines), MAX_COLLAPSED_OUTPUT_PREVIEW_LINES),
    );
    const lineByteBudget = Math.max(
        MIN_COLLAPSED_OUTPUT_LINE_BYTES,
        Math.min(
            MAX_COLLAPSED_OUTPUT_LINE_BYTES,
            Math.floor(MAX_COLLAPSED_OUTPUT_PREVIEW_BYTES / lineBudget),
        ),
    );
    const visibleCount = Math.max(0, lineBudget - 1);
    const headCount = mode === "headTail" ? Math.ceil(visibleCount / 2) : visibleCount;
    const tailCount = mode === "headTail" ? Math.floor(visibleCount / 2) : 0;
    const headLines: string[] = [];
    const tailLines: string[] = [];
    let allLines: string[] | undefined = [];
    let pendingBlankLineCount = 0;
    let pendingBlankLineSamples: string[] = [];
    let lineCount = 0;
    let sawContent = false;

    const consumeLine = (line: string): void => {
        const previewLine = detachedPreviewLine(line, lineByteBudget);
        lineCount += 1;
        if (headLines.length < headCount) {
            headLines.push(previewLine);
        }
        if (tailCount > 0) {
            tailLines.push(previewLine);
            if (tailLines.length > tailCount) {
                tailLines.shift();
            }
        }
        if (allLines !== undefined) {
            allLines.push(previewLine);
            if (allLines.length > lineBudget) {
                allLines = undefined;
            }
        }
    };

    const flushPendingBlankLines = (): void => {
        for (let index = 0; index < pendingBlankLineCount; index += 1) {
            consumeLine(pendingBlankLineSamples[index] ?? "");
        }
        pendingBlankLineCount = 0;
        pendingBlankLineSamples = [];
    };

    visitPhysicalLines(text, (line) => {
        if (!hasNonWhitespaceText(line)) {
            if (sawContent) {
                pendingBlankLineCount += 1;
                if (pendingBlankLineSamples.length < lineBudget) {
                    pendingBlankLineSamples.push(line);
                }
            }
            return;
        }

        sawContent = true;
        flushPendingBlankLines();
        consumeLine(line);
    });

    if (!sawContent) {
        return { isEmpty: true };
    }
    if (allLines !== undefined) {
        return { isEmpty: false, lines: allLines };
    }
    if (lineBudget === 1) {
        return { isEmpty: false, lines: [`… +${lineCount} lines (${omittedHint})`] };
    }
    if (mode === "head") {
        return {
            isEmpty: false,
            lines: [...headLines, `… +${lineCount - headLines.length} lines (${omittedHint})`],
        };
    }

    return {
        isEmpty: false,
        lines: [
            ...headLines,
            `… +${lineCount - headLines.length - tailLines.length} lines (${omittedHint})`,
            ...tailLines,
        ],
    };
}

function normalizeOutputText(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detachedPreviewLine(line: string, maxBytes: number): string {
    const suffixBytes = Buffer.byteLength(UTF8_TRUNCATION_SUFFIX, "utf8");
    if (Buffer.byteLength(line, "utf8") <= maxBytes) {
        return detachString(line);
    }

    const budget = Math.max(0, maxBytes - suffixBytes);
    return detachString(`${truncateUtf8(line, budget)}${UTF8_TRUNCATION_SUFFIX}`);
}

function truncateUtf8(text: string, maxBytes: number): string {
    let bytes = 0;
    let endIndex = 0;
    for (const char of text) {
        const charBytes = Buffer.byteLength(char, "utf8");
        if (bytes + charBytes > maxBytes) {
            break;
        }
        bytes += charBytes;
        endIndex += char.length;
    }
    return text.slice(0, endIndex);
}

function detachString(text: string): string {
    return Buffer.from(text, "utf8").toString("utf8");
}

function shouldReportRetainedOutput(): boolean {
    const value = process.env[RETAINED_OUTPUT_LOG_ENV]?.trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes";
}

function retainedOutputBytes(retained: RetainedOutput): number {
    if (retained.kind === "expanded") {
        return Buffer.byteLength(retained.text, "utf8");
    }
    if (retained.preview.isEmpty) {
        return 0;
    }
    return retained.preview.lines.reduce(
        (total, line) => total + Buffer.byteLength(line, "utf8"),
        0,
    );
}

function reportRetainedOutput(
    retained: RetainedOutput,
    input: string | undefined,
    mode: "headTail" | "head" | "hidden",
): void {
    if (!shouldReportRetainedOutput()) {
        return;
    }
    console.warn(
        `[pi-codex-look] renderCodexOutput retained ${JSON.stringify({
            expanded: retained.kind === "expanded",
            mode,
            inputBytes: Buffer.byteLength(input ?? "", "utf8"),
            retainedBytes: retainedOutputBytes(retained),
        })}`,
    );
}

function visitPhysicalLines(text: string, visit: (line: string) => void): void {
    let lineStart = 0;
    for (let index = 0; index <= text.length; index += 1) {
        if (index < text.length) {
            const charCode = text.charCodeAt(index);
            if (charCode !== 10 && charCode !== 13) {
                continue;
            }
        }

        visit(text.slice(lineStart, index));
        if (
            index < text.length &&
            text.charCodeAt(index) === 13 &&
            text.charCodeAt(index + 1) === 10
        ) {
            index += 1;
        }
        lineStart = index + 1;
    }
}

function renderBullet(theme: CodexRenderTheme, state: CodexCallState): string {
    if (state === "success") {
        return success(theme, "•");
    }
    if (state === "error") {
        return red(theme, "•");
    }
    if (state === "muted") {
        return dim(theme, "•");
    }
    return muted(theme, "•");
}

export function renderCodexCall(
    theme: CodexRenderTheme,
    options: {
        readonly state: CodexCallState;
        readonly statusText: string;
        readonly body?: string;
        readonly maxRenderedLines?: number;
        readonly omittedHint?: string;
    },
): Component {
    return makeComponent((width) => {
        const bullet = renderBullet(theme, options.state);
        const prefix = `${bullet} ${actionText(theme, options.statusText, { bold: true })} `;
        const restPrefix = dim(theme, "  │ ");
        return wrapPreviewPhysicalLines(
            options.body,
            width,
            prefix,
            restPrefix,
            options.maxRenderedLines,
            options.omittedHint ?? "truncated",
            theme,
        );
    });
}

export function renderCodexBody(theme: CodexRenderTheme, text: string | undefined): Component {
    return makeComponent((width) => wrapPrefixedLine(text, width, "", ""));
}

export function renderCodexExplore(
    theme: CodexRenderTheme,
    actions: ReadonlyArray<string | undefined>,
): Component {
    return makeComponent((width) => {
        const rendered = wrapPrefixedLine(
            actionText(theme, "Explored", { bold: true }),
            width,
            `${dim(theme, "•")} `,
            "  ",
        );
        const visibleActions = actions.filter((action): action is string => Boolean(action));

        for (const [index, action] of visibleActions.entries()) {
            const prefix = index === 0 ? dim(theme, "  └ ") : "    ";
            rendered.push(...wrapPrefixedLine(action, width, prefix, "    "));
        }

        return rendered;
    });
}

export function renderMutationCall(
    theme: CodexRenderTheme,
    summary: MutationSummary,
    options: { readonly body?: Component; readonly labelColumnWidth?: number } = {},
): Component {
    return makeComponent((width) => {
        const stats = `(${green(theme, `+${summary.added}`)} ${red(theme, `-${summary.removed}`)})`;
        const body = `${formatPathTarget(theme, summary.path)} ${stats}`;
        const label =
            options.labelColumnWidth === undefined
                ? summary.label
                : summary.label.padEnd(options.labelColumnWidth, " ");
        const prefix = `${dim(theme, "• ")}${actionText(theme, label, { bold: true })} `;
        return [
            ...wrapPrefixedLine(body, width, prefix, "  "),
            ...(options.body?.render(width) ?? []),
        ];
    });
}

function appendBudgetedPreviewRows(
    rendered: string[],
    wrapped: ReadonlyArray<string>,
    options: {
        readonly rowBudget: number | undefined;
        readonly remainingDisplayLines: number;
        readonly overflowPrefix: string;
        readonly width: number;
        readonly omittedHint: string;
        readonly theme: CodexRenderTheme;
    },
): boolean {
    if (options.rowBudget === undefined || rendered.length + wrapped.length <= options.rowBudget) {
        rendered.push(...wrapped);
        return false;
    }

    const rowsLeft = Math.max(0, options.rowBudget - rendered.length);
    const keptWrappedRows = Math.max(0, rowsLeft - 1);
    const omittedRows = Math.max(
        1,
        wrapped.length - keptWrappedRows + options.remainingDisplayLines,
    );
    const overflowLine = muted(options.theme, `… +${omittedRows} rows (${options.omittedHint})`);
    const overflowRows = wrapPrefixedLine(
        overflowLine,
        options.width,
        options.overflowPrefix,
        options.overflowPrefix,
    );

    if (rowsLeft <= 0) {
        const replacement = overflowRows[0];
        if (replacement !== undefined && rendered.length > 0) {
            rendered[rendered.length - 1] = replacement;
        }
        return true;
    }

    rendered.push(...wrapped.slice(0, keptWrappedRows));
    const overflowRow = overflowRows[0];
    if (overflowRow !== undefined) {
        rendered.push(overflowRow);
    }
    return true;
}

export function renderCodexOutput(
    theme: CodexRenderTheme,
    text: string | undefined,
    options: {
        readonly expanded: boolean;
        readonly mode?: "headTail" | "head" | "hidden";
        readonly maxPreviewLines?: number;
        readonly prefixFirst?: string;
        readonly prefixRest?: string;
        readonly dimContent?: boolean;
        readonly noOutputLabel?: string | null;
        readonly omittedHint?: string;
        readonly syntax?: CodeOutputSyntax;
    },
): Component {
    const mode = options.mode ?? "headTail";
    const maxPreviewLines = options.maxPreviewLines ?? 5;
    const prefixFirst = options.prefixFirst ?? dim(theme, "  └ ");
    const prefixRest = options.prefixRest ?? "    ";
    const dimContent = options.dimContent ?? true;
    const omittedHint = options.omittedHint ?? toolExpandHint();
    const noOutputLabel = options.noOutputLabel;
    const syntax = options.syntax;

    if (!options.expanded && mode === "hidden") {
        return emptyComponent();
    }

    const retained: RetainedOutput = options.expanded
        ? { kind: "expanded", text: normalizeOutputText(text ?? "") }
        : {
              kind: "collapsed",
              preview: collapsedPreviewLinesFromText(
                  text ?? "",
                  maxPreviewLines,
                  mode,
                  omittedHint,
              ),
          };
    reportRetainedOutput(retained, text, mode);

    return makeComponent((width) => {
        const rawLines =
            retained.kind === "expanded"
                ? trimEdgeBlankLines(retained.text.split("\n"))
                : retained.preview.isEmpty
                  ? [""]
                  : retained.preview.lines;

        if (rawLines.length === 1 && rawLines[0] === "") {
            if (noOutputLabel === null) {
                return [];
            }
            const label = noOutputLabel ?? "(no output)";
            return [truncateToWidth(`${prefixFirst}${muted(theme, label)}`, width, "")];
        }

        const visible =
            retained.kind === "expanded"
                ? previewLines(rawLines, true, maxPreviewLines, mode, omittedHint)
                : [...rawLines];
        const displayLines =
            syntax === undefined
                ? visible
                : retained.kind === "expanded"
                  ? previewLines(
                        trimEdgeBlankLines(highlightCodeOutput(retained.text, syntax)),
                        true,
                        maxPreviewLines,
                        mode,
                        omittedHint,
                    )
                  : highlightPreviewLines(visible, syntax);
        const rendered: string[] = [];
        const rowBudget =
            retained.kind === "expanded" ? undefined : Math.max(1, Math.floor(maxPreviewLines));

        for (const [index, line] of displayLines.entries()) {
            const prefix = index === 0 ? prefixFirst : prefixRest;
            let styled = line;
            if (line.startsWith("… +")) {
                styled = muted(theme, line);
            } else if (dimContent) {
                styled = muted(theme, line);
            }

            const wrapped = wrapPrefixedLine(styled, width, prefix, prefixRest);
            const overflowed = appendBudgetedPreviewRows(rendered, wrapped, {
                rowBudget,
                remainingDisplayLines: displayLines.length - index - 1,
                overflowPrefix: rendered.length === 0 ? prefix : prefixRest,
                width,
                omittedHint,
                theme,
            });
            if (overflowed) {
                break;
            }
        }

        return rendered;
    });
}

function highlightPreviewLines(
    lines: ReadonlyArray<string>,
    syntax: CodeOutputSyntax,
): ReadonlyArray<string> {
    return lines.map((line) => {
        if (line.startsWith("… +") || line.length === 0) {
            return line;
        }
        return highlightCodeOutput(line, syntax)[0] ?? line;
    });
}

export function isInstructionFilePath(path: string | undefined): boolean {
    const normalized = (path ?? "").replace(/\\/g, "/");
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    if (segments[segments.length - 1] === "AGENTS.md") {
        return true;
    }

    return /(?:^|\/|~\/)\.pi\/agent\/(?:skills\/[^/]+\/|(?:git|npm\/node_modules)\/.+\/skills\/[^/]+\/)/u.test(
        normalized,
    );
}

export function formatPathTarget(theme: CodexRenderTheme, path: string | undefined): string {
    const displayPath = collapseHome(path ?? "");
    if (isInstructionFilePath(path)) {
        return instructionPathText(theme, displayPath);
    }
    return pathText(theme, displayPath);
}

type ScriptInterpreter = {
    readonly displayName: string;
    readonly language: string;
};

function stripShellQuotedValue(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2) {
        return trimmed;
    }

    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first !== "'" && first !== '"') || first !== last) {
        return trimmed;
    }

    const inner = trimmed.slice(1, -1);
    if (first === "'") {
        return inner.replace(/'\\''/g, "'");
    }
    return inner.replace(/\\(["\\$`])/g, "$1");
}

export function stripShellWrapper(command: string | undefined): string {
    const normalized = (command ?? "").trim();
    const wrapperMatch = /^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh|fish)\s+-lc\s+([\s\S]+)$/u.exec(
        normalized,
    );
    if (!wrapperMatch) {
        return normalized;
    }
    return stripShellQuotedValue(wrapperMatch[1] ?? "");
}

function decodeShellWord(word: string): string {
    let decoded = "";
    let quote: "'" | '"' | undefined;
    let escaped = false;

    for (const char of word) {
        if (quote === "'") {
            if (char === "'") {
                quote = undefined;
            } else {
                decoded += char;
            }
            continue;
        }

        if (quote === '"') {
            if (escaped) {
                decoded += ['"', "\\", "$", "`"].includes(char) ? char : `\\${char}`;
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char === '"') {
                quote = undefined;
            } else {
                decoded += char;
            }
            continue;
        }

        if (escaped) {
            decoded += char;
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
        } else {
            decoded += char;
        }
    }

    if (escaped) {
        decoded += "\\";
    }

    return decoded;
}

function unquoteCommandWord(word: string): string {
    return decodeShellWord(word).replace(/,$/, "");
}

function scriptInterpreterForWord(word: string): ScriptInterpreter | undefined {
    const cleanWord = unquoteCommandWord(word);
    const parts = cleanWord.split(/[\\/]/);
    const basename = (parts[parts.length - 1] ?? cleanWord).toLowerCase().replace(/\.exe$/, "");

    if (basename === "py" || /^python(?:\d+(?:\.\d+)?)?$/.test(basename)) {
        return { displayName: "Python", language: "python" };
    }
    if (basename === "node" || basename === "nodejs") {
        return { displayName: "Node", language: "javascript" };
    }
    if (basename === "deno") {
        return { displayName: "Deno", language: "typescript" };
    }
    if (basename === "bun") {
        return { displayName: "Bun", language: "typescript" };
    }
    if (basename === "tsx" || basename === "ts-node") {
        return { displayName: "TypeScript", language: "typescript" };
    }
    if (basename === "ruby") {
        return { displayName: "Ruby", language: "ruby" };
    }
    if (basename === "perl") {
        return { displayName: "Perl", language: "perl" };
    }
    if (basename === "php") {
        return { displayName: "PHP", language: "php" };
    }
    if (basename === "bash" || basename === "sh" || basename === "zsh") {
        return { displayName: "Shell", language: "bash" };
    }

    return undefined;
}

function detectScriptInterpreter(prefix: string): ScriptInterpreter | undefined {
    for (const word of prefix.split(/\s+/).filter((item) => item.length > 0)) {
        const interpreter = scriptInterpreterForWord(word);
        if (interpreter) {
            return interpreter;
        }
    }
    return undefined;
}

function normalizeCodeForDisplay(code: string): string {
    return code.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "  ");
}

type HeredocOpening = {
    readonly prefix: string;
    readonly marker: string;
    readonly bodyStart: number;
    readonly stripLeadingTabs: boolean;
};

type HeredocClosing =
    | {
          readonly code: string;
          readonly hasTrailingShell: false;
      }
    | {
          readonly hasTrailingShell: true;
      };

function parseHeredocScriptInvocation(displayCommand: string): ScriptInvocation | undefined {
    const opening = parseHeredocOpening(displayCommand);
    if (opening === undefined) {
        return undefined;
    }

    const body = displayCommand.slice(opening.bodyStart);
    const closing = findHeredocClosing(body, opening.marker, opening.stripLeadingTabs);
    if (closing?.hasTrailingShell === true) {
        return undefined;
    }

    return buildScriptInvocation(opening.prefix, closing?.code ?? body);
}

function parseHeredocOpening(displayCommand: string): HeredocOpening | undefined {
    const firstLineEnd = firstLineEndIndex(displayCommand);
    const firstLine = displayCommand.slice(0, firstLineEnd);
    const match = heredocOpenPattern.exec(firstLine);
    const groups = match?.groups;
    if (match === null || groups === undefined) {
        return undefined;
    }

    const suffix = firstLine.slice(match.index + match[0].length);
    if (hasShellControlOperator(suffix)) {
        return undefined;
    }

    return {
        prefix: firstLine.slice(0, match.index),
        marker: groups.doubleMarker ?? groups.singleMarker ?? groups.bareMarker ?? "",
        bodyStart: nextLineStartIndex(displayCommand, firstLineEnd),
        stripLeadingTabs: groups.operator === "<<-",
    };
}

function firstLineEndIndex(text: string): number {
    for (let index = 0; index < text.length; index += 1) {
        const charCode = text.charCodeAt(index);
        if (charCode === 10 || charCode === 13) {
            return index;
        }
    }
    return text.length;
}

function nextLineStartIndex(text: string, lineEnd: number): number {
    if (lineEnd >= text.length) {
        return text.length;
    }
    if (text.charCodeAt(lineEnd) === 13 && text.charCodeAt(lineEnd + 1) === 10) {
        return lineEnd + 2;
    }
    return lineEnd + 1;
}

function hasShellControlOperator(text: string): boolean {
    let quote: "'" | '"' | undefined;
    let escaped = false;

    for (const char of text) {
        if (quote !== undefined) {
            if (quote === '"' && escaped) {
                escaped = false;
                continue;
            }
            if (quote === '"' && char === "\\") {
                escaped = true;
                continue;
            }
            if (char === quote) {
                quote = undefined;
            }
            continue;
        }

        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if (["|", ";", "&", "<", ">"].includes(char)) {
            return true;
        }
    }

    return false;
}

function findHeredocClosing(
    body: string,
    marker: string,
    stripLeadingTabs: boolean,
): HeredocClosing | undefined {
    if (marker.length === 0) {
        return undefined;
    }

    let lineStart = 0;
    for (let index = 0; index <= body.length; index += 1) {
        if (index < body.length) {
            const charCode = body.charCodeAt(index);
            if (charCode !== 10 && charCode !== 13) {
                continue;
            }
        }

        if (heredocDelimiterMatches(body, lineStart, index, marker, stripLeadingTabs)) {
            const trailingStart = nextLineStartIndex(body, index);
            if (hasNonWhitespaceText(body.slice(trailingStart))) {
                return { hasTrailingShell: true };
            }
            return {
                code: body.slice(0, heredocCodeEndIndex(body, lineStart)),
                hasTrailingShell: false,
            };
        }
        if (
            index < body.length &&
            body.charCodeAt(index) === 13 &&
            body.charCodeAt(index + 1) === 10
        ) {
            index += 1;
        }
        lineStart = index + 1;
    }

    return undefined;
}

function heredocCodeEndIndex(body: string, closingLineStart: number): number {
    if (closingLineStart === 0) {
        return 0;
    }
    if (body.charCodeAt(closingLineStart - 2) === 13) {
        return closingLineStart - 2;
    }
    return closingLineStart - 1;
}

function heredocDelimiterMatches(
    text: string,
    start: number,
    end: number,
    expected: string,
    stripLeadingTabs: boolean,
): boolean {
    let markerStart = start;
    if (stripLeadingTabs) {
        while (markerStart < end && text.charCodeAt(markerStart) === 9) {
            markerStart += 1;
        }
    }

    if (end - markerStart !== expected.length) {
        return false;
    }
    for (let index = 0; index < expected.length; index += 1) {
        if (text.charCodeAt(markerStart + index) !== expected.charCodeAt(index)) {
            return false;
        }
    }
    return true;
}

function buildScriptInvocationForInterpreter(
    interpreter: ScriptInterpreter,
    code: string,
): ScriptInvocation {
    return {
        label: interpreter.displayName,
        language: interpreter.language,
        code: normalizeCodeForDisplay(code),
    };
}

function buildScriptInvocation(prefix: string, code: string): ScriptInvocation | undefined {
    const interpreter = detectScriptInterpreter(prefix);
    if (!interpreter) {
        return undefined;
    }

    return buildScriptInvocationForInterpreter(interpreter, code);
}

function tokenizeShellWords(command: string): string[] {
    const words: string[] = [];
    let current = "";
    let quote: "'" | '"' | undefined;
    let escaped = false;

    const pushCurrent = (): void => {
        if (current.length > 0) {
            words.push(current);
            current = "";
        }
    };

    for (const char of command) {
        if (quote !== undefined) {
            current += char;
            if (quote === '"' && escaped) {
                escaped = false;
                continue;
            }
            if (quote === '"' && char === "\\") {
                escaped = true;
                continue;
            }
            if (char === quote) {
                quote = undefined;
            }
            continue;
        }

        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === "\\") {
            current += char;
            escaped = true;
            continue;
        }
        if (char === "'" || char === '"') {
            current += char;
            quote = char;
            continue;
        }
        if (/\s/u.test(char)) {
            pushCurrent();
            continue;
        }
        if (["|", ";", "&", "<", ">"].includes(char)) {
            pushCurrent();
            continue;
        }
        current += char;
    }

    pushCurrent();
    return words;
}

type InlineScriptFlag = "-c" | "-e" | "--eval";

function inlineScriptFlagsForInterpreter(
    interpreter: ScriptInterpreter,
): ReadonlySet<InlineScriptFlag> {
    if (interpreter.language === "python") {
        return new Set(["-c"]);
    }
    if (interpreter.displayName === "Node") {
        return new Set(["-e", "--eval"]);
    }
    return new Set();
}

function isQuotedShellWord(word: string): boolean {
    const trimmed = word.trim();
    if (trimmed.length < 2) {
        return false;
    }

    const first = trimmed[0];
    return (first === "'" || first === '"') && trimmed.endsWith(first);
}

function isUnquotedFlagLikeScriptCode(word: string, code: string): boolean {
    return !isQuotedShellWord(word) && /^-[A-Za-z-]/u.test(code);
}

function inlineScriptCodeForInterpreter(
    interpreter: ScriptInterpreter,
    words: ReadonlyArray<string>,
    startIndex: number,
): string | undefined {
    const flags = inlineScriptFlagsForInterpreter(interpreter);
    if (flags.size === 0) {
        return undefined;
    }

    for (let index = startIndex; index < words.length; index += 1) {
        const value = decodeShellWord(words[index] ?? "");
        for (const flag of flags) {
            if (value === flag) {
                const codeWord = words[index + 1];
                if (codeWord === undefined) {
                    return undefined;
                }
                const code = decodeShellWord(codeWord);
                if (words[index + 2] !== undefined) {
                    return undefined;
                }
                return isUnquotedFlagLikeScriptCode(codeWord, code) ? undefined : code;
            }
            const assignmentPrefix = `${flag}=`;
            if (value.startsWith(assignmentPrefix)) {
                const code = value.slice(assignmentPrefix.length);
                if (words[index + 1] !== undefined) {
                    return undefined;
                }
                return /^-[A-Za-z-]/u.test(code) ? undefined : code;
            }
        }
    }

    return undefined;
}

function parseInlineScriptInvocation(displayCommand: string): ScriptInvocation | undefined {
    const words = tokenizeShellWords(displayCommand);
    for (const [index, word] of words.entries()) {
        const interpreter = scriptInterpreterForWord(word);
        if (!interpreter) {
            continue;
        }

        const code = inlineScriptCodeForInterpreter(interpreter, words, index + 1);
        if (code !== undefined) {
            return buildScriptInvocationForInterpreter(interpreter, code);
        }
    }

    return undefined;
}

type BashHeredocHighlight = {
    readonly marker: string;
    readonly language: string;
};

function detectHeredocInterpreter(prefix: string): ScriptInterpreter | undefined {
    const words = tokenizeShellWords(prefix);
    for (let index = words.length - 1; index >= 0; index -= 1) {
        const word = words[index];
        if (word === undefined) {
            continue;
        }

        const interpreter = scriptInterpreterForWord(word);
        if (interpreter && interpreter.language !== "bash") {
            return interpreter;
        }
    }

    return undefined;
}

function bashHeredocHighlightFromLine(line: string): BashHeredocHighlight | undefined {
    const match = /<<-?\s*["']?(?<marker>[A-Za-z_][A-Za-z0-9_]*)["']?/u.exec(line);
    const marker = match?.groups?.marker;
    if (match === null || marker === undefined) {
        return undefined;
    }

    const interpreter = detectHeredocInterpreter(line.slice(0, match.index));
    if (!interpreter) {
        return undefined;
    }

    return { marker, language: interpreter.language };
}

function highlightBashScriptPreviewLines(lines: ReadonlyArray<string>): string[] {
    const highlighted: string[] = [];
    let heredoc: BashHeredocHighlight | undefined;

    for (const line of lines) {
        if (line.startsWith("… +")) {
            highlighted.push(line);
            continue;
        }

        if (heredoc !== undefined) {
            if (line.trim() === heredoc.marker) {
                highlighted.push(highlightSyntaxCode(line, "bash")[0] ?? line);
                heredoc = undefined;
                continue;
            }

            highlighted.push(highlightSyntaxCode(line, heredoc.language)[0] ?? line);
            continue;
        }

        highlighted.push(highlightSyntaxCode(line, "bash")[0] ?? line);
        heredoc = bashHeredocHighlightFromLine(line);
    }

    return highlighted;
}

function highlightScriptPreviewLines(lines: ReadonlyArray<string>, language: string): string[] {
    if (language === "bash") {
        return highlightBashScriptPreviewLines(lines);
    }

    return lines.map((line) =>
        line.startsWith("… +") ? line : (highlightSyntaxCode(line, language)[0] ?? line),
    );
}

export function parseScriptInvocation(command: string | undefined): ScriptInvocation | undefined {
    const displayCommand = stripShellWrapper(command);
    return (
        parseHeredocScriptInvocation(displayCommand) ?? parseInlineScriptInvocation(displayCommand)
    );
}

function isLeadingImportLine(language: string, line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
        return false;
    }

    if (language === "python") {
        return /^(?:from\s+\S+\s+import\s+|import\s+\S+)/u.test(trimmed);
    }
    if (language === "javascript" || language === "typescript") {
        return /^(?:import\s+|export\s+\{[^}]*\}\s+from\s+|(?:const|let|var)\s+\w+\s*=\s*require\()/u.test(
            trimmed,
        );
    }

    return false;
}

function collapsedScriptPreview(invocation: ScriptInvocation): ScriptPreview {
    let lineStart = 0;
    let previewStart = 0;
    let sawImport = false;

    while (lineStart <= invocation.code.length) {
        const nextLineBreak = invocation.code.indexOf("\n", lineStart);
        const lineEnd = nextLineBreak === -1 ? invocation.code.length : nextLineBreak;
        const line = invocation.code.slice(lineStart, lineEnd);
        const nextLineStart = nextLineBreak === -1 ? invocation.code.length + 1 : lineEnd + 1;

        if (!hasNonWhitespaceText(line) && (!sawImport || nextLineBreak !== -1)) {
            lineStart = nextLineStart;
            continue;
        }
        if (isLeadingImportLine(invocation.language, line)) {
            sawImport = true;
            lineStart = nextLineStart;
            continue;
        }

        previewStart = lineStart;
        break;
    }

    if (!sawImport) {
        return { code: invocation.code };
    }

    const previewCode = invocation.code.slice(previewStart);
    return hasNonWhitespaceText(previewCode) ? { code: previewCode } : { code: invocation.code };
}

function hasNonWhitespaceText(text: string): boolean {
    for (let index = 0; index < text.length; index += 1) {
        if (text.charAt(index).trim().length > 0) {
            return true;
        }
    }
    return false;
}

function scriptPreviewForRender(invocation: ScriptInvocation, expanded: boolean): ScriptPreview {
    if (expanded) {
        return { code: invocation.code };
    }
    return collapsedScriptPreview(invocation);
}

function retainedScriptInvocation(
    invocation: ScriptInvocation,
    expanded: boolean,
): ScriptInvocation {
    if (expanded) {
        return invocation;
    }

    return {
        label: invocation.label,
        language: invocation.language,
        code: detachedScriptPreviewCode(collapsedScriptPreview(invocation).code),
    };
}

function detachedScriptPreviewCode(code: string): string {
    if (Buffer.byteLength(code, "utf8") <= MAX_COLLAPSED_SCRIPT_PREVIEW_BYTES) {
        return detachString(code);
    }

    const suffix = "\n… script preview truncated";
    const budget = Math.max(
        0,
        MAX_COLLAPSED_SCRIPT_PREVIEW_BYTES - Buffer.byteLength(suffix, "utf8"),
    );
    return detachString(`${truncateUtf8(code, budget)}${suffix}`);
}

function wrapScriptLine(
    theme: CodexRenderTheme,
    line: string,
    width: number,
    firstPrefix: string,
): string[] {
    return wrapSinglePhysicalLineWithContinuation(line, width, firstPrefix, dim(theme, "  │   "));
}

function renderScriptHeader(theme: CodexRenderTheme, state: CodexCallState, label: string): string {
    return `${renderBullet(theme, state)} ${actionText(theme, label, { bold: true })}`;
}

function scriptHasMultiplePhysicalLines(code: string): boolean {
    const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return trimEdgeBlankLines(normalized.split("\n")).length > 1;
}

function resolveScriptHeaderLayout(
    layout: ScriptPreviewHeaderLayout,
    invocation: ScriptInvocation,
    codeLines: ReadonlyArray<string>,
): Exclude<ScriptPreviewHeaderLayout, "auto"> {
    if (layout !== "auto") {
        return layout;
    }
    if (scriptHasMultiplePhysicalLines(invocation.code)) {
        return "block";
    }

    const firstCodeLine = codeLines[0];
    if (firstCodeLine === undefined) {
        return "block";
    }
    return "inline";
}

export function renderScriptCall(
    theme: CodexRenderTheme,
    invocation: ScriptInvocation,
    options: {
        readonly state: CodexCallState;
        readonly expanded: boolean;
        readonly maxCodePreviewLines?: number;
        readonly omittedHint?: string;
        readonly headerLayout?: ScriptPreviewHeaderLayout;
    },
): Component {
    const expanded = options.expanded;
    const retained = retainedScriptInvocation(invocation, expanded);
    const state = options.state;
    const maxCodePreviewLines = options.maxCodePreviewLines ?? 8;
    const omittedHint = options.omittedHint ?? "truncated";
    const headerLayoutOption = options.headerLayout ?? "auto";

    return makeComponent((width) => {
        const header = renderScriptHeader(theme, state, retained.label);
        const preview = scriptPreviewForRender(retained, expanded);

        if (preview.code.length === 0) {
            return wrapPrefixedLine("", width, header, "  ");
        }

        const collapsedPreview = expanded
            ? undefined
            : collapsedPreviewLinesFromText(preview.code, maxCodePreviewLines, "head", omittedHint);
        const rawLines =
            collapsedPreview?.isEmpty === true
                ? [""]
                : collapsedPreview === undefined
                  ? trimEdgeBlankLines(preview.code.split("\n"))
                  : collapsedPreview.lines;
        const visible =
            collapsedPreview === undefined
                ? previewLines(rawLines, expanded, maxCodePreviewLines, "head", omittedHint)
                : [...rawLines];
        const highlighted = highlightScriptPreviewLines(visible, retained.language);
        const rendered: string[] = [];
        const headerLayout = resolveScriptHeaderLayout(headerLayoutOption, retained, highlighted);

        if (headerLayout === "block") {
            rendered.push(...wrapPrefixedLine("", width, header, "  "));
        }

        for (const [index, line] of highlighted.entries()) {
            const styled = line.startsWith("… +") ? muted(theme, line) : line;
            const firstPrefix =
                headerLayout === "inline" && index === 0 ? `${header} ` : dim(theme, "  │ ");
            rendered.push(...wrapScriptLine(theme, styled, width, firstPrefix));
        }

        return rendered;
    });
}

function tokenizeShellLine(line: string): string[] {
    return (
        line.match(
            /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|&&|\|\||2>>|2>|>>|[|;&<>]|\s+|[^\s|;&<>]+/g,
        ) ?? [line]
    );
}

function styleShellToken(
    theme: CodexRenderTheme,
    token: string,
    expectsCommand: boolean,
): { readonly styled: string; readonly expectsCommandAfter: boolean } {
    if (/^\s+$/.test(token)) {
        return { styled: token, expectsCommandAfter: expectsCommand };
    }

    if (["|", "||", "&&", "&", ";", ">", ">>", "<", "2>", "2>>"].includes(token)) {
        return { styled: shellOperator(theme, token), expectsCommandAfter: true };
    }

    const longFlag = /^(--)([A-Za-z0-9][\w-]*)/.exec(token);
    if (longFlag) {
        const value = token.slice((longFlag[1] ?? "").length + (longFlag[2] ?? "").length);
        return {
            styled: `${dim(theme, longFlag[1] ?? "")}${shellFlag(theme, longFlag[2] ?? "")}${shellText(theme, value)}`,
            expectsCommandAfter: false,
        };
    }

    const shortFlag = /^(-)([A-Za-z0-9][\w-]*)/.exec(token);
    if (shortFlag) {
        const value = token.slice((shortFlag[1] ?? "").length + (shortFlag[2] ?? "").length);
        return {
            styled: `${dim(theme, shortFlag[1] ?? "")}${shellFlag(theme, shortFlag[2] ?? "")}${shellText(theme, value)}`,
            expectsCommandAfter: false,
        };
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
        return { styled: shellString(theme, token), expectsCommandAfter: expectsCommand };
    }

    if (
        (token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'"))
    ) {
        return { styled: shellString(theme, token), expectsCommandAfter: false };
    }

    if (expectsCommand) {
        return { styled: shellCommand(theme, token), expectsCommandAfter: false };
    }

    return { styled: shellText(theme, token), expectsCommandAfter: false };
}

export function highlightShell(theme: CodexRenderTheme, command: string | undefined): string {
    const stripped = previewShellCommandForHighlight(stripShellWrapper(command));
    const highlighted = highlightSyntaxCode(stripped, "bash");
    if (highlighted.join("\n") !== stripped) {
        return highlighted.join("\n");
    }

    return stripped
        .split("\n")
        .map((line) => {
            let expectsCommand = true;
            return tokenizeShellLine(line)
                .map((token) => {
                    const result = styleShellToken(theme, token, expectsCommand);
                    expectsCommand = result.expectsCommandAfter;
                    return result.styled;
                })
                .join("");
        })
        .join("\n");
}

function previewShellCommandForHighlight(command: string): string {
    const lines = command.split("\n");
    const maxLines = 8;
    if (lines.length <= maxLines) {
        return command;
    }
    return [
        ...lines.slice(0, maxLines - 1),
        `… +${lines.length - maxLines + 1} lines (truncated)`,
    ].join("\n");
}

export function formatReadAction(theme: CodexRenderTheme, args: ReadActionArgs): string {
    const target = formatPathTarget(theme, args.path);
    const range = formatLineRange(args.offset, args.limit);
    if (range !== undefined) {
        return `${actionText(theme, "Read")} ${target}${muted(theme, range)}`;
    }
    return `${actionText(theme, "Read")} ${target}`;
}

export function formatFindAction(theme: CodexRenderTheme, args: FindActionArgs): string {
    const parts = [`${actionText(theme, "Find")} ${args.pattern ?? "*"}`];
    if (args.path !== undefined && args.path.length > 0) {
        parts.push(`in ${pathText(theme, collapseHome(args.path))}`);
    }
    if (typeof args.limit === "number") {
        parts.push(muted(theme, `limit ${args.limit}`));
    }
    return parts.join(" ");
}

export function formatGrepAction(theme: CodexRenderTheme, args: GrepActionArgs): string {
    const parts = [`${actionText(theme, "Search")} ${args.pattern ?? ""}`.trim()];
    if (args.path !== undefined && args.path.length > 0) {
        parts.push(`in ${pathText(theme, collapseHome(args.path))}`);
    }
    if (args.glob !== undefined && args.glob.length > 0) {
        parts.push(muted(theme, `(${args.glob})`));
    }
    if (typeof args.limit === "number") {
        parts.push(muted(theme, `limit ${args.limit}`));
    }
    return parts.join(" ");
}

export function formatLsAction(theme: CodexRenderTheme, args: LsActionArgs): string {
    const parts = [
        `${actionText(theme, "List")} ${pathText(theme, collapseHome(args.path ?? "."))}`,
    ];
    if (typeof args.limit === "number") {
        parts.push(muted(theme, `limit ${args.limit}`));
    }
    return parts.join(" ");
}

function formatLineRange(offset?: number, limit?: number): string | undefined {
    if (offset === undefined && limit === undefined) {
        return undefined;
    }
    const start = offset ?? 1;
    if (limit === undefined) {
        return `:${start}`;
    }
    return `:${start}-${start + limit - 1}`;
}

export function parseDiffSections(diffText: string, fallbackPath?: string): DiffSection[] {
    const normalized = diffText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const rawLines = normalized.split("\n");

    if (!rawLines.some((line) => line.startsWith("File: "))) {
        const lines = rawLines.filter((line) => line.length > 0);
        return [makeDiffSection(fallbackPath, lines)];
    }

    const sections: DiffSection[] = [];
    let currentPath: string | undefined;
    let currentLines: string[] = [];

    function flush(): void {
        if (currentPath === undefined && currentLines.length === 0) {
            return;
        }
        const lines = currentLines.filter((line) => line.length > 0);
        sections.push(makeDiffSection(currentPath, lines));
    }

    for (const line of rawLines) {
        if (line.startsWith("File: ")) {
            flush();
            currentPath = line.slice(6).trim();
            currentLines = [];
            continue;
        }
        currentLines.push(line);
    }
    flush();

    return sections;
}

function makeDiffSection(path: string | undefined, lines: ReadonlyArray<string>): DiffSection {
    const visibleLines = trimEdgeEllipsisLines(lines);
    const section = {
        lines: visibleLines,
        added: visibleLines.filter((line) => addCountPattern.test(line)).length,
        removed: visibleLines.filter((line) => removeCountPattern.test(line)).length,
    };

    if (path === undefined) {
        return section;
    }
    return { ...section, path };
}

function trimEdgeEllipsisLines(lines: ReadonlyArray<string>): string[] {
    let start = 0;
    let end = lines.length;
    while (ellipsisLinePattern.test(lines[start] ?? "")) {
        start += 1;
    }
    while (end > start && ellipsisLinePattern.test(lines[end - 1] ?? "")) {
        end -= 1;
    }
    return lines.slice(start, end);
}

function parseDiffLine(line: string):
    | {
          readonly kind: "insert" | "delete" | "context";
          readonly lineNumber: string;
          readonly content: string;
      }
    | { readonly kind: "ellipsis" }
    | null {
    if (ellipsisLinePattern.test(line)) {
        return { kind: "ellipsis" };
    }

    const match = diffLinePattern.exec(line);
    if (!match) {
        return null;
    }

    let kind: "insert" | "delete" | "context" = "context";
    if (match[1] === "+") {
        kind = "insert";
    }
    if (match[1] === "-") {
        kind = "delete";
    }

    return {
        kind,
        lineNumber: match[2] ?? "",
        content: match[3] ?? "",
    };
}

function normalizedDiffLineNumber(lineNumber: string): string {
    return lineNumber.trim();
}

function formatDiffLineNumber(lineNumber: string, width: number): string {
    const normalized = normalizedDiffLineNumber(lineNumber);
    if (normalized.length === 0) {
        return " ".repeat(Math.max(0, width));
    }
    return normalized.padStart(Math.max(normalized.length, width), " ");
}

function diffLineNumberWidth(lines: ReadonlyArray<string>): number {
    let width = 0;
    for (const line of lines) {
        const parsed = parseDiffLine(line);
        if (parsed === null || parsed.kind === "ellipsis") {
            continue;
        }
        width = Math.max(width, normalizedDiffLineNumber(parsed.lineNumber).length);
    }
    return width;
}

function wrapDiffText(text: string, width: number, maxWrappedRows: number | undefined): string[] {
    if (maxWrappedRows === undefined) {
        return wrapStyledText(text, width);
    }

    const boundedText = truncateToWidth(text, Math.max(1, width * maxWrappedRows), "…");
    return wrapStyledText(boundedText, width).slice(0, maxWrappedRows);
}

function renderDiffRow(
    line: string,
    width: number,
    leftPrefix: string,
    theme: CodexRenderTheme,
    options?: {
        readonly path?: string;
        readonly lineNumberWidth?: number;
        readonly maxWrappedRows?: number;
    },
): string[] {
    const parsed = parseDiffLine(line);
    const prefixWidth = visibleWidth(leftPrefix);
    const contentWidth = Math.max(1, width - prefixWidth);

    if (!parsed) {
        return wrapDiffText(muted(theme, line), contentWidth, options?.maxWrappedRows).map((row) =>
            truncateToWidth(`${leftPrefix}${row}`, width, ""),
        );
    }

    if (parsed.kind === "ellipsis") {
        return [truncateToWidth(`${leftPrefix}${muted(theme, "⋮")}`, width, "")];
    }

    let sign = " ";
    if (parsed.kind === "insert") {
        sign = "+";
    }
    if (parsed.kind === "delete") {
        sign = "-";
    }

    const lineNumber = `${formatDiffLineNumber(
        parsed.lineNumber,
        options?.lineNumberWidth ?? normalizedDiffLineNumber(parsed.lineNumber).length,
    )} `;
    const lineNumberWidth = visibleWidth(lineNumber);
    const rowPrefix = `${lineNumber}${sign}`;
    const wrapPrefix = `${" ".repeat(lineNumberWidth)} `;
    const availableWidth = Math.max(1, contentWidth - visibleWidth(rowPrefix));
    const styledContent = styleDiffContent(
        parsed.kind,
        highlightDiffContent(parsed.content, options?.path),
        theme,
    );
    if (parsed.content.length === 0) {
        const styledGutter = styleDiffGutter(parsed.kind, lineNumber, sign, theme);
        const row = truncateToWidth(`${leftPrefix}${styledGutter}`, width, "");
        if (parsed.kind === "insert") {
            return [bg(theme, "toolSuccessBg", fitToWidth(row, Math.max(1, width - 1)))];
        }
        if (parsed.kind === "delete") {
            return [bg(theme, "toolErrorBg", fitToWidth(row, Math.max(1, width - 1)))];
        }
        return [row];
    }

    const wrappedContent = wrapDiffText(styledContent, availableWidth, options?.maxWrappedRows);

    return wrappedContent.map((chunk, index) => {
        const styledGutter =
            index === 0
                ? styleDiffGutter(parsed.kind, lineNumber, sign, theme)
                : dim(theme, wrapPrefix);
        const row = `${leftPrefix}${styledGutter}${chunk}`;
        const fitted = fitToWidth(row, Math.max(1, width - 1));
        if (parsed.kind === "insert") {
            return bg(theme, "toolSuccessBg", fitted);
        }
        if (parsed.kind === "delete") {
            return bg(theme, "toolErrorBg", fitted);
        }
        return fitted;
    });
}

function styleDiffContent(
    kind: "insert" | "delete" | "context",
    content: string,
    theme: CodexRenderTheme,
): string {
    if (hasAnsi(content)) {
        return content;
    }
    if (kind === "insert") {
        return fg(theme, "toolOutput", content);
    }
    if (kind === "delete") {
        return muted(theme, content);
    }
    return dim(theme, content);
}

function highlightDiffContent(content: string, filePath: string | undefined): string {
    if (filePath === undefined) {
        return content;
    }
    const [highlighted] = highlightCodeOutput(content, { path: filePath });
    return highlighted === undefined ? content : preserveRowBackground(highlighted);
}

function preserveRowBackground(text: string): string {
    return text
        .replaceAll(ansiStyles.modifier.reset.open, ROW_BACKGROUND_SAFE_RESET)
        .replaceAll(ansiStyles.bgColor.close, "");
}

function hasAnsi(text: string): boolean {
    return text.includes(ANSI_SEQUENCE_PREFIX);
}

function styleDiffGutter(
    kind: "insert" | "delete" | "context",
    lineNumber: string,
    sign: string,
    theme: CodexRenderTheme,
): string {
    const marker =
        kind === "insert"
            ? green(theme, sign)
            : kind === "delete"
              ? red(theme, sign)
              : dim(theme, sign);
    return `${dim(theme, lineNumber)}${marker}`;
}

export function renderCodexDiff(
    theme: CodexRenderTheme,
    sections: ReadonlyArray<DiffSection>,
    expanded: boolean,
): Component {
    return makeComponent((width) => {
        const allDiffLineCount = sections.reduce(
            (count, section) => count + section.lines.length,
            0,
        );
        const collapsedLineBudget = 18;
        const shouldCollapse = !expanded && allDiffLineCount > collapsedLineBudget;
        let remainingBudget = collapsedLineBudget;
        const rendered: string[] = [];

        for (const [sectionIndex, section] of sections.entries()) {
            if (sections.length > 1) {
                if (sectionIndex > 0) {
                    rendered.push("");
                }
                const stats = `(${green(theme, `+${section.added}`)} ${red(theme, `-${section.removed}`)})`;
                const header = `${dim(theme, "  └ ")}${pathText(theme, collapseHome(section.path ?? "file"))} ${stats}`;
                rendered.push(...wrapPrefixedLine(header, width, "", "    "));
            }

            const visibleLines = shouldCollapse
                ? section.lines.slice(0, Math.min(remainingBudget, section.lines.length))
                : [...section.lines];
            const sectionLineNumberWidth = diffLineNumberWidth(section.lines);

            for (const line of visibleLines) {
                if (shouldCollapse && remainingBudget <= 0) {
                    break;
                }
                rendered.push(
                    ...renderDiffRow(line, width, "    ", theme, {
                        ...(section.path === undefined ? {} : { path: section.path }),
                        lineNumberWidth: sectionLineNumberWidth,
                        ...(expanded ? {} : { maxWrappedRows: 4 }),
                    }),
                );
                remainingBudget -= 1;
            }
        }

        if (shouldCollapse && allDiffLineCount > collapsedLineBudget) {
            rendered.push(
                `${dim(theme, "    ")} ${muted(theme, `… +${allDiffLineCount - collapsedLineBudget} lines`)}`,
            );
        }

        return rendered;
    });
}
