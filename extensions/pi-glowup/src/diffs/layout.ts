import type { FileDiffMetadata } from "@pierre/diffs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cleanDiffLine } from "./highlight.ts";

export type NarrowDiffLayout = "paired" | "traditional";
export type SideBySideLayout = "content-aware" | "fixed";
export type DiffLineNumberStyle = "single" | "dual";

export type ReplacementLinePair = {
    readonly deletionIndex: number;
    readonly additionIndex: number;
};

const FIXED_SIDE_BY_SIDE_MIN_WIDTH = 140;
const CONTENT_AWARE_SIDE_BY_SIDE_MIN_WIDTH = 120;
const MIN_SIDE_BY_SIDE_CONTENT_WIDTH = 48;
const MAX_CHANGED_LINE_WRAPS = 2;
const MAX_LINE_PAIR_CELLS = 256;
const MAX_LINE_TOKENS = 128;
const MIN_LINE_PAIR_SIMILARITY = 0.55;
const MIN_LINE_PAIR_COVERAGE = 0.5;
const tokenPattern = /[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/** Chooses split rendering only when changed lines remain meaningfully comparable. */
export function shouldRenderSideBySide(
    width: number,
    metadata: FileDiffMetadata,
    layout: SideBySideLayout,
    lineNumberStyle: DiffLineNumberStyle = "single",
): boolean {
    if (layout === "fixed") {
        return width >= FIXED_SIDE_BY_SIDE_MIN_WIDTH;
    }
    if (width < CONTENT_AWARE_SIDE_BY_SIDE_MIN_WIDTH) {
        return false;
    }

    const lineNumberWidth = diffLineNumberWidth(metadata);
    const paneContentWidth =
        Math.floor((width - 3) / 2) -
        // One marker, the line-number field, and one separating space.
        (lineNumberWidth + 2);
    if (paneContentWidth < MIN_SIDE_BY_SIDE_CONTENT_WIDTH) {
        return false;
    }

    const unifiedGutterWidth =
        lineNumberStyle === "dual" ? lineNumberWidth * 2 + 4 : lineNumberWidth + 2;
    const unifiedContentWidth = Math.max(8, width - unifiedGutterWidth);
    let splitRows = 0;
    let unifiedRows = 0;
    let comparableRuns = 0;

    for (const hunk of metadata.hunks) {
        let deletionLineIndex = hunk.deletionLineIndex;
        let additionLineIndex = hunk.additionLineIndex;

        for (const content of hunk.hunkContent) {
            if (content.type === "context") {
                deletionLineIndex += content.lines;
                additionLineIndex += content.lines;
                continue;
            }

            const deletionWraps = Array.from({ length: content.deletions }, (_value, offset) =>
                wrappedLineCount(
                    metadata.deletionLines[deletionLineIndex + offset],
                    paneContentWidth,
                ),
            );
            const additionWraps = Array.from({ length: content.additions }, (_value, offset) =>
                wrappedLineCount(
                    metadata.additionLines[additionLineIndex + offset],
                    paneContentWidth,
                ),
            );

            if (content.deletions > 0 && content.additions > 0) {
                comparableRuns += 1;
            }
            if (
                deletionWraps.some((count) => count > MAX_CHANGED_LINE_WRAPS) ||
                additionWraps.some((count) => count > MAX_CHANGED_LINE_WRAPS)
            ) {
                return false;
            }

            const rowCount = Math.max(content.deletions, content.additions);
            for (let offset = 0; offset < rowCount; offset += 1) {
                splitRows += Math.max(deletionWraps[offset] ?? 1, additionWraps[offset] ?? 1);
            }
            for (let offset = 0; offset < content.deletions; offset += 1) {
                unifiedRows += wrappedLineCount(
                    metadata.deletionLines[deletionLineIndex + offset],
                    unifiedContentWidth,
                );
            }
            for (let offset = 0; offset < content.additions; offset += 1) {
                unifiedRows += wrappedLineCount(
                    metadata.additionLines[additionLineIndex + offset],
                    unifiedContentWidth,
                );
            }

            deletionLineIndex += content.deletions;
            additionLineIndex += content.additions;
        }
    }

    return comparableRuns > 0 && splitRows < unifiedRows;
}

/** Finds a bounded, monotonic set of confidently similar replacement lines. */
export function pairReplacementLines(
    deletions: readonly string[],
    additions: readonly string[],
): readonly ReplacementLinePair[] | undefined {
    if (
        deletions.length === 0 ||
        additions.length === 0 ||
        deletions.length * additions.length > MAX_LINE_PAIR_CELLS
    ) {
        return undefined;
    }

    const columnCount = additions.length + 1;
    const cellCount = (deletions.length + 1) * columnCount;
    const scores = new Float64Array(cellCount);
    const choices = new Uint8Array(cellCount);
    const cell = (deletionIndex: number, additionIndex: number): number =>
        deletionIndex * columnCount + additionIndex;

    for (let deletionIndex = deletions.length - 1; deletionIndex >= 0; deletionIndex -= 1) {
        for (let additionIndex = additions.length - 1; additionIndex >= 0; additionIndex -= 1) {
            const current = cell(deletionIndex, additionIndex);
            const skipDeletion = scores[cell(deletionIndex + 1, additionIndex)] ?? 0;
            const skipAddition = scores[cell(deletionIndex, additionIndex + 1)] ?? 0;
            const similarity = lineSimilarity(
                deletions[deletionIndex] ?? "",
                additions[additionIndex] ?? "",
            );
            const match =
                similarity >= MIN_LINE_PAIR_SIMILARITY
                    ? similarity + (scores[cell(deletionIndex + 1, additionIndex + 1)] ?? 0)
                    : Number.NEGATIVE_INFINITY;

            if (match >= skipDeletion && match >= skipAddition) {
                scores[current] = match;
                choices[current] = 1;
            } else if (skipDeletion >= skipAddition) {
                scores[current] = skipDeletion;
                choices[current] = 2;
            } else {
                scores[current] = skipAddition;
                choices[current] = 3;
            }
        }
    }

    const pairs: ReplacementLinePair[] = [];
    let deletionIndex = 0;
    let additionIndex = 0;
    while (deletionIndex < deletions.length && additionIndex < additions.length) {
        const choice = choices[cell(deletionIndex, additionIndex)];
        if (choice === 1) {
            pairs.push({ deletionIndex, additionIndex });
            deletionIndex += 1;
            additionIndex += 1;
        } else if (choice === 2) {
            deletionIndex += 1;
        } else {
            additionIndex += 1;
        }
    }

    const coverage = (pairs.length * 2) / (deletions.length + additions.length);
    return coverage >= MIN_LINE_PAIR_COVERAGE ? pairs : undefined;
}

function wrappedLineCount(line: string | undefined, contentWidth: number): number {
    const width = visibleWidth(cleanDiffLine(line));
    return Math.max(1, Math.ceil(width / Math.max(1, contentWidth)));
}

export function diffLineNumberWidth(metadata: FileDiffMetadata): number {
    let maxLineNumber = 1;
    for (const hunk of metadata.hunks) {
        maxLineNumber = Math.max(
            maxLineNumber,
            hunk.deletionStart + Math.max(0, hunk.deletionCount - 1),
            hunk.additionStart + Math.max(0, hunk.additionCount - 1),
        );
    }
    return String(maxLineNumber).length;
}

function lineSimilarity(before: string, after: string): number {
    const beforeTokens = tokenizeLine(before);
    const afterTokens = tokenizeLine(after);
    if (
        beforeTokens.length === 0 ||
        afterTokens.length === 0 ||
        beforeTokens.length > MAX_LINE_TOKENS ||
        afterTokens.length > MAX_LINE_TOKENS
    ) {
        return 0;
    }

    const columnCount = afterTokens.length + 1;
    const lengths = new Uint16Array((beforeTokens.length + 1) * columnCount);
    const cell = (beforeIndex: number, afterIndex: number): number =>
        beforeIndex * columnCount + afterIndex;

    for (let beforeIndex = beforeTokens.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
        for (let afterIndex = afterTokens.length - 1; afterIndex >= 0; afterIndex -= 1) {
            lengths[cell(beforeIndex, afterIndex)] =
                beforeTokens[beforeIndex] === afterTokens[afterIndex]
                    ? 1 + (lengths[cell(beforeIndex + 1, afterIndex + 1)] ?? 0)
                    : Math.max(
                          lengths[cell(beforeIndex + 1, afterIndex)] ?? 0,
                          lengths[cell(beforeIndex, afterIndex + 1)] ?? 0,
                      );
        }
    }

    const matched = lengths[0] ?? 0;
    return (2 * matched) / (beforeTokens.length + afterTokens.length);
}

function tokenizeLine(line: string): readonly string[] {
    tokenPattern.lastIndex = 0;
    return Array.from(line.trim().matchAll(tokenPattern), (match) => match[0]);
}
