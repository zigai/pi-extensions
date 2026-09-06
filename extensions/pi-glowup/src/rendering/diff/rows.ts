import type { FileDiffMetadata } from "@pierre/diffs";
import { cleanDiffLine, flattenHighlightedLine } from "./highlight.ts";
import { pairReplacementLines, type NarrowDiffLayout } from "./layout.ts";
import { replacementFocusColumns } from "./intraline.ts";
import type { HighlightedDiffCode, SplitDiffCell, SplitDiffRow, UnifiedDiffRow } from "./types.ts";
import type { PierreTerminalPalette } from "./theme.ts";

type DiffRowBuildOptions = {
    readonly maxRows?: number;
    readonly narrowLayout?: NarrowDiffLayout;
    readonly includedRowIndices?: ReadonlySet<number>;
    readonly onRowBuilt?: () => void;
};

type UnifiedLineRow = Extract<UnifiedDiffRow, { readonly kind: "line" }>;

/** Builds unified Pierre rows from metadata and optional highlighted line trees. */
export function buildUnifiedDiffRows(
    metadata: FileDiffMetadata,
    highlighted: HighlightedDiffCode,
    palette: PierreTerminalPalette,
    options: DiffRowBuildOptions = {},
): ReadonlyArray<UnifiedDiffRow> {
    const rows: UnifiedDiffRow[] = [];
    let sourceRowIndex = 0;
    const lastIncludedRow = maximumSetValue(options.includedRowIndices);
    const pushRow = (row: UnifiedDiffRow): boolean => {
        const currentIndex = sourceRowIndex;
        sourceRowIndex += 1;
        let budgetReached = false;
        if (
            options.includedRowIndices === undefined ||
            options.includedRowIndices.has(currentIndex)
        ) {
            options.onRowBuilt?.();
            budgetReached = pushBudgetedRow(rows, row, options.maxRows);
        }
        return budgetReached || (lastIncludedRow !== undefined && currentIndex >= lastIncludedRow);
    };
    const pushLazyRow = (createRow: () => UnifiedDiffRow): boolean => {
        const currentIndex = sourceRowIndex;
        sourceRowIndex += 1;
        let budgetReached = false;
        if (
            options.includedRowIndices === undefined ||
            options.includedRowIndices.has(currentIndex)
        ) {
            options.onRowBuilt?.();
            budgetReached = pushBudgetedRow(rows, createRow(), options.maxRows);
        }
        return budgetReached || (lastIncludedRow !== undefined && currentIndex >= lastIncludedRow);
    };

    for (const hunk of metadata.hunks) {
        if (hunk.collapsedBefore > 0) {
            if (
                pushRow({
                    kind: "collapsed",
                    text: "...",
                    fg: palette.metadataFg,
                    bg: palette.metadataBg,
                })
            ) {
                return trimEdgeCollapsedRows(rows);
            }
        }

        let deletionLineIndex = hunk.deletionLineIndex;
        let additionLineIndex = hunk.additionLineIndex;
        let deletionLineNumber = hunk.deletionStart;
        let additionLineNumber = hunk.additionStart;

        for (const content of hunk.hunkContent) {
            if (content.type === "context") {
                for (let offset = 0; offset < content.lines; offset += 1) {
                    if (
                        pushLazyRow(() =>
                            makeUnifiedLine({
                                lineType: "context",
                                oldLineNumber: deletionLineNumber + offset,
                                newLineNumber: additionLineNumber + offset,
                                spans: flattenHighlightedLine(
                                    highlighted.additionLines[additionLineIndex + offset],
                                    palette.appearance,
                                    palette.contextRowBg,
                                    () =>
                                        cleanDiffLine(
                                            metadata.additionLines[additionLineIndex + offset],
                                        ),
                                    metadata.lang,
                                ),
                                palette,
                            }),
                        )
                    ) {
                        return trimEdgeCollapsedRows(rows);
                    }
                }
                deletionLineIndex += content.lines;
                additionLineIndex += content.lines;
                deletionLineNumber += content.lines;
                additionLineNumber += content.lines;
                continue;
            }

            const makeDeletionRow = (offset: number): UnifiedLineRow =>
                makeUnifiedLine({
                    lineType: "deletion",
                    oldLineNumber: deletionLineNumber + offset,
                    spans: flattenHighlightedLine(
                        highlighted.deletionLines[deletionLineIndex + offset],
                        palette.appearance,
                        palette.deletionSpanBg,
                        () => cleanDiffLine(metadata.deletionLines[deletionLineIndex + offset]),
                        metadata.lang,
                        {
                            boldEmphasized: palette.deletionRowBg.length === 0,
                            dimUnchanged: palette.dimUnchangedText,
                        },
                    ),
                    palette,
                });
            const makeAdditionRow = (offset: number): UnifiedLineRow =>
                makeUnifiedLine({
                    lineType: "addition",
                    newLineNumber: additionLineNumber + offset,
                    spans: flattenHighlightedLine(
                        highlighted.additionLines[additionLineIndex + offset],
                        palette.appearance,
                        palette.additionSpanBg,
                        () => cleanDiffLine(metadata.additionLines[additionLineIndex + offset]),
                        metadata.lang,
                        {
                            boldEmphasized: palette.additionRowBg.length === 0,
                            dimUnchanged: palette.dimUnchangedText,
                        },
                    ),
                    palette,
                });
            const narrowLayout = options.narrowLayout ?? "traditional";
            if (
                narrowLayout === "traditional" ||
                content.deletions === 0 ||
                content.additions === 0 ||
                content.deletions * content.additions > 256
            ) {
                for (let offset = 0; offset < content.deletions; offset += 1) {
                    if (pushLazyRow(() => makeDeletionRow(offset))) {
                        return trimEdgeCollapsedRows(rows);
                    }
                }
                for (let offset = 0; offset < content.additions; offset += 1) {
                    if (pushLazyRow(() => makeAdditionRow(offset))) {
                        return trimEdgeCollapsedRows(rows);
                    }
                }

                deletionLineIndex += content.deletions;
                additionLineIndex += content.additions;
                deletionLineNumber += content.deletions;
                additionLineNumber += content.additions;
                continue;
            }

            const deletionRows = Array.from({ length: content.deletions }, (_value, offset) =>
                makeDeletionRow(offset),
            );
            const additionRows = Array.from({ length: content.additions }, (_value, offset) =>
                makeAdditionRow(offset),
            );
            const replacementRows = orderUnifiedReplacementRows(
                deletionRows,
                additionRows,
                narrowLayout,
            );
            for (const row of replacementRows) {
                if (pushRow(row)) {
                    return trimEdgeCollapsedRows(rows);
                }
            }

            deletionLineIndex += content.deletions;
            additionLineIndex += content.additions;
            deletionLineNumber += content.deletions;
            additionLineNumber += content.additions;
        }

        if (hunk.noEOFCRDeletions || hunk.noEOFCRAdditions) {
            if (
                pushRow({
                    kind: "metadata",
                    text: "\\ No newline at end of file",
                    fg: palette.metadataFg,
                    bg: palette.metadataBg,
                })
            ) {
                return trimEdgeCollapsedRows(rows);
            }
        }
    }

    if (hasTrailingCollapsedLines(metadata)) {
        pushRow({
            kind: "collapsed",
            text: "...",
            fg: palette.metadataFg,
            bg: palette.metadataBg,
        });
    }

    return trimEdgeCollapsedRows(rows);
}

