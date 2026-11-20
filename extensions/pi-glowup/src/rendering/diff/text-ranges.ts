export type TextRange = {
    readonly start: number;
    readonly end: number;
};

/** Shrinks ranges past leading and trailing whitespace and drops whitespace-only ranges. */
export function trimRangeWhitespace(text: string, ranges: readonly TextRange[]): TextRange[] {
    const trimmed: TextRange[] = [];
    for (const range of ranges) {
        const value = text.slice(range.start, range.end);
        const start = range.start + value.length - value.trimStart().length;
        const end = range.end - (value.length - value.trimEnd().length);
        if (start < end) trimmed.push({ start, end });
    }

    return trimmed;
}
