import { keyHint, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
    truncateToWidth,
    type Component,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import ansiStyles from "ansi-styles";
import {
    highlightCodeOutput,
    scheduleCodeOutputSyntaxLoad,
    type CodeOutputSyntax,
} from "../syntax/code-component.ts";
import { highlightSyntaxCode } from "../syntax/highlighter.ts";
import {
    applyBackgroundToTextRanges,
    changedTextRanges,
    type TextRange,
} from "../diffs/intraline.ts";
import { strongerDiffBackgroundAnsi } from "../diffs/ansi-colors.ts";
import type { DiffLineNumberStyle, NarrowDiffLayout, SideBySideLayout } from "../diffs/layout.ts";
import {
    expandTerminalTabs,
    hasNonWhitespaceText,
    neutralizeTerminalControls,
    truncateUtf8ByGrapheme,
} from "../text-boundaries.ts";
import { omitLeadingImportPrologue } from "../script-preview/prologue.ts";

const ANSI_SEQUENCE_PREFIX = ansiStyles.modifier.reset.open.slice(0, 2);
const ROW_BACKGROUND_SAFE_RESET = `${ansiStyles.modifier.bold.close}${ansiStyles.modifier.italic.close}${ansiStyles.modifier.underline.close}${ansiStyles.modifier.strikethrough.close}${ansiStyles.color.close}`;

type GlowupRenderBg = "toolSuccessBg" | "toolErrorBg";

export type GlowupRenderTheme = {
    readonly fg: (token: ThemeColor, text: string) => string;
    readonly bg?: (token: GlowupRenderBg, text: string) => string;
    readonly bold: (text: string) => string;
    readonly getFgAnsi?: (token: ThemeColor) => string;
    readonly getBgAnsi?: (token: GlowupRenderBg) => string;
};

export type DiffBackgroundStyle = "changed-spans" | "two-tone" | "full-row";

export type RenderingAppearance = {
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

export type ToolCallIndicator = {
    readonly symbol: string;
    readonly bold: boolean;
};

let renderingAppearance: RenderingAppearance = {
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
};
let renderingAppearanceVersion = 0;

let toolCallIndicator: ToolCallIndicator = {
    symbol: "•",
    bold: true,
};

/** Applies user-configured semantic colors used by all renderer families. */
export function configureRenderingAppearance(appearance: RenderingAppearance): void {
    renderingAppearance = { ...appearance };
    renderingAppearanceVersion += 1;
}

/** Returns a monotonic version for invalidating components that depend on appearance globals. */
export function configuredRenderingAppearanceVersion(): number {
    return renderingAppearanceVersion;
}

/** Applies user-configured tool-call indicator text used by all renderer families. */
export function configureToolCallIndicator(indicator: ToolCallIndicator): void {
    toolCallIndicator = { ...indicator };
}

function trueColorOpen(hex: string, background: boolean): string {
    const [red, green, blue] = ansiStyles.hexToRgb(hex);
    return background
        ? ansiStyles.bgColor.ansi16m(red, green, blue)
        : ansiStyles.color.ansi16m(red, green, blue);
}

/** Returns a configured semantic diff background ANSI opener when overridden. */
export function configuredDiffBackgroundAnsi(kind: "insert" | "delete"): string | undefined {
    const color =
        kind === "insert"
            ? renderingAppearance.addedRowBackground
            : renderingAppearance.deletedRowBackground;
    return color === null ? undefined : trueColorOpen(color, true);
}

/** Returns a configured semantic intraline background ANSI opener when overridden. */
export function configuredDiffContentBackgroundAnsi(kind: "insert" | "delete"): string | undefined {
    const color =
        kind === "insert"
            ? renderingAppearance.addedContentBackground
            : renderingAppearance.deletedContentBackground;
    return color === null ? undefined : trueColorOpen(color, true);
}

/** Returns the configured placement strategy for semantic diff backgrounds. */
export function configuredDiffBackgroundStyle(): DiffBackgroundStyle {
    return renderingAppearance.diffBackgroundStyle;
}

/** Returns the configured compact unified line-number gutter style. */
export function configuredDiffLineNumberStyle(): DiffLineNumberStyle {
    return renderingAppearance.diffLineNumberStyle;
}

/** Returns how replacement rows are ordered when a diff uses one column. */
export function configuredNarrowDiffLayout(): NarrowDiffLayout {
    return renderingAppearance.narrowDiffLayout;
}

/** Returns how side-by-side eligibility responds to terminal width and content. */
export function configuredSideBySideLayout(): SideBySideLayout {
    return renderingAppearance.sideBySideLayout;
}

/** Returns whether unchanged text in changed diff rows should be dimmed. */
export function configuredDimUnchangedDiffText(): boolean {
    return renderingAppearance.dimUnchangedDiffText;
}

export type DiffSection = {
    readonly path?: string;
    readonly lines: ReadonlyArray<string>;
    readonly lineCoordinates?: ReadonlyArray<DiffLineCoordinates | undefined>;
    readonly added: number;
    readonly removed: number;
};

export type DiffLineCoordinates = {
    readonly oldLine?: number;
    readonly newLine?: number;
};

export const MUTATION_DIFF_PREVIEW_ROWS = 6;

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

export type GlowupCallState = "running" | "success" | "error" | "muted";

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
const omissionLinePattern = /^\s+…(?:\s+.*)?$/u;
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
const RETAINED_OUTPUT_LOG_ENV = "PI_GLOWUP_RETAINED_OUTPUT_LOG";

function fg(theme: GlowupRenderTheme, token: ThemeColor, text: string): string {
    return theme.fg(token, text);
}

function actionText(
    theme: GlowupRenderTheme,
    text: string,
    options?: { readonly bold?: boolean },
): string {
    const styled = options?.bold === true ? theme.bold(text) : text;
    return fg(theme, "toolTitle", styled);
}

function shellCommand(theme: GlowupRenderTheme, text: string): string {
    return fg(theme, "syntaxFunction", text);
}

function shellText(theme: GlowupRenderTheme, text: string): string {
    if (text.length === 0) {
        return "";
    }
    return fg(theme, "toolTitle", text);
}

function shellOperator(theme: GlowupRenderTheme, text: string): string {
    return fg(theme, "syntaxOperator", text);
}

function shellFlag(theme: GlowupRenderTheme, text: string): string {
    return fg(theme, "syntaxKeyword", text);
}

function shellKeyword(theme: GlowupRenderTheme, text: string): string {
    return fg(theme, "syntaxKeyword", text);
}

function shellString(theme: GlowupRenderTheme, text: string): string {
    return fg(theme, "syntaxString", text);
}

type ShellCommandKind = "generic" | "interpreter" | "script" | "subcommands";

type ShellHighlightState = {
    readonly expectsCommand: boolean;
    readonly expectingFlagValue: boolean;
    readonly commandKind: ShellCommandKind;
    readonly sawScriptOperand: boolean;
    readonly subcommandSeen: boolean;
};

type ShellTokenStyleResult = {
    readonly styled: string;
    readonly state: ShellHighlightState;
};

const SUBCOMMAND_SHELL_COMMANDS = new Set([
    "apt",
    "brew",
    "cargo",
    "docker",
    "dnf",
    "gh",
    "git",
    "go",
    "kubectl",
    "npm",
    "pnpm",
    "systemctl",
    "tmux",
    "yarn",
]);

const INTERPRETER_SHELL_COMMANDS = new Set([
    "bun",
    "deno",
    "node",
    "python",
    "python2",
    "python3",
    "ruby",
    "tsx",
]);

const WRAPPER_SHELL_COMMANDS = new Set(["command", "doas", "env", "exec", "sudo", "time"]);

const SHELL_RESERVED_WORDS = new Set([
    "case",
    "coproc",
    "do",
    "done",
    "elif",
    "else",
    "esac",
    "fi",
    "for",
    "function",
    "if",
    "in",
    "select",
    "then",
    "time",
    "until",
    "while",
]);

const SHELL_KEYWORDS_EXPECTING_COMMAND = new Set([
    "coproc",
    "do",
    "elif",
    "else",
    "function",
    "if",
    "then",
    "time",
    "until",
    "while",
]);

const BOOLEAN_LONG_FLAGS = new Set([
    "all",
    "dry-run",
    "force",
    "help",
    "json",
    "quiet",
    "verbose",
    "version",
    "yes",
]);

const VALUE_SHORT_FLAGS = new Set(["c", "C", "f", "I", "m", "n", "o", "p", "t", "u"]);

const VALUE_SINGLE_DASH_LONG_FLAGS = new Set([
    "depth",
    "exec",
    "group",
    "maxdepth",
    "mindepth",
    "mtime",
    "name",
    "path",
    "size",
    "type",
    "user",
]);

const initialShellHighlightState: ShellHighlightState = {
    expectsCommand: true,
    expectingFlagValue: false,
    commandKind: "generic",
    sawScriptOperand: false,
    subcommandSeen: false,
};

function dim(theme: GlowupRenderTheme, text: string): string {
    return fg(theme, "dim", text);
}

function muted(theme: GlowupRenderTheme, text: string): string {
    return fg(theme, "muted", text);
}

function pathText(theme: GlowupRenderTheme, text: string): string {
    return fg(theme, "accent", text);
}

function instructionPathText(theme: GlowupRenderTheme, text: string): string {
    if (renderingAppearance.instructionPathColor !== null) {
        return `${trueColorOpen(renderingAppearance.instructionPathColor, false)}${text}${ansiStyles.color.close}`;
    }
    return fg(theme, "customMessageLabel", text);
}

function green(theme: GlowupRenderTheme, text: string): string {
    return fg(theme, "toolDiffAdded", text);
}

function red(theme: GlowupRenderTheme, text: string): string {
    return fg(theme, "toolDiffRemoved", text);
}

function success(theme: GlowupRenderTheme, text: string): string {
    return fg(theme, "success", text);
}

export function collapseHome(path: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (
        home !== undefined &&
        home.length > 0 &&
        (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))
    ) {
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
                truncateToWidth(neutralizeTerminalControls(line), safeWidth, ""),
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
    const wrapped = wrapTextWithAnsi(neutralizeTerminalControls(text), safeWidth);
    if (wrapped.length === 0) {
        return [""];
    }
    return wrapped.map((line) => truncateToWidth(line, safeWidth, ""));
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
    theme: GlowupRenderTheme,
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

export function toolExpandHint(): string {
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
    if (mode === "head") {
        return [
            ...lines.slice(0, lineBudget),
            `… +${lines.length - lineBudget} lines (${omittedHint})`,
        ];
    }

    const headCount = Math.ceil(lineBudget / 2);
    const tailCount = Math.floor(lineBudget / 2);
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

    const normalized = normalizeOutputText(text);

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
    const headCount = mode === "headTail" ? Math.ceil(lineBudget / 2) : lineBudget;
    const tailCount = mode === "headTail" ? Math.floor(lineBudget / 2) : 0;
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

    visitPhysicalLines(normalized, (line) => {
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
        if (isCommandExitStatusLine(line)) {
            pendingBlankLineCount = 0;
            pendingBlankLineSamples = [];
        } else {
            flushPendingBlankLines();
        }
        consumeLine(line);
    });

    if (!sawContent) {
        return { isEmpty: true };
    }
    if (allLines !== undefined) {
        return { isEmpty: false, lines: allLines };
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
    const normalizedLineEndings = text.replace(/\r\n/g, "\n");
    let output = "";
    let lineStart = 0;

    for (let index = 0; index < normalizedLineEndings.length; index += 1) {
        const charCode = normalizedLineEndings.charCodeAt(index);
        if (charCode === 10) {
            output += `${normalizedLineEndings.slice(lineStart, index)}\n`;
            lineStart = index + 1;
            continue;
        }
        if (charCode === 13) {
            lineStart = index + 1;
        }
    }

    return `${output}${normalizedLineEndings.slice(lineStart)}`;
}

function isCommandExitStatusLine(line: string): boolean {
    return /^Command exited with code \d+$/u.test(line.trim());
}

function detachedPreviewLine(line: string, maxBytes: number): string {
    const suffixBytes = Buffer.byteLength(UTF8_TRUNCATION_SUFFIX, "utf8");
    if (Buffer.byteLength(line, "utf8") <= maxBytes) {
        return detachString(line);
    }

    const budget = Math.max(0, maxBytes - suffixBytes);
    return detachString(`${truncateUtf8ByGrapheme(line, budget)}${UTF8_TRUNCATION_SUFFIX}`);
}

function isPreviewMetaLine(line: string): boolean {
    return (
        line.startsWith("… +") ||
        /^… \d+ import\/setup lines omitted$/u.test(line) ||
        line === "… command preview truncated while streaming" ||
        line === "… preview truncated" ||
        line === "… script preview truncated" ||
        line === "… write preview truncated"
    );
}

function highlightCodePreviewRuns(
    lines: ReadonlyArray<string>,
    highlightRun: (code: string) => ReadonlyArray<string>,
): ReadonlyArray<string> {
    const highlighted: string[] = [];
    let run: string[] = [];

    function flushRun(): void {
        if (run.length === 0) {
            return;
        }
        highlighted.push(...highlightRun(run.join("\n")));
        run = [];
    }

    for (const line of lines) {
        if (isPreviewMetaLine(line)) {
            flushRun();
            highlighted.push(line);
            continue;
        }
        run.push(line);
    }

    flushRun();
    return highlighted;
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
        `[pi-glowup] renderGlowupOutput retained ${JSON.stringify({
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

function renderBullet(theme: GlowupRenderTheme, state: GlowupCallState): string {
    const indicator = toolCallIndicator.bold
        ? theme.bold(toolCallIndicator.symbol)
        : toolCallIndicator.symbol;
    if (state === "success") {
        return success(theme, indicator);
    }
    if (state === "error") {
        return red(theme, indicator);
    }
    if (state === "muted") {
        return dim(theme, indicator);
    }
    return muted(theme, indicator);
}

export type GlowupCallRenderOptions = {
    readonly state: GlowupCallState;
    readonly statusText: string;
    readonly body?: string;
    readonly maxRenderedLines?: number;
    readonly omittedHint?: string;
};

export function renderGlowupCall(
    theme: GlowupRenderTheme,
    options: GlowupCallRenderOptions,
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

export function renderGlowupBody(text: string | undefined): Component {
    return makeComponent((width) => wrapPrefixedLine(text, width, "", ""));
}

export function renderGlowupExplore(
    theme: GlowupRenderTheme,
    actions: ReadonlyArray<string | undefined>,
    options: { readonly statusText?: string; readonly state?: GlowupCallState } = {},
): Component {
    return makeComponent((width) => {
        const rendered = wrapPrefixedLine(
            actionText(theme, options.statusText ?? "Explored", { bold: true }),
            width,
            `${renderBullet(theme, options.state ?? "muted")} `,
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

export type MutationCallRenderOptions = {
    readonly body?: Component;
    readonly labelColumnWidth?: number;
    readonly statDigitWidth?: number;
    readonly state?: GlowupCallState;
};

export function renderMutationCall(
    theme: GlowupRenderTheme,
    summary: MutationSummary,
    options: MutationCallRenderOptions = {},
): Component {
    return makeComponent((width) => {
        const stats = formatMutationStats(theme, summary, options.statDigitWidth);
        const body = `${formatPathTarget(theme, summary.path)} ${stats}`;
        const label =
            options.labelColumnWidth === undefined
                ? summary.label
                : summary.label.padEnd(options.labelColumnWidth, " ");
        const prefix = `${renderBullet(theme, options.state ?? "muted")} ${actionText(theme, label, { bold: true })} `;
        return [
            ...wrapPrefixedLine(body, width, prefix, "  "),
            ...(options.body?.render(width) ?? []),
        ];
    });
}

function formatMutationStats(
    theme: GlowupRenderTheme,
    summary: MutationSummary,
    statDigitWidth: number | undefined,
): string {
    const width = Math.max(
        1,
        statDigitWidth ?? 1,
        String(summary.added).length,
        String(summary.removed).length,
    );
    const added = green(theme, `+${String(summary.added).padStart(width)}`);
    const removed = red(theme, `-${String(summary.removed).padStart(width)}`);
    if (summary.added <= 0) {
        return summary.removed <= 0 ? "" : `(${removed})`;
    }
    return summary.removed <= 0 ? `(${added})` : `(${added} ${removed})`;
}

type WrappedPreviewLine = {
    readonly isMeta: boolean;
    readonly rows: ReadonlyArray<string>;
    readonly text: string;
};

function flattenWrappedRows(lines: ReadonlyArray<WrappedPreviewLine>): string[] {
    return lines.flatMap((line) => line.rows);
}

function renderCollapsedWrappedPreview(
    lines: ReadonlyArray<WrappedPreviewLine>,
    options: {
        readonly mode: "headTail" | "head" | "hidden";
        readonly rowBudget: number;
        readonly prefixFirst: string;
        readonly prefixRest: string;
        readonly width: number;
        readonly omittedHint: string;
        readonly theme: GlowupRenderTheme;
    },
): string[] {
    const rendered = flattenWrappedRows(lines);
    const metaIndex = lines.findIndex((line) => line.isMeta);
    if (metaIndex === -1 && rendered.length <= options.rowBudget) {
        return rendered;
    }

    const markerText =
        metaIndex === -1
            ? `… preview truncated (${options.omittedHint})`
            : (lines[metaIndex]?.text ?? `… preview truncated (${options.omittedHint})`);
    const before = flattenWrappedRows(
        lines.filter((line, index) => !line.isMeta && (metaIndex === -1 || index < metaIndex)),
    );
    const after =
        metaIndex === -1
            ? []
            : flattenWrappedRows(lines.filter((line, index) => !line.isMeta && index > metaIndex));
    const allContent = metaIndex === -1 ? before : [...before, ...after];
    const marker = (prefix: string): string =>
        truncateToWidth(`${prefix}${muted(options.theme, markerText)}`, options.width, "…");

    if (allContent.length <= options.rowBudget) {
        return [
            ...before,
            marker(before.length === 0 ? options.prefixFirst : options.prefixRest),
            ...after,
        ];
    }

    if (options.mode === "head") {
        const head = allContent.slice(0, options.rowBudget);
        return [...head, marker(head.length === 0 ? options.prefixFirst : options.prefixRest)];
    }

    const headCount = Math.ceil(options.rowBudget / 2);
    const tailCount = Math.floor(options.rowBudget / 2);
    const head = (metaIndex === -1 ? allContent : before).slice(0, headCount);
    const tailSource = metaIndex === -1 ? allContent : after;
    const tail = tailCount === 0 ? [] : tailSource.slice(tailSource.length - tailCount);
    return [...head, marker(head.length === 0 ? options.prefixFirst : options.prefixRest), ...tail];
}

export type GlowupOutputRenderOptions = {
    readonly expanded: boolean;
    readonly mode?: "headTail" | "head" | "hidden";
    readonly maxPreviewLines?: number;
    readonly prefixFirst?: string;
    readonly prefixRest?: string;
    readonly dimContent?: boolean;
    readonly noOutputLabel?: string | null;
    readonly omittedHint?: string;
    readonly syntax?: CodeOutputSyntax;
};

export function renderGlowupOutput(
    theme: GlowupRenderTheme,
    text: string | undefined,
    options: GlowupOutputRenderOptions,
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
        const suppressTruncatedJsonHighlighting =
            retained.kind === "collapsed" &&
            visible.some(isPreviewMetaLine) &&
            (syntax?.language?.toLowerCase() === "json" || /\.jsonc?$/iu.test(syntax?.path ?? ""));
        const displayLines =
            syntax === undefined || suppressTruncatedJsonHighlighting
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
        const wrappedLines: WrappedPreviewLine[] = [];
        for (const [index, line] of displayLines.entries()) {
            const prefix = index === 0 ? prefixFirst : prefixRest;
            let styled = line;
            if (isPreviewMetaLine(line)) {
                styled = muted(theme, line);
            } else if (dimContent) {
                styled = muted(theme, line);
            }

            wrappedLines.push({
                isMeta: isPreviewMetaLine(line),
                rows: wrapPrefixedLine(styled, width, prefix, prefixRest),
                text: line,
            });
        }

        if (retained.kind === "expanded") {
            return flattenWrappedRows(wrappedLines);
        }
        return renderCollapsedWrappedPreview(wrappedLines, {
            mode,
            rowBudget: Math.max(1, Math.floor(maxPreviewLines)),
            prefixFirst,
            prefixRest,
            width,
            omittedHint,
            theme,
        });
    });
}

function highlightPreviewLines(
    lines: ReadonlyArray<string>,
    syntax: CodeOutputSyntax,
): ReadonlyArray<string> {
    return highlightCodePreviewRuns(lines, (code) => highlightCodeOutput(code, syntax));
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

export function isPartialInstructionFilePath(path: string | undefined): boolean {
    const normalized = (path ?? "").replace(/\\/g, "/");
    const basename = normalized.split("/").at(-1) ?? "";
    if (basename === "AGENTS" || basename.startsWith("AGENTS.")) {
        return true;
    }

    return /(?:^|\/|~\/)\.pi\/agent\/(?:skills(?:\/|$)|(?:git|npm\/node_modules)\/.+\/skills(?:\/|$))/u.test(
        normalized,
    );
}

export function formatPathTarget(
    theme: GlowupRenderTheme,
    path: string | undefined,
    options: { readonly isPartial?: boolean } = {},
): string {
    const displayPath = collapseHome(path ?? "");
    if (
        isInstructionFilePath(path) ||
        (options.isPartial === true && isPartialInstructionFilePath(path))
    ) {
        return instructionPathText(theme, displayPath);
    }
    if (options.isPartial === true) {
        return muted(theme, displayPath);
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

function stripShellWrapper(command: string | undefined): string {
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
    return directScriptInterpreter(tokenizeShellWords(prefix))?.interpreter;
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

type ShellLexeme = {
    readonly kind: "word" | "separator" | "redirection";
    readonly source: string;
    readonly start: number;
    readonly end: number;
};

function tokenizeShellLexemes(command: string): ShellLexeme[] {
    const lexemes: ShellLexeme[] = [];
    let wordStart: number | undefined;
    let quote: "'" | '"' | undefined;
    let escaped = false;

    const pushWord = (end: number): void => {
        if (wordStart !== undefined) {
            lexemes.push({
                kind: "word",
                source: command.slice(wordStart, end),
                start: wordStart,
                end,
            });
            wordStart = undefined;
        }
    };

    for (let index = 0; index < command.length; index += 1) {
        const char = command[index] ?? "";
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
            wordStart ??= index;
            escaped = true;
            continue;
        }
        if (char === "'" || char === '"') {
            wordStart ??= index;
            quote = char;
            continue;
        }
        if (/\s/u.test(char)) {
            pushWord(index);
            if (char === "\n" || char === "\r") {
                lexemes.push({ kind: "separator", source: char, start: index, end: index + 1 });
            }
            continue;
        }
        if (["|", ";", "&", "<", ">", "(", ")"].includes(char)) {
            pushWord(index);
            lexemes.push({
                kind: char === "<" || char === ">" ? "redirection" : "separator",
                source: char,
                start: index,
                end: index + 1,
            });
            continue;
        }
        wordStart ??= index;
    }

    pushWord(command.length);
    return lexemes;
}

function tokenizeShellWords(command: string): string[] {
    return tokenizeShellLexemes(command)
        .filter((lexeme) => lexeme.kind === "word")
        .map((lexeme) => lexeme.source);
}

function hasDynamicShellExpansion(command: string): boolean {
    let quote: "'" | '"' | undefined;
    let escaped = false;

    for (const char of command) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\" && quote !== "'") {
            escaped = true;
            continue;
        }
        if (char === "'" || char === '"') {
            if (quote === undefined) quote = char;
            else if (quote === char) quote = undefined;
            continue;
        }
        if (quote !== "'" && (char === "$" || char === "`")) return true;
    }

    return false;
}

function hasComposedShellSyntax(command: string): boolean {
    return (
        tokenizeShellLexemes(command).some((lexeme) => lexeme.kind !== "word") ||
        hasDynamicShellExpansion(command)
    );
}

type DirectScriptInterpreter = {
    readonly interpreter: ScriptInterpreter;
    readonly index: number;
};

const wrapperOptionsWithValues = new Set([
    "--directory",
    "--env-file",
    "--exclude-newer",
    "--extra",
    "--extra-index",
    "--find-links",
    "--group",
    "--index",
    "--only-group",
    "--package",
    "--project",
    "--python",
    "--python-platform",
    "--resolution",
    "--with",
    "--with-editable",
    "--with-requirements",
    "-C",
    "-p",
    "-u",
]);

function commandBasename(word: string): string {
    const cleanWord = unquoteCommandWord(word);
    const parts = cleanWord.split(/[\\/]/u);
    return (parts[parts.length - 1] ?? cleanWord).toLowerCase().replace(/\.exe$/u, "");
}

function isEnvironmentAssignment(word: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(decodeShellWord(word));
}

function commandIndexAfterOptions(words: readonly string[], start: number): number | undefined {
    let index = start;
    while (index < words.length) {
        const value = decodeShellWord(words[index] ?? "");
        if (isEnvironmentAssignment(words[index] ?? "")) {
            index += 1;
            continue;
        }
        if (value === "--") return words[index + 1] === undefined ? undefined : index + 1;
        if (!value.startsWith("-") || value === "-") return index;
        if (!value.includes("=") && wrapperOptionsWithValues.has(value)) index += 2;
        else index += 1;
    }
    return undefined;
}

function directScriptInterpreterFrom(
    words: readonly string[],
    initialStart: number,
    depth: number,
): DirectScriptInterpreter | undefined {
    if (depth > 4) return undefined;
    let start = initialStart;
    while (isEnvironmentAssignment(words[start] ?? "")) start += 1;
    const executable = commandBasename(words[start] ?? "");
    const direct = scriptInterpreterForWord(words[start] ?? "");
    if (direct !== undefined) return { interpreter: direct, index: start };

    let commandIndex: number | undefined;
    if (executable === "env" || executable === "command" || executable === "exec") {
        commandIndex = commandIndexAfterOptions(words, start + 1);
    } else if (executable === "uv") {
        const runIndex = words.findIndex(
            (word, index) => index > start && decodeShellWord(word) === "run",
        );
        if (runIndex >= 0) commandIndex = commandIndexAfterOptions(words, runIndex + 1);
    } else if (executable === "uvx" || executable === "npx") {
        commandIndex = commandIndexAfterOptions(words, start + 1);
    } else if (["npm", "pnpm", "yarn"].includes(executable)) {
        const execIndex = words.findIndex(
            (word, index) => index > start && ["dlx", "exec", "x"].includes(decodeShellWord(word)),
        );
        if (execIndex >= 0) commandIndex = commandIndexAfterOptions(words, execIndex + 1);
    }
    if (commandIndex === undefined) return undefined;
    return directScriptInterpreterFrom(words, commandIndex, depth + 1);
}

function directScriptInterpreter(words: readonly string[]): DirectScriptInterpreter | undefined {
    return directScriptInterpreterFrom(words, 0, 0);
}

function inlineScriptFlagsForInterpreter(interpreter: ScriptInterpreter): ReadonlySet<string> {
    if (interpreter.language === "python") {
        return new Set(["-c"]);
    }
    if (interpreter.displayName === "Node") {
        return new Set(["-e", "--eval", "-p", "--print"]);
    }
    if (interpreter.displayName === "Deno") {
        return new Set(["eval"]);
    }
    if (interpreter.displayName === "Bun" || interpreter.displayName === "TypeScript") {
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

type InlineScriptCode = {
    readonly code: string;
    readonly wordIndex: number;
};

function inlineScriptCodeForInterpreter(
    interpreter: ScriptInterpreter,
    words: ReadonlyArray<string>,
    startIndex: number,
): InlineScriptCode | undefined {
    if (interpreter.displayName === "Deno") {
        const evalIndex = words.findIndex(
            (word, index) => index >= startIndex && decodeShellWord(word) === "eval",
        );
        if (evalIndex < 0) return undefined;
        let index = evalIndex + 1;
        while (index < words.length) {
            const value = decodeShellWord(words[index] ?? "");
            if (value === "--ext") {
                index += 2;
                continue;
            }
            if (value.startsWith("-") && !isQuotedShellWord(words[index] ?? "")) {
                index += 1;
                continue;
            }
            return { code: value, wordIndex: index };
        }
        return undefined;
    }
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
                return isUnquotedFlagLikeScriptCode(codeWord, code)
                    ? undefined
                    : { code, wordIndex: index + 1 };
            }
            const assignmentPrefix = `${flag}=`;
            if (value.startsWith(assignmentPrefix)) {
                const code = value.slice(assignmentPrefix.length);
                return /^-[A-Za-z-]/u.test(code) ? undefined : { code, wordIndex: index };
            }
        }
    }

    return undefined;
}

function parseInlineScriptInvocation(displayCommand: string): ScriptInvocation | undefined {
    if (hasComposedShellSyntax(displayCommand)) return undefined;
    const words = tokenizeShellWords(displayCommand);
    const direct = directScriptInterpreter(words);
    if (direct === undefined) return undefined;
    const inlineScript = inlineScriptCodeForInterpreter(
        direct.interpreter,
        words,
        direct.index + 1,
    );
    return inlineScript === undefined
        ? undefined
        : buildScriptInvocationForInterpreter(direct.interpreter, inlineScript.code);
}

type EmbeddedInlineScript = {
    readonly start: number;
    readonly end: number;
    readonly language: string;
};

function embeddedInlineScripts(command: string): EmbeddedInlineScript[] {
    if (heredocOpenPattern.test(command)) return [];
    const lexemes = tokenizeShellLexemes(command);
    const scripts: EmbeddedInlineScript[] = [];
    let segment: ShellLexeme[] = [];

    const collectSegment = (): void => {
        const words = segment.filter((lexeme) => lexeme.kind === "word");
        const direct = directScriptInterpreter(words.map((word) => word.source));
        if (direct === undefined) {
            segment = [];
            return;
        }
        const inlineScript = inlineScriptCodeForInterpreter(
            direct.interpreter,
            words.map((word) => word.source),
            direct.index + 1,
        );
        const codeWord = inlineScript === undefined ? undefined : words[inlineScript.wordIndex];
        if (
            codeWord?.source.startsWith("'") === true &&
            codeWord.source.endsWith("'") &&
            codeWord.source.length >= 2
        ) {
            scripts.push({
                start: codeWord.start + 1,
                end: codeWord.end - 1,
                language: direct.interpreter.language,
            });
        }
        segment = [];
    };

    for (const lexeme of lexemes) {
        if (lexeme.kind === "separator") collectSegment();
        else segment.push(lexeme);
    }
    collectSegment();
    return scripts;
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

function highlightShellLine(theme: GlowupRenderTheme, line: string): string {
    const commentStart = shellCommentStart(line);
    const shellPart = commentStart === undefined ? line : line.slice(0, commentStart);
    const commentPart = commentStart === undefined ? "" : line.slice(commentStart);
    let state = initialShellHighlightState;
    const highlightedShell = tokenizeShellLine(shellPart)
        .map((token) => {
            const result = styleShellToken(theme, token, state);
            state = result.state;
            return result.styled;
        })
        .join("");
    return `${highlightedShell}${commentPart.length === 0 ? "" : dim(theme, commentPart)}`;
}

type EmbeddedInlineHighlightRow = {
    readonly start: number;
    readonly end: number;
    readonly highlighted: string;
};

function embeddedInlineHighlightRows(
    lines: ReadonlyArray<string>,
): ReadonlyMap<number, ReadonlyArray<EmbeddedInlineHighlightRow>> {
    const source = lines.join("\n");
    const scripts = embeddedInlineScripts(source);
    if (scripts.length === 0) return new Map();

    const lineStarts: number[] = [0];
    for (let index = 0; index < source.length; index += 1) {
        if (source[index] === "\n") lineStarts.push(index + 1);
    }
    const rows = new Map<number, EmbeddedInlineHighlightRow[]>();

    for (const script of scripts) {
        const code = source.slice(script.start, script.end);
        const highlightedLines = highlightSyntaxCode(code, script.language);
        let absoluteStart = script.start;
        for (const highlighted of highlightedLines) {
            let lineIndex = 0;
            while (
                lineIndex + 1 < lineStarts.length &&
                (lineStarts[lineIndex + 1] ?? Number.POSITIVE_INFINITY) <= absoluteStart
            ) {
                lineIndex += 1;
            }
            const lineStart = lineStarts[lineIndex];
            if (lineStart === undefined) break;
            const newline = source.indexOf("\n", absoluteStart);
            const absoluteEnd = newline < 0 || newline > script.end ? script.end : newline;
            const lineRows = rows.get(lineIndex) ?? [];
            lineRows.push({
                start: absoluteStart - lineStart,
                end: absoluteEnd - lineStart,
                highlighted,
            });
            rows.set(lineIndex, lineRows);
            absoluteStart = absoluteEnd + 1;
        }
    }

    return rows;
}

function highlightShellLineWithEmbeddedCode(
    theme: GlowupRenderTheme,
    line: string,
    rows: ReadonlyArray<EmbeddedInlineHighlightRow> | undefined,
): string {
    if (rows === undefined || rows.length === 0) return highlightShellLine(theme, line);
    const highlighted: string[] = [];
    let cursor = 0;
    for (const row of rows) {
        highlighted.push(highlightShellLine(theme, line.slice(cursor, row.start)));
        highlighted.push(row.highlighted);
        cursor = row.end;
    }
    highlighted.push(highlightShellLine(theme, line.slice(cursor)));
    return highlighted.join("");
}

function highlightBashScriptPreviewLines(
    lines: ReadonlyArray<string>,
    theme: GlowupRenderTheme,
): string[] {
    const highlighted: string[] = [];
    const embeddedRows = embeddedInlineHighlightRows(lines);
    let heredoc: BashHeredocHighlight | undefined;
    let heredocBody: string[] = [];

    function flushHeredocBody(): void {
        if (heredoc === undefined || heredocBody.length === 0) {
            return;
        }
        highlighted.push(...highlightSyntaxCode(heredocBody.join("\n"), heredoc.language));
        heredocBody = [];
    }

    for (const [lineIndex, line] of lines.entries()) {
        if (isPreviewMetaLine(line)) {
            flushHeredocBody();
            highlighted.push(line);
            continue;
        }

        if (heredoc !== undefined) {
            if (line.trim() === heredoc.marker) {
                flushHeredocBody();
                highlighted.push(highlightShellLine(theme, line));
                heredoc = undefined;
                continue;
            }

            heredocBody.push(line);
            continue;
        }

        highlighted.push(
            highlightShellLineWithEmbeddedCode(theme, line, embeddedRows.get(lineIndex)),
        );
        heredoc = bashHeredocHighlightFromLine(line);
    }

    flushHeredocBody();

    return highlighted;
}

function highlightScriptPreviewLines(
    lines: ReadonlyArray<string>,
    language: string,
    theme: GlowupRenderTheme,
): string[] {
    if (language === "bash") {
        return highlightBashScriptPreviewLines(lines, theme);
    }

    return [...highlightCodePreviewRuns(lines, (code) => highlightSyntaxCode(code, language))];
}

function scriptPreviewSyntaxLanguages(invocation: ScriptInvocation): readonly string[] {
    const languages = new Set<string>([invocation.language]);
    if (invocation.language !== "bash") {
        return [...languages];
    }

    for (const line of invocation.code.split("\n")) {
        const heredoc = bashHeredocHighlightFromLine(line);
        if (heredoc !== undefined) {
            languages.add(heredoc.language);
        }
    }
    for (const script of embeddedInlineScripts(invocation.code)) {
        languages.add(script.language);
    }

    return [...languages];
}

function scheduleScriptPreviewSyntaxLoads(
    invocation: ScriptInvocation,
    invalidate: (() => void) | undefined,
): void {
    for (const language of scriptPreviewSyntaxLanguages(invocation)) {
        scheduleCodeOutputSyntaxLoad({ language }, invalidate);
    }
}

export function parseScriptInvocation(command: string | undefined): ScriptInvocation | undefined {
    const displayCommand = stripShellWrapper(command);
    return (
        parseHeredocScriptInvocation(displayCommand) ?? parseInlineScriptInvocation(displayCommand)
    );
}

function collapsedScriptPreview(
    invocation: ScriptInvocation,
    maxCodePreviewLines: number,
    showPrologueOmission: boolean,
): ScriptPreview {
    if (trimEdgeBlankLines(invocation.code.split("\n")).length <= maxCodePreviewLines) {
        return { code: invocation.code };
    }
    const omission = omitLeadingImportPrologue(
        invocation.code,
        invocation.language,
        maxCodePreviewLines,
    );
    if (omission === undefined) return { code: invocation.code };
    return {
        code: showPrologueOmission
            ? `… ${omission.omittedLines} import/setup lines omitted\n${omission.code}`
            : omission.code,
    };
}

function scriptPreviewForRender(
    invocation: ScriptInvocation,
    expanded: boolean,
    maxCodePreviewLines: number,
    showPrologueOmission: boolean,
): ScriptPreview {
    if (expanded) {
        return { code: invocation.code };
    }
    return collapsedScriptPreview(invocation, maxCodePreviewLines, showPrologueOmission);
}

function retainedScriptInvocation(
    invocation: ScriptInvocation,
    expanded: boolean,
    maxCodePreviewLines: number,
    showPrologueOmission: boolean,
): ScriptInvocation {
    if (expanded) {
        return invocation;
    }

    return {
        label: invocation.label,
        language: invocation.language,
        code: detachedScriptPreviewCode(
            collapsedScriptPreview(invocation, maxCodePreviewLines, showPrologueOmission).code,
        ),
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
    return detachString(`${truncateUtf8ByGrapheme(code, budget)}${suffix}`);
}

function wrapScriptLine(
    theme: GlowupRenderTheme,
    line: string,
    width: number,
    firstPrefix: string,
): string[] {
    return wrapSinglePhysicalLineWithContinuation(line, width, firstPrefix, dim(theme, "  │   "));
}

function renderScriptHeader(
    theme: GlowupRenderTheme,
    state: GlowupCallState,
    label: string,
): string {
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

export type ScriptCallRenderOptions = {
    readonly state: GlowupCallState;
    readonly expanded: boolean;
    readonly maxCodePreviewLines?: number;
    readonly showPrologueOmission?: boolean;
    readonly omittedHint?: string;
    readonly headerLayout?: ScriptPreviewHeaderLayout;
    readonly invalidate?: () => void;
};

export function renderScriptCall(
    theme: GlowupRenderTheme,
    invocation: ScriptInvocation,
    options: ScriptCallRenderOptions,
): Component {
    const expanded = options.expanded;
    const state = options.state;
    const maxCodePreviewLines = options.maxCodePreviewLines ?? 8;
    const showPrologueOmission = options.showPrologueOmission ?? false;
    const retained = retainedScriptInvocation(
        invocation,
        expanded,
        maxCodePreviewLines,
        showPrologueOmission,
    );
    const omittedHint = options.omittedHint ?? toolExpandHint();
    const headerLayoutOption = options.headerLayout ?? "auto";
    scheduleScriptPreviewSyntaxLoads(retained, options.invalidate);

    return makeComponent((width) => {
        const header = renderScriptHeader(theme, state, retained.label);
        const preview = scriptPreviewForRender(
            retained,
            expanded,
            maxCodePreviewLines,
            showPrologueOmission,
        );

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
        const highlighted = highlightScriptPreviewLines(visible, retained.language, theme);
        const rendered: string[] = [];
        const headerLayout = resolveScriptHeaderLayout(headerLayoutOption, retained, highlighted);

        if (headerLayout === "block") {
            rendered.push(...wrapPrefixedLine("", width, header, "  "));
        }

        let contentRows = 0;
        let softWrapTruncated = false;
        for (const [index, line] of highlighted.entries()) {
            const meta = isPreviewMetaLine(line);
            const styled = meta ? muted(theme, line) : line;
            const firstPrefix =
                headerLayout === "inline" && index === 0 ? `${header} ` : dim(theme, "  │ ");
            const wrapped = wrapScriptLine(theme, styled, width, firstPrefix);
            if (expanded || meta) {
                rendered.push(...wrapped);
                continue;
            }
            const remainingRows = Math.max(0, maxCodePreviewLines - contentRows);
            if (wrapped.length <= remainingRows) {
                rendered.push(...wrapped);
                contentRows += wrapped.length;
                continue;
            }
            rendered.push(...wrapped.slice(0, remainingRows));
            softWrapTruncated = true;
            break;
        }

        if (softWrapTruncated) {
            rendered.push(
                ...wrapScriptLine(
                    theme,
                    muted(theme, "… preview truncated"),
                    width,
                    dim(theme, "  │ "),
                ),
            );
        }

        return rendered;
    });
}

function tokenizeShellLine(line: string): string[] {
    if (line.length === 0) {
        return [];
    }
    return (
        line.match(
            /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|&&|\|\||2>>|2>|>>|\[\[|\]\]|[|;&<>{}!]|\s+|[^\s|;&<>{}!]+/g,
        ) ?? [line]
    );
}

function shellCommentStart(line: string): number | undefined {
    let quote: '"' | "'" | undefined;
    let escaped = false;

    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\" && quote !== "'") {
            escaped = true;
            continue;
        }
        if (quote !== undefined) {
            if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
            return index;
        }
    }

    return undefined;
}

function shellCommandName(token: string): string {
    const normalized = token.replace(/^.*\//u, "");
    return normalized.toLowerCase();
}

function shellCommandKind(token: string): ShellCommandKind {
    const commandName = shellCommandName(token);
    if (INTERPRETER_SHELL_COMMANDS.has(commandName)) {
        return "interpreter";
    }
    if (SUBCOMMAND_SHELL_COMMANDS.has(commandName)) {
        return "subcommands";
    }
    if (isScriptLikeShellWord(token)) {
        return "script";
    }
    return "generic";
}

function isShellWrapperCommand(token: string): boolean {
    return WRAPPER_SHELL_COMMANDS.has(shellCommandName(token));
}

function isQuotedShellString(token: string): boolean {
    return (
        (token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'"))
    );
}

function isScriptLikeShellWord(token: string): boolean {
    return /\.(?:cjs|cts|js|jsx|mjs|mts|py|rb|sh|ts|tsx)$/iu.test(token);
}

function isPathLikeShellWord(token: string): boolean {
    return (
        token === "." ||
        token === ".." ||
        token.startsWith("/") ||
        token.startsWith("./") ||
        token.startsWith("../") ||
        token.startsWith("~/") ||
        token.includes("/") ||
        /^[^\s:]+:.+\//u.test(token) ||
        /\.(?:cjs|conf|cts|env|js|json|jsx|lock|log|md|mjs|mts|py|rb|sh|toml|ts|tsx|txt|yaml|yml)$/iu.test(
            token,
        )
    );
}

function isShellFlagToken(token: string): boolean {
    return /^--[A-Za-z0-9][\w-]*(?:=.*)?$/u.test(token) || /^-[A-Za-z0-9][\w-]*$/u.test(token);
}

function styleShellFlagToken(theme: GlowupRenderTheme, token: string): string {
    const equalsIndex = token.indexOf("=");
    if (token.startsWith("--") && equalsIndex > 2) {
        const value = token.slice(equalsIndex + 1);
        return `${shellFlag(theme, token.slice(0, equalsIndex))}${shellOperator(theme, "=")}${shellValue(theme, value)}`;
    }
    return shellFlag(theme, token);
}

function shellValue(theme: GlowupRenderTheme, token: string): string {
    return isQuotedShellString(token) ? shellString(theme, token) : shellText(theme, token);
}

function shellFlagConsumesValue(token: string): boolean {
    if (token.includes("=")) {
        return false;
    }
    const longFlag = /^--(?<name>[A-Za-z0-9][\w-]*)$/u.exec(token)?.groups?.name;
    if (longFlag !== undefined) {
        return !BOOLEAN_LONG_FLAGS.has(longFlag);
    }
    const singleDashLongFlag = /^-(?<name>[A-Za-z][\w-]{1,})$/u.exec(token)?.groups?.name;
    if (singleDashLongFlag !== undefined) {
        return VALUE_SINGLE_DASH_LONG_FLAGS.has(singleDashLongFlag);
    }
    const shortFlag = /^-(?<name>[A-Za-z])$/u.exec(token)?.groups?.name;
    return shortFlag !== undefined && VALUE_SHORT_FLAGS.has(shortFlag);
}

function shellStateAfterOperand(state: ShellHighlightState): ShellHighlightState {
    return {
        ...state,
        expectsCommand: false,
        expectingFlagValue: false,
        sawScriptOperand: state.sawScriptOperand || state.commandKind === "interpreter",
    };
}

function shouldStyleShellSubcommand(state: ShellHighlightState, token: string): boolean {
    if (state.subcommandSeen || isPathLikeShellWord(token) || isQuotedShellString(token)) {
        return false;
    }
    if (state.commandKind === "interpreter") {
        return state.sawScriptOperand;
    }
    return state.commandKind === "script" || state.commandKind === "subcommands";
}

function styleShellToken(
    theme: GlowupRenderTheme,
    token: string,
    state: ShellHighlightState,
): ShellTokenStyleResult {
    if (/^\s+$/.test(token)) {
        return { styled: token, state };
    }

    if (
        [
            "|",
            "||",
            "&&",
            "&",
            ";",
            ">",
            ">>",
            "<",
            "2>",
            "2>>",
            "{",
            "}",
            "!",
            "[[",
            "]]",
        ].includes(token)
    ) {
        return { styled: shellOperator(theme, token), state: initialShellHighlightState };
    }

    if (SHELL_RESERVED_WORDS.has(token)) {
        return {
            styled: shellKeyword(theme, token),
            state: SHELL_KEYWORDS_EXPECTING_COMMAND.has(token)
                ? initialShellHighlightState
                : { ...initialShellHighlightState, expectsCommand: false },
        };
    }

    if (isShellFlagToken(token)) {
        return {
            styled: styleShellFlagToken(theme, token),
            state: {
                ...state,
                expectingFlagValue: shellFlagConsumesValue(token),
            },
        };
    }

    if (state.expectingFlagValue) {
        return {
            styled: shellValue(theme, token),
            state: shellStateAfterOperand(state),
        };
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
        return { styled: shellString(theme, token), state };
    }

    if (isQuotedShellString(token)) {
        return { styled: shellString(theme, token), state: shellStateAfterOperand(state) };
    }

    if (state.expectsCommand) {
        if (isShellWrapperCommand(token)) {
            return { styled: shellCommand(theme, token), state: initialShellHighlightState };
        }
        return {
            styled: shellCommand(theme, token),
            state: {
                expectsCommand: false,
                expectingFlagValue: false,
                commandKind: shellCommandKind(token),
                sawScriptOperand: false,
                subcommandSeen: false,
            },
        };
    }

    if (shouldStyleShellSubcommand(state, token)) {
        return {
            styled: shellCommand(theme, token),
            state: { ...state, expectingFlagValue: false, subcommandSeen: true },
        };
    }

    if (isPathLikeShellWord(token)) {
        return { styled: shellText(theme, token), state: shellStateAfterOperand(state) };
    }

    return { styled: shellText(theme, token), state: shellStateAfterOperand(state) };
}

export function formatReadAction(
    theme: GlowupRenderTheme,
    args: ReadActionArgs,
    options: { readonly isPartial?: boolean } = {},
): string {
    const target = formatPathTarget(theme, args.path, options);
    const range = formatLineRange(args.offset, args.limit);
    if (range !== undefined) {
        return `${actionText(theme, "Read")} ${target}${muted(theme, range)}`;
    }
    return `${actionText(theme, "Read")} ${target}`;
}

export function formatFindAction(theme: GlowupRenderTheme, args: FindActionArgs): string {
    const parts = [`${actionText(theme, "Find")} ${args.pattern ?? "*"}`];
    if (args.path !== undefined && args.path.length > 0) {
        parts.push(`in ${pathText(theme, collapseHome(args.path))}`);
    }
    if (typeof args.limit === "number") {
        parts.push(muted(theme, `limit ${args.limit}`));
    }
    return parts.join(" ");
}

export function formatGrepAction(theme: GlowupRenderTheme, args: GrepActionArgs): string {
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

export function formatLsAction(theme: GlowupRenderTheme, args: LsActionArgs): string {
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

/** Removes unchanged context rows while preserving changed-row coordinates and metadata. */
export function changedOnlyDiffSections(sections: ReadonlyArray<DiffSection>): DiffSection[] {
    return sections.flatMap((section) => {
        const retainedIndices = section.lines.flatMap((line, index) => {
            const parsed = parseDiffLine(line);
            return parsed?.kind === "context" || parsed?.kind === "ellipsis" ? [] : [index];
        });
        if (retainedIndices.length === 0) {
            return [];
        }

        const lines = retainedIndices.map((index) => section.lines[index] ?? "");
        const lineCoordinates = section.lineCoordinates;
        const changedSection: DiffSection = { ...section, lines };
        return lineCoordinates === undefined
            ? [changedSection]
            : [
                  {
                      ...changedSection,
                      lineCoordinates: retainedIndices.map((index) => lineCoordinates[index]),
                  },
              ];
    });
}

function makeDiffSection(path: string | undefined, lines: ReadonlyArray<string>): DiffSection {
    const visibleLines = trimEdgeEllipsisLines(lines);
    const section = {
        lines: visibleLines,
        lineCoordinates: deriveDiffLineCoordinates(visibleLines),
        added: visibleLines.filter((line) => addCountPattern.test(line)).length,
        removed: visibleLines.filter((line) => removeCountPattern.test(line)).length,
    };

    if (path === undefined) {
        return section;
    }
    return { ...section, path };
}

function deriveDiffLineCoordinates(
    lines: ReadonlyArray<string>,
): ReadonlyArray<DiffLineCoordinates | undefined> {
    let lineDelta = 0;
    return lines.map((line) => {
        const parsed = parseDiffLine(line);
        if (parsed === null || parsed.kind === "ellipsis" || parsed.kind === "omission") {
            return undefined;
        }
        const lineNumber = Number(normalizedDiffLineNumber(parsed.lineNumber));
        if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
            return undefined;
        }
        if (parsed.kind === "delete") {
            lineDelta -= 1;
            return { oldLine: lineNumber };
        }
        if (parsed.kind === "insert") {
            lineDelta += 1;
            return { newLine: lineNumber };
        }
        return { oldLine: lineNumber, newLine: lineNumber + lineDelta };
    });
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
    | { readonly kind: "omission"; readonly content: string }
    | null {
    if (ellipsisLinePattern.test(line)) {
        return { kind: "ellipsis" };
    }
    if (omissionLinePattern.test(line)) {
        return { kind: "omission", content: line.trimStart() };
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

function formatDiffLineNumber(lineNumber: string | number, width: number): string {
    const normalized = normalizedDiffLineNumber(String(lineNumber));
    if (normalized.length === 0) {
        return " ".repeat(Math.max(0, width));
    }
    return normalized.padStart(Math.max(normalized.length, width), " ");
}

function diffLineNumberWidth(
    lines: ReadonlyArray<string>,
    coordinates: ReadonlyArray<DiffLineCoordinates | undefined> | undefined,
): number {
    let width = 0;
    for (const [index, line] of lines.entries()) {
        const parsed = parseDiffLine(line);
        if (parsed === null || parsed.kind === "ellipsis" || parsed.kind === "omission") {
            continue;
        }
        width = Math.max(width, normalizedDiffLineNumber(parsed.lineNumber).length);
        const rowCoordinates = coordinates?.[index];
        width = Math.max(
            width,
            rowCoordinates?.oldLine === undefined ? 0 : String(rowCoordinates.oldLine).length,
            rowCoordinates?.newLine === undefined ? 0 : String(rowCoordinates.newLine).length,
        );
    }
    return width;
}

function diffLineNumberText(
    kind: "insert" | "delete" | "context",
    lineNumber: string,
    width: number,
    coordinates: DiffLineCoordinates | undefined,
): string {
    if (configuredDiffLineNumberStyle() === "single") {
        return `${formatDiffLineNumber(lineNumber, width)} `;
    }

    const oldLine = coordinates?.oldLine ?? (kind === "insert" ? "" : lineNumber);
    const newLine = coordinates?.newLine ?? (kind === "delete" ? "" : lineNumber);
    return `${formatDiffLineNumber(oldLine, width)} ${formatDiffLineNumber(newLine, width)} `;
}

function changedRangesForDiffLines(
    lines: ReadonlyArray<string>,
): ReadonlyArray<readonly TextRange[] | undefined> {
    const ranges: Array<readonly TextRange[] | undefined> = Array.from(
        { length: lines.length },
        () => undefined,
    );
    let deletions: Array<{ readonly index: number; readonly content: string }> = [];
    let insertions: Array<{ readonly index: number; readonly content: string }> = [];

    const flush = (): void => {
        const pairCount = Math.max(deletions.length, insertions.length);
        for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
            const deletion = deletions[pairIndex];
            const insertion = insertions[pairIndex];
            if (deletion !== undefined && insertion !== undefined) {
                const changed = changedTextRanges(deletion.content, insertion.content);
                ranges[deletion.index] = changed.before;
                ranges[insertion.index] = changed.after;
            }
        }
        deletions = [];
        insertions = [];
    };

    for (const [index, line] of lines.entries()) {
        const parsed = parseDiffLine(line);
        if (parsed === null || parsed.kind === "ellipsis" || parsed.kind === "omission") {
            flush();
            continue;
        }
        if (parsed.kind === "delete") {
            deletions.push({ index, content: parsed.content });
            continue;
        }
        if (parsed.kind === "insert") {
            insertions.push({ index, content: parsed.content });
            continue;
        }
        flush();
    }
    flush();
    return ranges;
}

function isUnchangedReplacementSide(
    line: string,
    changedRanges: readonly TextRange[] | undefined,
): boolean {
    const parsed = parseDiffLine(line);
    return (
        (parsed?.kind === "insert" || parsed?.kind === "delete") &&
        parsed.content.length > 0 &&
        changedRanges?.length === 0
    );
}

function wrapDiffText(text: string, width: number, maxWrappedRows: number | undefined): string[] {
    if (maxWrappedRows === undefined) {
        return wrapStyledText(text, width);
    }

    const boundedText = truncateToWidth(text, Math.max(1, width * maxWrappedRows), "…");
    return wrapStyledText(boundedText, width).slice(0, maxWrappedRows);
}

type DiffRowRenderOptions = {
    readonly path?: string;
    readonly lineNumberWidth?: number;
    readonly maxWrappedRows?: number;
    readonly highlightedContent?: string;
    readonly changedRanges?: readonly TextRange[];
    readonly lineCoordinates?: DiffLineCoordinates;
};

function renderDiffRow(
    line: string,
    width: number,
    leftPrefix: string,
    theme: GlowupRenderTheme,
    options?: DiffRowRenderOptions,
): string[] {
    const parsed = parseDiffLine(line);
    const rowWidth = Math.max(1, width);
    const prefixWidth = visibleWidth(leftPrefix);
    const contentWidth = Math.max(1, rowWidth - prefixWidth);

    if (!parsed) {
        return wrapDiffText(muted(theme, line), contentWidth, options?.maxWrappedRows).map((row) =>
            truncateToWidth(`${leftPrefix}${row}`, rowWidth, ""),
        );
    }

    if (parsed.kind === "ellipsis") {
        return [truncateToWidth(`${leftPrefix}${muted(theme, "⋮")}`, rowWidth, "")];
    }
    if (parsed.kind === "omission") {
        return wrapDiffText(
            muted(theme, parsed.content),
            contentWidth,
            options?.maxWrappedRows,
        ).map((row) => truncateToWidth(`${leftPrefix}${row}`, rowWidth, ""));
    }

    let sign = " ";
    if (parsed.kind === "insert") {
        sign = "+";
    }
    if (parsed.kind === "delete") {
        sign = "-";
    }

    const lineNumber = diffLineNumberText(
        parsed.kind,
        parsed.lineNumber,
        options?.lineNumberWidth ?? normalizedDiffLineNumber(parsed.lineNumber).length,
        options?.lineCoordinates,
    );
    const lineNumberWidth = visibleWidth(lineNumber);
    const rowPrefix = `${lineNumber}${sign}`;
    const wrapPrefix = `${" ".repeat(lineNumberWidth)} `;
    const availableWidth = Math.max(1, contentWidth - visibleWidth(rowPrefix));
    const baseContent = styleDiffContent(
        parsed.kind,
        options?.highlightedContent ?? highlightDiffContent(parsed.content, options?.path),
        theme,
    );
    const background = diffSpanBackground(parsed.kind, theme);
    const styledContent =
        background === undefined || options?.changedRanges === undefined
            ? baseContent
            : applyBackgroundToTextRanges(baseContent, options.changedRanges, background);
    if (parsed.content.length === 0) {
        const styledGutter = styleDiffGutter(parsed.kind, lineNumber, sign, theme);
        const row = truncateToWidth(`${leftPrefix}${styledGutter}`, rowWidth, "");
        return [paintDiffRowBackground(parsed.kind, row, rowWidth, theme)];
    }

    const wrappedContent = wrapDiffText(
        expandTerminalTabs(styledContent, 4, 0).text,
        availableWidth,
        options?.maxWrappedRows,
    );

    return wrappedContent.map((chunk, index) => {
        const styledGutter =
            index === 0
                ? styleDiffGutter(parsed.kind, lineNumber, sign, theme)
                : dim(theme, wrapPrefix);
        const row = `${leftPrefix}${styledGutter}${chunk}`;
        const bounded = truncateToWidth(row, rowWidth, "");
        return paintDiffRowBackground(parsed.kind, bounded, rowWidth, theme);
    });
}

function diffSpanBackground(
    kind: "insert" | "delete" | "context",
    theme: GlowupRenderTheme,
): { readonly open: string; readonly close: string } | undefined {
    const style = configuredDiffBackgroundStyle();
    if (kind === "context" || style === "full-row") {
        return undefined;
    }
    const rowBackground = diffRowBackgroundAnsi(kind, theme);
    const configuredBackground =
        style === "two-tone" ? configuredDiffContentBackgroundAnsi(kind) : rowBackground;
    if (configuredBackground !== undefined) {
        return {
            open: configuredBackground,
            close:
                style === "two-tone" && rowBackground !== undefined
                    ? rowBackground
                    : ansiStyles.bgColor.close,
        };
    }
    if (style === "two-tone" && rowBackground !== undefined) {
        const semanticForeground = diffSemanticForegroundAnsi(kind, theme);
        const stronger =
            semanticForeground === undefined
                ? undefined
                : strongerDiffBackgroundAnsi(rowBackground, semanticForeground);
        if (stronger !== undefined) {
            return { open: stronger, close: rowBackground };
        }
    }
    return rowBackground === undefined
        ? undefined
        : { open: rowBackground, close: ansiStyles.bgColor.close };
}

function paintDiffRowBackground(
    kind: "insert" | "delete" | "context",
    row: string,
    rowWidth: number,
    theme: GlowupRenderTheme,
): string {
    const style = configuredDiffBackgroundStyle();
    if (kind === "context" || (style !== "full-row" && style !== "two-tone")) {
        return row;
    }
    const padding = " ".repeat(Math.max(0, rowWidth - visibleWidth(row)));
    const background = diffRowBackgroundAnsi(kind, theme);
    if (background === undefined) {
        return row;
    }
    return `${background}${row}${padding}${ansiStyles.bgColor.close}`;
}

function diffRowBackgroundAnsi(
    kind: "insert" | "delete",
    theme: GlowupRenderTheme,
): string | undefined {
    const configured = configuredDiffBackgroundAnsi(kind);
    if (configured !== undefined) {
        return configured;
    }
    const token = kind === "insert" ? "toolSuccessBg" : "toolErrorBg";
    return theme.getBgAnsi?.(token) ?? extractStyledAnsi(theme.bg, token);
}

function diffSemanticForegroundAnsi(
    kind: "insert" | "delete",
    theme: GlowupRenderTheme,
): string | undefined {
    const token = kind === "insert" ? "toolDiffAdded" : "toolDiffRemoved";
    return theme.getFgAnsi?.(token) ?? extractStyledAnsi(theme.fg, token);
}

function extractStyledAnsi<TToken extends string>(
    style: ((token: TToken, text: string) => string) | undefined,
    token: TToken,
): string | undefined {
    if (style === undefined) {
        return undefined;
    }
    const sentinel = "__PI_GLOWUP_STYLE__";
    const wrapped = style(token, sentinel);
    const sentinelIndex = wrapped.indexOf(sentinel);
    if (sentinelIndex <= 0) {
        return undefined;
    }
    return wrapped.slice(0, sentinelIndex);
}

function styleDiffContent(
    kind: "insert" | "delete" | "context",
    content: string,
    theme: GlowupRenderTheme,
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

function highlightDiffContents(
    lines: ReadonlyArray<string>,
    filePath: string | undefined,
): ReadonlyArray<string | undefined> {
    if (filePath === undefined) {
        return [];
    }
    const syntaxPath = filePath;
    const highlightedByLine = new Map<number, string>();
    let run: Array<{ readonly index: number; readonly content: string }> = [];

    function flushRun(): void {
        if (run.length === 0) {
            return;
        }

        const highlightedLines = highlightCodeOutput(run.map((row) => row.content).join("\n"), {
            path: syntaxPath,
        });
        if (highlightedLines.length === run.length) {
            for (const [rowIndex, row] of run.entries()) {
                const highlighted = highlightedLines[rowIndex];
                if (highlighted !== undefined) {
                    highlightedByLine.set(row.index, preserveRowBackground(highlighted));
                }
            }
        }

        run = [];
    }

    for (const [index, line] of lines.entries()) {
        const parsed = parseDiffLine(line);
        if (parsed === null) {
            continue;
        }
        if (parsed.kind === "ellipsis" || parsed.kind === "omission") {
            flushRun();
            continue;
        }
        run.push({ index, content: parsed.content });
    }
    flushRun();

    return lines.map((_line, index) => highlightedByLine.get(index));
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
    theme: GlowupRenderTheme,
): string {
    const marker =
        kind === "insert"
            ? green(theme, sign)
            : kind === "delete"
              ? red(theme, sign)
              : dim(theme, sign);
    return `${dim(theme, lineNumber)}${marker}`;
}

export type SemanticDiffRowKind = "insert" | "delete" | "context" | "meta";

export function selectSemanticDiffIndices(
    kinds: readonly SemanticDiffRowKind[],
    lineBudget: number,
): readonly number[] {
    if (kinds.length <= lineBudget) {
        return kinds.map((_kind, index) => index);
    }

    const contentIndices: number[] = [];
    const changed: number[] = [];
    for (let index = 0; index < kinds.length; index += 1) {
        const kind = kinds[index];
        if (kind === undefined || kind === "meta") {
            continue;
        }
        contentIndices.push(index);
        if (kind === "insert" || kind === "delete") {
            changed.push(index);
        }
    }
    if (contentIndices.length <= lineBudget) {
        return contentIndices;
    }

    if (changed.length === 0) {
        const headCount = Math.ceil(lineBudget / 2);
        const tailCount = Math.floor(lineBudget / 2);
        return [
            ...contentIndices.slice(0, headCount),
            ...contentIndices.slice(contentIndices.length - tailCount),
        ];
    }

    const selected = new Set<number>();
    const changedHeadCount = Math.ceil(Math.min(lineBudget, changed.length) / 2);
    const changedTailCount = Math.min(lineBudget, changed.length) - changedHeadCount;
    for (const index of changed.slice(0, changedHeadCount)) {
        selected.add(index);
    }
    for (const index of changed.slice(changed.length - changedTailCount)) {
        selected.add(index);
    }

    let distance = 1;
    const firstChange = changed[0] ?? 0;
    const lastChange = changed.at(-1) ?? firstChange;
    while (selected.size < lineBudget && distance <= kinds.length) {
        for (const index of [firstChange - distance, lastChange + distance]) {
            if (
                index >= 0 &&
                index < kinds.length &&
                kinds[index] !== "meta" &&
                !selected.has(index)
            ) {
                selected.add(index);
                if (selected.size >= lineBudget) {
                    break;
                }
            }
        }
        distance += 1;
    }

    return [...selected].sort((left, right) => left - right);
}

function collapsedDiffLineIndices(
    sections: ReadonlyArray<DiffSection>,
    lineBudget: number,
): readonly number[] {
    return selectSemanticDiffIndices(
        sections.flatMap((section) =>
            section.lines.map((line): SemanticDiffRowKind => {
                const parsed = parseDiffLine(line);
                return parsed === null || parsed.kind === "ellipsis" || parsed.kind === "omission"
                    ? "meta"
                    : parsed.kind;
            }),
        ),
        lineBudget,
    );
}

export type GlowupDiffRenderOptions = {
    readonly collapsedLineBudget?: number;
    readonly maxWrappedRows?: number;
};

export function renderGlowupDiff(
    theme: GlowupRenderTheme,
    sections: ReadonlyArray<DiffSection>,
    expanded: boolean,
    options: GlowupDiffRenderOptions = {},
): Component {
    return makeComponent((width) => {
        const allDiffLineCount = sections.reduce(
            (count, section) => count + section.lines.length,
            0,
        );
        const collapsedLineBudget = Math.max(
            1,
            Math.floor(options.collapsedLineBudget ?? MUTATION_DIFF_PREVIEW_ROWS),
        );
        const shouldCollapse = !expanded && allDiffLineCount > collapsedLineBudget;
        const collapsedIndices = shouldCollapse
            ? collapsedDiffLineIndices(sections, collapsedLineBudget)
            : [];
        const collapsedLineIndexSet = new Set(collapsedIndices);
        const rendered: string[] = [];
        let sectionOffset = 0;
        let renderedSection = false;

        const renderOmission = (): void => {
            const omitted = allDiffLineCount - collapsedIndices.length;
            const hint = toolExpandHint();
            rendered.push(
                truncateToWidth(
                    `${dim(theme, "    ")} ${muted(theme, `… +${omitted} lines (`)}${hint}${muted(theme, ")")}`,
                    width,
                    "…",
                ),
            );
        };

        for (const section of sections) {
            const visibleLines: Array<{ readonly line: string; readonly index: number }> = [];
            for (const [lineIndex, line] of section.lines.entries()) {
                const globalLineIndex = sectionOffset + lineIndex;
                if (!shouldCollapse || collapsedLineIndexSet.has(globalLineIndex)) {
                    visibleLines.push({ line, index: lineIndex });
                }
            }
            sectionOffset += section.lines.length;

            if (visibleLines.length === 0) {
                continue;
            }

            if (renderedSection) {
                rendered.push("");
            }
            if (sections.length > 1) {
                const stats = formatMutationStats(
                    theme,
                    {
                        label: "",
                        path: "",
                        added: section.added,
                        removed: section.removed,
                    },
                    undefined,
                );
                const header = `${dim(theme, "  └ ")}${pathText(theme, collapseHome(section.path ?? "file"))}${stats.length === 0 ? "" : ` ${stats}`}`;
                rendered.push(...wrapPrefixedLine(header, width, "", "    "));
            }
            renderedSection = true;

            const sectionLineNumberWidth = diffLineNumberWidth(
                section.lines,
                section.lineCoordinates,
            );
            const highlightedContents = highlightDiffContents(section.lines, section.path);
            const changedRanges = changedRangesForDiffLines(section.lines);
            const renderLines = (
                lines: ReadonlyArray<{ readonly line: string; readonly index: number }>,
            ): void => {
                const maxWrappedRows = options.maxWrappedRows ?? (expanded ? undefined : 4);
                for (const { line, index } of lines) {
                    if (isUnchangedReplacementSide(line, changedRanges[index])) {
                        continue;
                    }
                    let rowOptions: DiffRowRenderOptions = {};
                    if (section.path !== undefined) {
                        rowOptions = { ...rowOptions, path: section.path };
                    }
                    rowOptions = { ...rowOptions, lineNumberWidth: sectionLineNumberWidth };
                    const lineCoordinates = section.lineCoordinates?.[index];
                    if (lineCoordinates !== undefined) {
                        rowOptions = { ...rowOptions, lineCoordinates };
                    }
                    const highlightedContent = highlightedContents[index];
                    if (highlightedContent !== undefined) {
                        rowOptions = { ...rowOptions, highlightedContent };
                    }
                    const lineChangedRanges = changedRanges[index];
                    if (lineChangedRanges !== undefined) {
                        rowOptions = { ...rowOptions, changedRanges: lineChangedRanges };
                    }
                    if (maxWrappedRows !== undefined) {
                        rowOptions = { ...rowOptions, maxWrappedRows };
                    }
                    rendered.push(...renderDiffRow(line, width, "    ", theme, rowOptions));
                }
            };

            renderLines(visibleLines);
        }
        if (shouldCollapse) {
            renderOmission();
        }

        return rendered;
    });
}
