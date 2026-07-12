export type TextRange = {
    readonly start: number;
    readonly end: number;
};

type DiffToken = TextRange & {
    readonly text: string;
};

const MAX_LCS_TOKENS = 256;
const tokenPattern = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu;

/** Finds the changed token spans in a paired deletion and addition line. */
export function changedTextRanges(
    before: string,
    after: string,
): { readonly before: readonly TextRange[]; readonly after: readonly TextRange[] } {
    if (before === after) {
        return { before: [], after: [] };
    }

    const beforeTokens = tokenize(before);
    const afterTokens = tokenize(after);
    if (beforeTokens.length > MAX_LCS_TOKENS || afterTokens.length > MAX_LCS_TOKENS) {
        return {
            before: wholeTextRange(before),
            after: wholeTextRange(after),
        };
    }

    const matched = longestCommonTokenSubsequence(beforeTokens, afterTokens);
    return {
        before: unmatchedTokenRanges(beforeTokens, matched.before),
        after: unmatchedTokenRanges(afterTokens, matched.after),
    };
}

/** Adds background open/close sequences around selected source-text ranges. */
export function applyBackgroundToTextRanges(
    styledText: string,
    ranges: readonly TextRange[],
    background: { readonly open: string; readonly close: string },
): string {
    if (ranges.length === 0 || styledText.length === 0) {
        return styledText;
    }

    let output = "";
    let sourceOffset = 0;
    let rangeIndex = 0;
    let backgroundOpen = false;
    let index = 0;

    while (index < styledText.length) {
        const escapeEnd = ansiEscapeEnd(styledText, index);
        if (escapeEnd !== undefined) {
            output += styledText.slice(index, escapeEnd);
            index = escapeEnd;
            continue;
        }

        const range = ranges[rangeIndex];
        if (!backgroundOpen && range !== undefined && sourceOffset >= range.start) {
            output += background.open;
            backgroundOpen = true;
        }

        const codePoint = styledText.codePointAt(index);
        if (codePoint === undefined) {
            break;
        }
        const character = String.fromCodePoint(codePoint);
        output += character;
        index += character.length;
        sourceOffset += character.length;

        if (backgroundOpen && range !== undefined && sourceOffset >= range.end) {
            output += background.close;
            backgroundOpen = false;
            rangeIndex += 1;
        }
    }

    if (backgroundOpen) {
        output += background.close;
    }
    return output;
}

function tokenize(text: string): DiffToken[] {
    const tokens: DiffToken[] = [];
    tokenPattern.lastIndex = 0;
    for (const match of text.matchAll(tokenPattern)) {
        const start = match.index;
        const value = match[0];
        tokens.push({ text: value, start, end: start + value.length });
    }
    return tokens;
}

function longestCommonTokenSubsequence(
    before: readonly DiffToken[],
    after: readonly DiffToken[],
): { readonly before: ReadonlySet<number>; readonly after: ReadonlySet<number> } {
    const rowLength = after.length + 1;
    const lengths = new Uint16Array((before.length + 1) * rowLength);
    const cell = (beforeIndex: number, afterIndex: number): number =>
        beforeIndex * rowLength + afterIndex;

    for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
        for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
            lengths[cell(beforeIndex, afterIndex)] =
                before[beforeIndex]?.text === after[afterIndex]?.text
                    ? 1 + (lengths[cell(beforeIndex + 1, afterIndex + 1)] ?? 0)
                    : Math.max(
                          lengths[cell(beforeIndex + 1, afterIndex)] ?? 0,
                          lengths[cell(beforeIndex, afterIndex + 1)] ?? 0,
                      );
        }
    }

    const matchedBefore = new Set<number>();
    const matchedAfter = new Set<number>();
    let beforeIndex = 0;
    let afterIndex = 0;
    while (beforeIndex < before.length && afterIndex < after.length) {
        if (before[beforeIndex]?.text === after[afterIndex]?.text) {
            matchedBefore.add(beforeIndex);
            matchedAfter.add(afterIndex);
            beforeIndex += 1;
            afterIndex += 1;
            continue;
        }
        if (
            (lengths[cell(beforeIndex + 1, afterIndex)] ?? 0) >=
            (lengths[cell(beforeIndex, afterIndex + 1)] ?? 0)
        ) {
            beforeIndex += 1;
        } else {
            afterIndex += 1;
        }
    }

    return { before: matchedBefore, after: matchedAfter };
}

function unmatchedTokenRanges(
    tokens: readonly DiffToken[],
    matched: ReadonlySet<number>,
): TextRange[] {
    const ranges: TextRange[] = [];
    for (const [index, token] of tokens.entries()) {
        if (matched.has(index)) {
            continue;
        }
        const previous = ranges.at(-1);
        if (previous !== undefined && previous.end === token.start) {
            ranges[ranges.length - 1] = { start: previous.start, end: token.end };
        } else {
            ranges.push({ start: token.start, end: token.end });
        }
    }
    return ranges;
}

function wholeTextRange(text: string): TextRange[] {
    return text.length === 0 ? [] : [{ start: 0, end: text.length }];
}

function ansiEscapeEnd(text: string, index: number): number | undefined {
    if (text.charCodeAt(index) !== 0x1b) {
        return undefined;
    }
    const introducer = text.charCodeAt(index + 1);
    if (introducer === 0x5b) {
        for (let cursor = index + 2; cursor < text.length; cursor += 1) {
            const code = text.charCodeAt(cursor);
            if (code >= 0x40 && code <= 0x7e) {
                return cursor + 1;
            }
        }
        return text.length;
    }
    if (introducer === 0x5d) {
        for (let cursor = index + 2; cursor < text.length; cursor += 1) {
            if (text.charCodeAt(cursor) === 0x07) {
                return cursor + 1;
            }
            if (text.charCodeAt(cursor) === 0x1b && text.charCodeAt(cursor + 1) === 0x5c) {
                return cursor + 2;
            }
        }
        return text.length;
    }
    return Math.min(text.length, index + 2);
}