/** Builds side-by-side Pierre rows from metadata and optional highlighted line trees. */
export function buildSplitDiffRows(
    metadata: FileDiffMetadata,
    highlighted: HighlightedDiffCode,
    palette: PierreTerminalPalette,
    options: DiffRowBuildOptions = {},
): ReadonlyArray<SplitDiffRow> {
    const rows: SplitDiffRow[] = [];
    let sourceRowIndex = 0;
    const lastIncludedRow = maximumSetValue(options.includedRowIndices);
    const pushRow = (row: SplitDiffRow): boolean => {
        const currentIndex = sourceRowIndex;
        sourceRowIndex += 1;
        let budgetReached = false;
        if (
            options.includedRowIndices === undefined ||
            options.includedRowIndices.has(currentIndex)
        ) {
            options.onRowBuilt?.();
            budgetReached = pushBudgetedRow(rows, row, options.maxRows);
        }
        return budgetReached || (lastIncludedRow !== undefined && currentIndex >= lastIncludedRow);
    };
    const pushLazyRow = (createRow: () => SplitDiffRow): boolean => {
        const currentIndex = sourceRowIndex;
        sourceRowIndex += 1;
        let budgetReached = false;
        if (
            options.includedRowIndices === undefined ||
            options.includedRowIndices.has(currentIndex)
        ) {
            options.onRowBuilt?.();
            budgetReached = pushBudgetedRow(rows, createRow(), options.maxRows);
        }
        return budgetReached || (lastIncludedRow !== undefined && currentIndex >= lastIncludedRow);
    };

    for (const hunk of metadata.hunks) {
        if (hunk.collapsedBefore > 0) {
            if (
                pushRow({
                    kind: "collapsed",
                    text: "...",
                    fg: palette.metadataFg,
                    bg: palette.metadataBg,
                })
            ) {
                return trimEdgeCollapsedRows(rows);
            }
        }

        let deletionLineIndex = hunk.deletionLineIndex;
        let additionLineIndex = hunk.additionLineIndex;
        let deletionLineNumber = hunk.deletionStart;
        let additionLineNumber = hunk.additionStart;

        for (const content of hunk.hunkContent) {
            if (content.type === "context") {
                for (let offset = 0; offset < content.lines; offset += 1) {
                    if (
                        pushLazyRow(() => {
                            const spans = flattenHighlightedLine(
                                highlighted.additionLines[additionLineIndex + offset],
                                palette.appearance,
                                palette.contextRowBg,
                                () =>
                                    cleanDiffLine(
                                        metadata.additionLines[additionLineIndex + offset],
                                    ),
                                metadata.lang,
                            );
                            return {
                                kind: "line",
                                deletion: makeSplitCell({
                                    lineType: "context",
                                    lineNumber: deletionLineNumber + offset,
                                    spans,
                                    palette,
                                }),
                                addition: makeSplitCell({
                                    lineType: "context",
                                    lineNumber: additionLineNumber + offset,
                                    spans,
                                    palette,
                                }),
                            };
                        })
                    ) {
                        return trimEdgeCollapsedRows(rows);
                    }
                }
                deletionLineIndex += content.lines;
                additionLineIndex += content.lines;
                deletionLineNumber += content.lines;
                additionLineNumber += content.lines;
                continue;
            }

            const rowCount = Math.max(content.deletions, content.additions);
            for (let offset = 0; offset < rowCount; offset += 1) {
                if (
                    pushLazyRow(() => ({
                        kind: "line",
                        deletion:
                            offset < content.deletions
                                ? makeSplitCell({
                                      lineType: "deletion",
                                      lineNumber: deletionLineNumber + offset,
                                      spans: flattenHighlightedLine(
                                          highlighted.deletionLines[deletionLineIndex + offset],
                                          palette.appearance,
                                          palette.deletionSpanBg,
                                          () =>
                                              cleanDiffLine(
                                                  metadata.deletionLines[
                                                      deletionLineIndex + offset
                                                  ],
                                              ),
                                          metadata.lang,
                                          {
                                              boldEmphasized: palette.deletionRowBg.length === 0,
                                              dimUnchanged: palette.dimUnchangedText,
                                          },
                                      ),
                                      palette,
                                  })
                                : makeEmptySplitCell(palette),
                        addition:
                            offset < content.additions
                                ? makeSplitCell({
                                      lineType: "addition",
                                      lineNumber: additionLineNumber + offset,
                                      spans: flattenHighlightedLine(
                                          highlighted.additionLines[additionLineIndex + offset],
                                          palette.appearance,
                                          palette.additionSpanBg,
                                          () =>
                                              cleanDiffLine(
                                                  metadata.additionLines[
                                                      additionLineIndex + offset
                                                  ],
                                              ),
                                          metadata.lang,
                                          {
                                              boldEmphasized: palette.additionRowBg.length === 0,
                                              dimUnchanged: palette.dimUnchangedText,
                                          },
                                      ),
                                      palette,
                                  })
                                : makeEmptySplitCell(palette),
                    }))
                ) {
                    return trimEdgeCollapsedRows(rows);
                }
            }

            deletionLineIndex += content.deletions;
            additionLineIndex += content.additions;
            deletionLineNumber += content.deletions;
            additionLineNumber += content.additions;
        }

        if (hunk.noEOFCRDeletions || hunk.noEOFCRAdditions) {
            if (
                pushRow({
                    kind: "metadata",
                    text: "\\ No newline at end of file",
                    fg: palette.metadataFg,
                    bg: palette.metadataBg,
                })
            ) {
                return trimEdgeCollapsedRows(rows);
            }
        }
    }

    if (hasTrailingCollapsedLines(metadata)) {
        pushRow({
            kind: "collapsed",
            text: "...",
            fg: palette.metadataFg,
            bg: palette.metadataBg,
        });
    }

    return trimEdgeCollapsedRows(rows);
}

