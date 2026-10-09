import {
    collectHighlightRanges,
    highlightMessageLine,
    highlightMessageLineRanges,
    plainTextFromAnsi,
    type HighlightRange,
    type HighlightStyles,
} from "./highlight-text.ts";

type AutocompleteListLike = {
    render(width: number): string[];
};

export type EditorHighlightTarget = {
    getText(): string;
    getPaddingX?: () => number;
    paddingX?: number;
    autocompleteState?: unknown;
    autocompleteList?: AutocompleteListLike;
};

function isFiniteNumber(value: number): boolean {
    return Number.isFinite(value);
}

function getEditorPaddingX(target: EditorHighlightTarget, width: number): number {
    const rawPadding = target.getPaddingX?.() ?? target.paddingX ?? 0;
    let padding = 0;
    if (isFiniteNumber(rawPadding)) {
        padding = Math.max(0, Math.floor(rawPadding));
    }

    const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
    return Math.min(padding, maxPadding);
}

function getAutocompleteLineCount(target: EditorHighlightTarget, contentWidth: number): number {
    const autocompleteList = target.autocompleteList;
    if (target.autocompleteState === null || autocompleteList === undefined) return 0;

    return autocompleteList.render(contentWidth).length;
}

type TrimmedContentText = {
    readonly lineTextStart: number;
    readonly text: string;
};

function getTrimmedContentText(plainLine: string, paddingX: number): TrimmedContentText {
    const lineTextStart = Math.min(paddingX, plainLine.length);
    const lineTextEnd = Math.max(lineTextStart, plainLine.length - paddingX);
    return {
        lineTextStart,
        text: plainLine.slice(lineTextStart, lineTextEnd).trimEnd(),
    };
}

function toRenderedLineRanges(
    ranges: readonly HighlightRange[],
    logicalStart: number,
    logicalEnd: number,
    lineTextStart: number,
): HighlightRange[] {
    const lineRanges: HighlightRange[] = [];

    for (const range of ranges) {
        if (range.end <= logicalStart) continue;
        if (range.start >= logicalEnd) break;

        lineRanges.push({
            start: lineTextStart + Math.max(range.start, logicalStart) - logicalStart,
            end: lineTextStart + Math.min(range.end, logicalEnd) - logicalStart,
            style: range.style,
        });
    }

    return lineRanges;
}

type HighlightedContentLine = {
    readonly line: string;
    readonly searchStart: number;
};

function highlightEditorContentLine(
    line: string,
    logicalText: string,
    ranges: readonly HighlightRange[],
    searchStart: number,
    paddingX: number,
    styles: HighlightStyles,
): HighlightedContentLine {
    const plainLine = plainTextFromAnsi(line);
    const content = getTrimmedContentText(plainLine, paddingX);
    if (content.text.length === 0) {
        return { line, searchStart };
    }

    const logicalStart = logicalText.indexOf(content.text, searchStart);
    if (logicalStart < 0) {
        return { line: highlightMessageLine(line, styles), searchStart };
    }

    const logicalEnd = logicalStart + content.text.length;
    const lineRanges = toRenderedLineRanges(
        ranges,
        logicalStart,
        logicalEnd,
        content.lineTextStart,
    );
    return {
        line: highlightMessageLineRanges(line, lineRanges),
        searchStart: logicalEnd,
    };
}

export function highlightEditorRenderLines(
    target: EditorHighlightTarget,
    width: number,
    lines: readonly string[],
    styles: HighlightStyles,
): string[] {
    const logicalText = target.getText();
    const ranges = collectHighlightRanges(logicalText, styles);
    const result = lines.map((line) => highlightMessageLine(line, styles));
    if (ranges.length === 0 || lines.length <= 2) return result;

    const paddingX = getEditorPaddingX(target, width);
    const contentWidth = Math.max(1, width - paddingX * 2);
    const autocompleteLineCount = getAutocompleteLineCount(target, contentWidth);
    const contentStart = 1;
    const contentEnd = Math.max(contentStart, lines.length - 1 - autocompleteLineCount);
    let searchStart = 0;

    for (let index = contentStart; index < contentEnd; index += 1) {
        const highlighted = highlightEditorContentLine(
            lines[index] ?? "",
            logicalText,
            ranges,
            searchStart,
            paddingX,
            styles,
        );
        result[index] = highlighted.line;
        searchStart = highlighted.searchStart;
    }

    return result;
}
