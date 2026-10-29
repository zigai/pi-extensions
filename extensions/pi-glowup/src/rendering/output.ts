import { stripVTControlCharacters } from "node:util";
import { hasNonWhitespaceText, truncateUtf8ByGrapheme } from "../text-boundaries.ts";
import { type GlowupRenderTheme, muted, dim } from "./theme.ts";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
    type CodeOutputSyntax,
    highlightCodeOutput,
    cachedCodeOutput,
    scheduleCodeOutputSyntaxLoad,
} from "./syntax/code-component.ts";
import { syntaxLanguageFromFile } from "./syntax/language.ts";
import { observeSyntaxHighlightSource } from "./syntax/highlighter.ts";
import {
    toolExpandHint,
    emptyComponent,
    makeComponent,
    wrapPrefixedLine,
    omittedLinesLabel,
} from "./component.ts";

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
          readonly sourceIndices: ReadonlyArray<number | undefined>;
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
        return { isEmpty: false, lines: [], sourceIndices: [] };
    }

    const normalized = normalizeOutputText(text);
    const lineBudget = Math.max(
        1,
        Math.min(Math.floor(maxPreviewLines), MAX_COLLAPSED_OUTPUT_PREVIEW_LINES),
    );
    const retainedLineBudget = Math.min(lineBudget + 1, MAX_COLLAPSED_OUTPUT_PREVIEW_LINES);
    const lineByteBudget = Math.max(
        MIN_COLLAPSED_OUTPUT_LINE_BYTES,
        Math.min(
            MAX_COLLAPSED_OUTPUT_LINE_BYTES,
            Math.floor(MAX_COLLAPSED_OUTPUT_PREVIEW_BYTES / retainedLineBudget),
        ),
    );
    const headCount = mode === "headTail" ? Math.ceil(lineBudget / 2) : lineBudget;
    const tailCount = mode === "headTail" ? Math.floor(lineBudget / 2) : 0;
    const headLines: Array<{ line: string; index: number }> = [];
    const tailLines: Array<{ line: string; index: number }> = [];
    let allLines: Array<{ line: string; index: number }> | undefined = [];
    let pendingBlankLineCount = 0;
    let pendingBlankStart = 0;
    let pendingBlankLineSamples: string[] = [];
    let lineCount = 0;
    let sawContent = false;

    const consumeLine = (line: string, index: number): void => {
        const previewLine = { line: detachedPreviewLine(line, lineByteBudget), index };
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

            if (allLines.length > retainedLineBudget) {
                allLines = undefined;
            }
        }
    };

    const flushPendingBlankLines = (): void => {
        for (let index = 0; index < pendingBlankLineCount; index += 1) {
            consumeLine(pendingBlankLineSamples[index] ?? "", pendingBlankStart + index);
        }

        pendingBlankLineCount = 0;
        pendingBlankLineSamples = [];
    };

    visitPhysicalLines(normalized, (line, index) => {
        if (!hasNonWhitespaceText(line)) {
            if (sawContent) {
                if (pendingBlankLineCount === 0) pendingBlankStart = index;
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

        consumeLine(line, index);
    });

    if (lineCount === 0) {
        return { isEmpty: true };
    }

    if (lineCount <= retainedLineBudget) {
        return {
            isEmpty: false,
            lines: allLines.map(({ line }) => line),
            sourceIndices: allLines.map(({ index }) => index),
        };
    }

    if (mode === "head") {
        return {
            isEmpty: false,
            lines: [
                ...headLines.map(({ line }) => line),
                `${omittedLinesLabel(lineCount - headLines.length)} (${omittedHint})`,
            ],
            sourceIndices: [...headLines.map(({ index }) => index), undefined],
        };
    }

    return {
        isEmpty: false,
        lines: [
            ...headLines.map(({ line }) => line),
            `${omittedLinesLabel(lineCount - headLines.length - tailLines.length)} (${omittedHint})`,
            ...tailLines.map(({ line }) => line),
        ],
        sourceIndices: [
            ...headLines.map(({ index }) => index),
            undefined,
            ...tailLines.map(({ index }) => index),
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

type RetainedOutputDiagnostic = {
    readonly expanded: boolean;
    readonly mode: "headTail" | "head" | "hidden";
    readonly inputBytes: number;
    readonly retainedBytes: number;
};

let retainedOutputReporter: ((diagnostic: RetainedOutputDiagnostic) => void) | undefined;

export function configureRetainedOutputDiagnostics(
    report: ((diagnostic: RetainedOutputDiagnostic) => void) | undefined,
): void {
    retainedOutputReporter = report;
}

export function isRetainedOutputLoggingEnabled(): boolean {
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
    if (!isRetainedOutputLoggingEnabled()) return;

    retainedOutputReporter?.({
        expanded: retained.kind === "expanded",
        mode,
        inputBytes: Buffer.byteLength(input ?? "", "utf8"),
        retainedBytes: retainedOutputBytes(retained),
    });
}

function visitPhysicalLines(text: string, visit: (line: string, index: number) => void): void {
    let lineStart = 0;
    let lineIndex = 0;
    for (let index = 0; index <= text.length; index += 1) {
        if (index < text.length) {
            const charCode = text.charCodeAt(index);
            if (charCode !== 10 && charCode !== 13) {
                continue;
            }
        }

        visit(text.slice(lineStart, index), lineIndex++);

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
    if (metaIndex === -1 && rendered.length <= options.rowBudget + 1) {
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
    readonly maxExpandedLines?: number;
    readonly prefixFirst?: string;
    readonly prefixRest?: string;
    readonly dimContent?: boolean;
    readonly noOutputLabel?: string | null;
    readonly omittedHint?: string;
    readonly syntax?: CodeOutputSyntax;
    readonly syntaxSource?: string;
    readonly invalidate?: (() => void) | undefined;
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
    let syntax = options.syntax;
    if (syntax !== undefined && syntax.invalidate === undefined) {
        syntax = { ...syntax, invalidate: options.invalidate };
    }

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

    let scheduleFull: (() => void) | undefined;
    let fullCode: string | undefined;
    let currentSource: (() => boolean) | undefined;
    if (syntax?.invalidate !== undefined) {
        const source = text ?? "";
        fullCode = source;
        if (source.includes("\r")) fullCode = normalizeOutputText(source);

        const current = observeSyntaxHighlightSource(
            options.syntaxSource ?? source,
            syntax.invalidate,
        );
        currentSource = current;

        const ownedSyntax = syntax;
        const invalidate = syntax.invalidate;
        const content = fullCode;

        scheduleFull = () =>
            scheduleCodeOutputSyntaxLoad(ownedSyntax, invalidate, content, current);
    }

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
        let sourceCurrent = true;
        if (currentSource !== undefined) sourceCurrent = currentSource();

        if (syntax !== undefined && !suppressTruncatedJsonHighlighting && sourceCurrent) {
            const language = syntax.language ?? syntaxLanguageFromFile(syntax.path, rawLines[0]);
            let loadSyntax = syntax;
            if (language !== undefined) loadSyntax = { ...syntax, language };

            scheduleCodeOutputSyntaxLoad(loadSyntax, syntax.invalidate);
        }

        let displayLines: ReadonlyArray<string> = visible;

        if (syntax !== undefined && sourceCurrent) {
            if (retained.kind === "expanded") {
                displayLines = trimEdgeBlankLines(highlightCodeOutput(retained.text, syntax));
            } else if (!retained.preview.isEmpty) {
                let complete: ReadonlyArray<string> | undefined;
                if (fullCode !== undefined) {
                    const cached = cachedCodeOutput(fullCode, syntax);
                    if (cached !== undefined)
                        complete = highlightFullPreview(
                            retained.preview,
                            cached,
                            syntax,
                            !suppressTruncatedJsonHighlighting,
                        );
                }

                if (complete !== undefined) displayLines = complete;
                else if (!suppressTruncatedJsonHighlighting)
                    displayLines = highlightPreviewLines(visible, syntax);
            }
        }

        scheduleFull?.();

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
            const rows = flattenWrappedRows(wrappedLines);
            const limit = options.maxExpandedLines;
            if (limit === undefined || rows.length <= limit + 1) return rows;

            return [
                ...rows.slice(0, limit),
                truncateToWidth(
                    `${prefixRest}${muted(theme, omittedLinesLabel(rows.length - limit))}`,
                    width,
                    "",
                ),
            ];
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

function highlightFullPreview(
    preview: Extract<CollapsedTextPreview, { isEmpty: false }>,
    full: ReadonlyArray<string>,
    syntax: CodeOutputSyntax,
    highlightUnmatched: boolean,
): string[] {
    const lines: string[] = [];
    const unmatched: number[] = [];
    for (const [index, plain] of preview.lines.entries()) {
        if (isPreviewMetaLine(plain)) {
            lines.push(plain);
            continue;
        }

        const sourceIndex = preview.sourceIndices[index];
        let colored: string | undefined;
        if (sourceIndex !== undefined) colored = full[sourceIndex];

        if (colored === undefined || stripVTControlCharacters(colored) !== plain) {
            unmatched.push(index);
            lines.push(plain);
        } else lines.push(colored);
    }

    if (unmatched.length === 0 || !highlightUnmatched) return lines;

    const fallback = highlightPreviewLines(preview.lines, syntax);
    for (const index of unmatched) lines[index] = fallback[index] ?? lines[index] ?? "";

    return lines;
}

function highlightPreviewLines(
    lines: ReadonlyArray<string>,
    syntax: CodeOutputSyntax,
): ReadonlyArray<string> {
    return highlightCodePreviewRuns(lines, (code) => highlightCodeOutput(code, syntax));
}