function orderUnifiedReplacementRows(
    deletions: readonly UnifiedLineRow[],
    additions: readonly UnifiedLineRow[],
    layout: NarrowDiffLayout,
): readonly UnifiedLineRow[] {
    if (layout === "traditional") {
        return [...deletions, ...additions];
    }

    const pairs = pairReplacementLines(
        deletions.map(unifiedRowText),
        additions.map(unifiedRowText),
    );
    if (pairs === undefined) {
        const deletion = deletions[0];
        const addition = additions[0];
        if (
            deletions.length === 1 &&
            additions.length === 1 &&
            deletion !== undefined &&
            addition !== undefined
        ) {
            return focusedReplacementRows(deletion, addition);
        }
        return [...deletions, ...additions];
    }

    const rows: UnifiedLineRow[] = [];
    let deletionIndex = 0;
    let additionIndex = 0;
    for (const pair of pairs) {
        rows.push(...deletions.slice(deletionIndex, pair.deletionIndex));
        rows.push(...additions.slice(additionIndex, pair.additionIndex));
        const deletion = deletions[pair.deletionIndex];
        const addition = additions[pair.additionIndex];
        if (deletion !== undefined && addition !== undefined) {
            rows.push(...focusedReplacementRows(deletion, addition));
        } else {
            if (deletion !== undefined) rows.push(deletion);
            if (addition !== undefined) rows.push(addition);
        }
        deletionIndex = pair.deletionIndex + 1;
        additionIndex = pair.additionIndex + 1;
    }
    rows.push(...deletions.slice(deletionIndex));
    rows.push(...additions.slice(additionIndex));
    return rows;
}

