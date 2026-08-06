export type DiffTextStats = {
    readonly added: number;
    readonly removed: number;
    readonly lineCount: number;
};

/** Counts additions, deletions, and physical lines in a bounded unified diff string. */
export function diffTextStats(diffText: string): DiffTextStats {
    if (diffText.length === 0) {
        return { added: 0, removed: 0, lineCount: 0 };
    }

    let added = 0;
    let removed = 0;
    let lineCount = 0;
    let lineStart = 0;

    for (let index = 0; index <= diffText.length; index += 1) {
        if (index < diffText.length && diffText.charCodeAt(index) !== 10) {
            continue;
        }

        lineCount += 1;
        if (matchesDiffStatLine(diffText, lineStart, index, 43)) {
            added += 1;
        } else if (matchesDiffStatLine(diffText, lineStart, index, 45)) {
            removed += 1;
        }
        lineStart = index + 1;
    }

    return { added, removed, lineCount };
}

export function countDiffStats(diffText: string): {
    readonly added: number;
    readonly removed: number;
} {
    const stats = diffTextStats(diffText);
    return { added: stats.added, removed: stats.removed };
}

function matchesDiffStatLine(
    text: string,
    start: number,
    end: number,
    markerCode: number,
): boolean {
    if (start >= end || text.charCodeAt(start) !== markerCode) {
        return false;
    }

    let index = start + 1;
    while (index < end && isWhitespace(text.charCodeAt(index))) {
        index += 1;
    }

    const digitStart = index;
    while (index < end && isDigit(text.charCodeAt(index))) {
        index += 1;
    }

    return index > digitStart && index < end && isWhitespace(text.charCodeAt(index));
}

function isDigit(charCode: number): boolean {
    return charCode >= 48 && charCode <= 57;
}

function isWhitespace(charCode: number): boolean {
    return (
        charCode === 9 ||
        charCode === 10 ||
        charCode === 11 ||
        charCode === 12 ||
        charCode === 13 ||
        charCode === 32
    );
}
