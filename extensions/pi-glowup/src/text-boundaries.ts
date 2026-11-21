import { visibleWidth } from "@earendil-works/pi-tui";

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

// Digits, colon, and semicolon are contiguous code units.
function isSgrParameter(codeUnit: number): boolean {
    return codeUnit >= 0x30 && codeUnit <= 0x3b;
}

export function sgrSequenceEnd(text: string, start: number): number | undefined {
    if (text.charCodeAt(start) !== ESCAPE_CODE || text.charAt(start + 1) !== "[") {
        return undefined;
    }

    let index = start + 2;
    while (
        index < text.length &&
        index - start < MAX_SGR_SEQUENCE_CHARACTERS &&
        isSgrParameter(text.charCodeAt(index))
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
        output += codeUnit === 0x09 ? "\t" : visibleControl(codeUnit);
        runStart = index + 1;
    }

    const neutralized = runStart === 0 ? text : `${output}${text.slice(runStart)}`;
    return neutralized.includes("\t") ? expandTerminalTabs(neutralized, 4, 0).text : neutralized;
}

export type ExpandedTerminalTabs = {
    readonly text: string;
    readonly finalDisplayColumn: number;
};

export function expandTerminalTabs(
    text: string,
    tabWidth = 4,
    initialDisplayColumn = 0,
): ExpandedTerminalTabs {
    const width = Math.max(1, Math.floor(tabWidth));
    let displayColumn = Math.max(0, Math.floor(initialDisplayColumn));
    let output = "";
    let runStart = 0;

    for (let index = 0; index < text.length; index += 1) {
        const character = text.charAt(index);
        if (character !== "\t" && character !== "\n" && character !== "\r") {
            continue;
        }

        const run = text.slice(runStart, index);
        output += run;
        displayColumn += visibleWidth(run);

        if (character === "\t") {
            const spaces = width - (displayColumn % width);
            output += " ".repeat(spaces);
            displayColumn += spaces;
        } else {
            output += character;
            displayColumn = 0;
        }

        runStart = index + 1;
    }

    const tail = text.slice(runStart);
    output += tail;
    displayColumn += visibleWidth(tail);
    return {
        text: runStart === 0 ? text : output,
        finalDisplayColumn: displayColumn,
    };
}

export function hasNonWhitespaceText(text: string): boolean {
    return /\S/u.test(text);
}

export function countContentLines(content: string): number {
    if (content.length === 0) {
        return 0;
    }

    let lineCount = content.endsWith("\n") ? 0 : 1;
    for (let index = 0; index < content.length; index += 1) {
        if (content.charCodeAt(index) === 10) {
            lineCount += 1;
        }
    }

    return lineCount;
}

/** Lazily visits complete grapheme clusters and withholds a trailing partial surrogate. */
export function* graphemes(text: string): Generator<string> {
    for (const { segment } of graphemeSegmenter.segment(completeUnicodePrefix(text))) {
        yield segment;
    }
}

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

export function truncateGraphemeText(text: string, maxCharacters: number, ellipsis = "…"): string {
    const budget = normalizedBudget(maxCharacters);
    const source = completeUnicodePrefix(text);
    return source.length <= budget ? source : appendGraphemeEllipsis(source, budget, ellipsis);
}

export function normalizedCodeLines(code: string): string[] {
    const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}