function focusedReplacementRows(
    deletion: UnifiedLineRow,
    addition: UnifiedLineRow,
): readonly [UnifiedLineRow, UnifiedLineRow] {
    const focus = replacementFocusColumns(unifiedRowText(deletion), unifiedRowText(addition));
    return [
        focus.before === undefined ? deletion : { ...deletion, focusColumn: focus.before },
        focus.after === undefined ? addition : { ...addition, focusColumn: focus.after },
    ];
}

function unifiedRowText(row: UnifiedLineRow): string {
    return row.spans.map((span) => span.text).join("");
}

function pushBudgetedRow<TRow>(rows: TRow[], row: TRow, maxRows: number | undefined): boolean {
    if (maxRows !== undefined && rows.length >= Math.max(1, Math.floor(maxRows))) {
        return true;
    }
    rows.push(row);
    return maxRows !== undefined && rows.length >= Math.max(1, Math.floor(maxRows));
}

function maximumSetValue(values: ReadonlySet<number> | undefined): number | undefined {
    let maximum: number | undefined;
    if (values === undefined) return maximum;
    for (const value of values) {
        maximum = maximum === undefined ? value : Math.max(maximum, value);
    }
    return maximum;
}

function trimEdgeCollapsedRows<TRow extends { readonly kind: string }>(
    rows: ReadonlyArray<TRow>,
): ReadonlyArray<TRow> {
    let start = 0;
    let end = rows.length;
    while (rows[start]?.kind === "collapsed") {
        start += 1;
    }
    while (end > start && rows[end - 1]?.kind === "collapsed") {
        end -= 1;
    }
    return rows.slice(start, end);
}

