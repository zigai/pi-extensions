import ansiStyles from "ansi-styles";
import {
    normalizedDiffLineNumber,
    type DiffLineCoordinates,
    parseDiffLine,
    type DiffSection,
} from "./text-diff.ts";
import {
    configuredDiffLineNumberStyle,
    type GlowupRenderTheme,
    muted,
    dim,
    configuredDiffBackgroundStyle,
    configuredDiffContentBackgroundAnsi,
    configuredDiffBackgroundAnsi,
    green,
    red,
    pathText,
} from "../theme.ts";
import { type TextRange, changedTextRanges, applyBackgroundToTextRanges } from "./intraline.ts";
import { wrapStyledText, makeComponent, toolExpandHint, wrapPrefixedLine } from "../component.ts";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expandTerminalTabs } from "../../text-boundaries.ts";
import { strongerDiffBackgroundAnsi } from "./ansi-colors.ts";
import { highlightCodeOutput } from "../syntax/code-component.ts";
import {
    selectSemanticDiffIndices,
    type SemanticDiffRowKind,
    MUTATION_DIFF_PREVIEW_ROWS,
} from "./preview-selection.ts";
import { formatMutationStats } from "../tool-header.ts";
import { collapseHome } from "../path.ts";

const ANSI_SEQUENCE_PREFIX = ansiStyles.modifier.reset.open.slice(0, 2);
const ROW_BACKGROUND_SAFE_RESET = `${ansiStyles.modifier.bold.close}${ansiStyles.modifier.italic.close}${ansiStyles.modifier.underline.close}${ansiStyles.modifier.strikethrough.close}${ansiStyles.color.close}`;

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
        return theme.fg("toolOutput", content);
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
