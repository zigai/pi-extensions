const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ESCAPE_CODE = 0x1b;
const MAX_SGR_SEQUENCE_CHARACTERS = 64;

function normalizedBudget(maxCharacters: number): number {
    if (!Number.isFinite(maxCharacters)) {
        return maxCharacters > 0 ? Number.MAX_SAFE_INTEGER : 0;
    }
    return Math.max(0, Math.floor(maxCharacters));
}

function completeUnicodePrefix(text: string): string {
    if (text.length === 0) {
        return text;
    }
    const finalCodeUnit = text.charCodeAt(text.length - 1);
    return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? text.slice(0, -1) : text;
}

function sgrSequenceEnd(text: string, start: number): number | undefined {
    if (text.charCodeAt(start) !== ESCAPE_CODE || text.charAt(start + 1) !== "[") {
        return undefined;
    }
    let index = start + 2;
    while (
        index < text.length &&
        index - start < MAX_SGR_SEQUENCE_CHARACTERS &&
        /[\d:;]/u.test(text.charAt(index))
    ) {
        index += 1;
    }
    return text.charAt(index) === "m" ? index + 1 : undefined;
}

function visibleControl(codeUnit: number): string {
    if (codeUnit <= 0x1f) {
        return String.fromCharCode(0x2400 + codeUnit);
    }
    if (codeUnit === 0x7f) {
        return "␡";
    }
    return `‹${codeUnit.toString(16).toUpperCase().padStart(2, "0")}›`;
}

/** Neutralizes terminal controls while preserving SGR style sequences produced by renderers. */
export function neutralizeTerminalControls(text: string): string {
    let output = "";
    let runStart = 0;
    for (let index = 0; index < text.length; index += 1) {
        const codeUnit = text.charCodeAt(index);
        if (codeUnit === ESCAPE_CODE) {
            const sgrEnd = sgrSequenceEnd(text, index);
            if (sgrEnd !== undefined) {
                index = sgrEnd - 1;
                continue;
            }
        } else if (codeUnit > 0x1f && codeUnit !== 0x7f && (codeUnit < 0x80 || codeUnit > 0x9f)) {
            continue;
        }

        output += text.slice(runStart, index);
        output += codeUnit === 0x09 ? "   " : visibleControl(codeUnit);
        runStart = index + 1;
    }
    return runStart === 0 ? text : `${output}${text.slice(runStart)}`;
}

/** Lazily visits complete grapheme clusters and withholds a trailing partial surrogate. */
export function* graphemes(text: string): Generator<string> {
    for (const { segment } of graphemeSegmenter.segment(completeUnicodePrefix(text))) {
        yield segment;
    }
}

/** Truncates to a UTF-8 byte budget without dividing grapheme clusters. */
export function truncateUtf8ByGrapheme(text: string, maxBytes: number): string {
    const budget = normalizedBudget(maxBytes);
    let byteLength = 0;
    let endIndex = 0;
    for (const segment of graphemes(text)) {
        const segmentBytes = Buffer.byteLength(segment, "utf8");
        if (byteLength + segmentBytes > budget) {
            break;
        }
        byteLength += segmentBytes;
        endIndex += segment.length;
    }
    return text.slice(0, endIndex);
}

/** Returns the longest complete-grapheme prefix within a UTF-16 length budget. */
export function takeGraphemePrefix(text: string, maxCharacters: number): string {
    const budget = normalizedBudget(maxCharacters);
    const source = completeUnicodePrefix(text);
    if (budget === 0 || source.length === 0) {
        return "";
    }
    if (source.length <= budget) {
        return source;
    }

    const containing = graphemeSegmenter.segment(source).containing(budget);
    const end =
        containing === undefined || containing.index < budget ? (containing?.index ?? 0) : budget;
    return source.slice(0, end);
}

/** Returns the longest complete-grapheme suffix within a UTF-16 length budget. */
export function takeGraphemeSuffix(text: string, maxCharacters: number): string {
    const budget = normalizedBudget(maxCharacters);
    const source = completeUnicodePrefix(text);
    if (budget === 0 || source.length === 0) {
        return "";
    }
    if (source.length <= budget) {
        return source;
    }

    const boundary = source.length - budget;
    const containing = graphemeSegmenter.segment(source).containing(boundary);
    if (containing === undefined) {
        return "";
    }
    const start =
        containing.index < boundary
            ? containing.index + containing.segment.length
            : containing.index;
    return source.slice(start);
}

/** Adds an omission suffix while retaining only complete grapheme clusters. */
export function appendGraphemeEllipsis(
    text: string,
    maxCharacters: number,
    ellipsis = "…",
): string {
    const budget = normalizedBudget(maxCharacters);
    if (budget === 0) {
        return "";
    }
    const boundedEllipsis = takeGraphemePrefix(ellipsis, budget);
    return `${takeGraphemePrefix(text, budget - boundedEllipsis.length)}${boundedEllipsis}`;
}

/** Truncates text only when needed and never cuts a grapheme cluster. */
export function truncateGraphemeText(text: string, maxCharacters: number, ellipsis = "…"): string {
    const budget = normalizedBudget(maxCharacters);
    const source = completeUnicodePrefix(text);
    return source.length <= budget ? source : appendGraphemeEllipsis(source, budget, ellipsis);
}

/** Splits text near a target size without dividing graphemes that exceed the target. */
export function chunkGraphemeText(text: string, maxCharacters: number): readonly string[] {
    const budget = normalizedBudget(maxCharacters);
    const source = completeUnicodePrefix(text);
    if (source.length === 0 || budget === 0) {
        return [];
    }
    if (source.length <= budget) {
        return [source];
    }

    const chunks: string[] = [];
    let current = "";
    for (const segment of graphemes(source)) {
        if (current.length > 0 && current.length + segment.length > budget) {
            chunks.push(current);
            current = "";
        }
        if (current.length === 0 && segment.length > budget) {
            chunks.push(segment);
        } else {
            current += segment;
        }
    }
    if (current.length > 0) {
        chunks.push(current);
    }
    return chunks;
}