function makeUnifiedLine(options: {
    readonly lineType: "context" | "addition" | "deletion";
    readonly oldLineNumber?: number;
    readonly newLineNumber?: number;
    readonly spans: ReadonlyArray<{
        readonly text: string;
        readonly fg?: string;
        readonly bg?: string;
    }>;
    readonly palette: PierreTerminalPalette;
}): UnifiedLineRow {
    const colors = colorsForLineType(options.lineType, options.palette);
    const lineType = { kind: "line" as const, lineType: options.lineType };
    const withOldLineNumber =
        options.oldLineNumber === undefined
            ? lineType
            : { ...lineType, oldLineNumber: options.oldLineNumber };
    const withNewLineNumber =
        options.newLineNumber === undefined
            ? withOldLineNumber
            : { ...withOldLineNumber, newLineNumber: options.newLineNumber };
    return {
        ...withNewLineNumber,
        spans: options.spans,
        rowFg: colors.fg,
        rowBg: colors.bg,
        lineNumberFg: options.palette.lineNumberFg,
    };
}

function makeSplitCell(options: {
    readonly lineType: "context" | "addition" | "deletion";
    readonly lineNumber: number;
    readonly spans: ReadonlyArray<{
        readonly text: string;
        readonly fg?: string;
        readonly bg?: string;
    }>;
    readonly palette: PierreTerminalPalette;
}): SplitDiffCell {
    const colors = colorsForLineType(options.lineType, options.palette);
    return {
        lineType: options.lineType,
        lineNumber: options.lineNumber,
        spans: options.spans,
        rowFg: colors.fg,
        rowBg: colors.bg,
        lineNumberFg: options.palette.lineNumberFg,
    };
}

function makeEmptySplitCell(palette: PierreTerminalPalette): SplitDiffCell {
    return {
        lineType: "empty",
        spans: [],
        rowFg: palette.emptyFg,
        rowBg: palette.emptyRowBg,
        lineNumberFg: palette.lineNumberFg,
    };
}

type DiffLineColors = {
    readonly fg: string;
    readonly bg: string;
};

function colorsForLineType(
    lineType: "context" | "addition" | "deletion",
    palette: PierreTerminalPalette,
): DiffLineColors {
    if (lineType === "addition") {
        return { fg: palette.additionFg, bg: palette.additionRowBg };
    }
    if (lineType === "deletion") {
        return { fg: palette.deletionFg, bg: palette.deletionRowBg };
    }
    return { fg: palette.contextFg, bg: palette.contextRowBg };
}

export function hasTrailingCollapsedLines(metadata: FileDiffMetadata): boolean {
    const lastHunk = metadata.hunks.at(-1);
    if (!lastHunk || metadata.isPartial) {
        return false;
    }

    const additionRemaining =
        metadata.additionLines.length - (lastHunk.additionLineIndex + lastHunk.additionCount);
    const deletionRemaining =
        metadata.deletionLines.length - (lastHunk.deletionLineIndex + lastHunk.deletionCount);

    return additionRemaining === deletionRemaining && Math.max(additionRemaining, 0) > 0;
}
