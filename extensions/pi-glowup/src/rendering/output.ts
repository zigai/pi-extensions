import { hasNonWhitespaceText, truncateUtf8ByGrapheme } from "../text-boundaries.ts";
import { type GlowupRenderTheme, muted, dim } from "./theme.ts";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { type CodeOutputSyntax, highlightCodeOutput } from "./syntax/code-component.ts";
import { toolExpandHint, emptyComponent, makeComponent, wrapPrefixedLine } from "./component.ts";

const MAX_COLLAPSED_OUTPUT_PREVIEW_BYTES = 64 * 1024;

const MAX_COLLAPSED_OUTPUT_LINE_BYTES = 4 * 1024;

const MIN_COLLAPSED_OUTPUT_LINE_BYTES = 256;

const MAX_COLLAPSED_OUTPUT_PREVIEW_LINES = Math.max(
    1,
    Math.floor(MAX_COLLAPSED_OUTPUT_PREVIEW_BYTES / MIN_COLLAPSED_OUTPUT_LINE_BYTES),
);

const UTF8_TRUNCATION_SUFFIX = "…";

const RETAINED_OUTPUT_LOG_ENV = "PI_GLOWUP_RETAINED_OUTPUT_LOG";

export function trimEdgeBlankLines(lines: ReadonlyArray<string>): string[] {
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

export function collapsedPreviewLinesFromText(
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

    if (lineCount === 0) {
        return { isEmpty: true };
    }
    if (lineCount <= lineBudget) {
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

export function isPreviewMetaLine(line: string): boolean {
    return (
        line.startsWith("… +") ||
        /^… \d+ import\/setup lines omitted$/u.test(line) ||
        line === "… command preview truncated while streaming" ||
        line === "… preview truncated" ||
        line === "… script preview truncated" ||
        line === "… write preview truncated"
    );
}

export function highlightCodePreviewRuns(
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

export function detachString(text: string): string {
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

        const visible = [...rawLines];
        const suppressTruncatedJsonHighlighting =
            retained.kind === "collapsed" &&
            visible.some(isPreviewMetaLine) &&
            (syntax?.language?.toLowerCase() === "json" || /\.jsonc?$/iu.test(syntax?.path ?? ""));
        const displayLines =
            syntax === undefined || suppressTruncatedJsonHighlighting
                ? visible
                : retained.kind === "expanded"
                  ? [...trimEdgeBlankLines(highlightCodeOutput(retained.text, syntax))]
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
