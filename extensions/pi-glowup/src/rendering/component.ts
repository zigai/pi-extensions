import {
    type Component,
    truncateToWidth,
    wrapTextWithAnsi,
    visibleWidth,
    sliceByColumn,
} from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { neutralizeTerminalControls, sgrSequenceEnd } from "../text-boundaries.ts";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { RenderedLineCache } from "./rendered-line-cache.ts";

const MAX_COMPONENT_CACHE_LINES = 300;
const MAX_COMPONENT_CACHE_BYTES = 128 * 1024;

export function makeComponent(
    renderLines: (width: number) => string[],
    sharedCache?: RenderedLineCache,
): Component {
    let cachedWidth: number | undefined;
    let cachedLines: string[] | undefined;

    return {
        render(width: number): string[] {
            const safeWidth = Math.max(1, Math.floor(width));
            if (cachedWidth === safeWidth && cachedLines !== undefined) {
                return cachedLines;
            }

            const shared = sharedCache?.get(safeWidth);
            if (shared !== undefined) return [...shared];

            const rendered = renderLines(safeWidth).map((line) => clipLine(line, safeWidth));
            if (shouldCacheRenderedLines(rendered)) {
                sharedCache?.clear();
                cachedWidth = safeWidth;
                cachedLines = rendered;
            } else {
                cachedWidth = undefined;
                cachedLines = undefined;
                sharedCache?.set(safeWidth, [...rendered]);
            }

            return rendered;
        },
        invalidate(): void {
            cachedWidth = undefined;
            cachedLines = undefined;
            sharedCache?.clear();
        },
    };
}

// Pi's truncation walks every grapheme of styled text even when the text fits; its width
// measurement has an ASCII and SGR fast path.
export function fitToWidth(text: string, width: number, ellipsis: string): string {
    if (width > 0 && visibleWidth(text) <= width) return text;

    return truncateToWidth(text, width, ellipsis);
}

const NOT_NEUTRAL = -1;
const NEEDS_GRAPHEMES = -2;

// One pass over text that neutralizeTerminalControls would leave unchanged: printable ASCII and
// SGR sequences give their exact column count, other printable text needs grapheme measurement.
function scanNeutralText(text: string): number {
    let columns = 0;
    let graphemes = false;
    for (let index = 0; index < text.length; index += 1) {
        const codeUnit = text.charCodeAt(index);
        if (codeUnit >= 0x20 && codeUnit <= 0x7e) {
            columns += 1;
        } else if (codeUnit === 0x1b) {
            const end = sgrSequenceEnd(text, index);
            if (end === undefined) return NOT_NEUTRAL;

            index = end - 1;
        } else if (codeUnit <= 0x9f) {
            return NOT_NEUTRAL;
        } else {
            graphemes = true;
        }
    }

    if (graphemes) return NEEDS_GRAPHEMES;
    return columns;
}

/** Columns of text made only of printable ASCII and SGR sequences, else undefined. */
export function asciiStyledWidth(text: string): number | undefined {
    const columns = scanNeutralText(text);
    if (columns < 0) return undefined;

    return columns;
}

function clipLine(line: string, width: number): string {
    const lineWidth = asciiStyledWidth(line);
    if (width > 0 && lineWidth !== undefined && lineWidth <= width) return line;

    const text = neutralizeTerminalControls(line);
    let escape = text.indexOf("\u001b");
    if (escape < 0) return truncateToWidth(text, width, "");

    let columns = 0;
    let start = 0;

    // Neutralization leaves only SGR escapes; Pi measures their text runs separately.
    while (escape >= 0) {
        if (escape - start > width) return truncateToWidth(text, width, "");

        columns += visibleWidth(text.slice(start, escape));
        if (columns > width) return truncateToWidth(text, width, "");

        start = text.indexOf("m", escape) + 1;
        escape = text.indexOf("\u001b", start);
    }

    if (text.length - start > width) return truncateToWidth(text, width, "");

    columns += visibleWidth(text.slice(start));
    if (columns <= width) return text;

    return truncateToWidth(text, width, "");
}

function shouldCacheRenderedLines(lines: ReadonlyArray<string>): boolean {
    if (lines.length > MAX_COMPONENT_CACHE_LINES) {
        return false;
    }

    let bytes = 0;
    for (const line of lines) {
        bytes += Buffer.byteLength(line, "utf8");
        if (bytes > MAX_COMPONENT_CACHE_BYTES) {
            return false;
        }
    }

    return true;
}

export function emptyComponent(): Component {
    return makeComponent(() => []);
}

export type StyledSegment = {
    readonly text: string;
    readonly asciiColumns: number | undefined;
};

export function wrapStyledText(text: string, width: number): string[] {
    return wrapStyledSegments(text, width).map((segment) => segment.text);
}

// Matches sliceByColumn to the end of printable ASCII and SGR text: styles before the cut are kept.
function dropLeadingAsciiColumns(text: string, columns: number): string {
    let styles = "";
    let dropped = 0;
    let index = 0;
    while (index < text.length && dropped < columns) {
        const end = sgrSequenceEnd(text, index);
        if (end === undefined) {
            dropped += 1;
            index += 1;
        } else {
            styles += text.slice(index, end);
            index = end;
        }
    }

    return `${styles}${text.slice(index)}`;
}

/** Wraps like wrapStyledText and keeps the exact width of printable ASCII segments. */
export function wrapStyledSegments(text: string, width: number): StyledSegment[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const columns = scanNeutralText(text);
    if (columns >= 0 && columns <= safeWidth) return [{ text, asciiColumns: columns }];
    if (columns === NEEDS_GRAPHEMES && visibleWidth(text) <= safeWidth)
        return [{ text, asciiColumns: undefined }];

    let safeText = text;

    if (columns === NOT_NEUTRAL) {
        safeText = neutralizeTerminalControls(text);
        if (visibleWidth(safeText) <= safeWidth)
            return [{ text: safeText, asciiColumns: undefined }];
    }

    const leadingSpaces = /^ +(?=\S)/u.exec(stripVTControlCharacters(safeText))?.[0].length ?? 0;
    const indentWidth = Math.min(leadingSpaces, safeWidth - 1);
    const indent = " ".repeat(indentWidth);
    let content = safeText;

    if (leadingSpaces > 0 && columns >= 0) {
        content = dropLeadingAsciiColumns(safeText, leadingSpaces);
    } else if (leadingSpaces > 0) {
        content = sliceByColumn(safeText, leadingSpaces, visibleWidth(safeText));
    }

    const wrapped = wrapTextWithAnsi(content, safeWidth - indentWidth);
    if (wrapped.length === 0) {
        return [{ text: "", asciiColumns: 0 }];
    }

    return wrapped.map((line) => {
        const segment = `${indent}${line}`;
        const segmentColumns = asciiStyledWidth(segment);
        if (segmentColumns !== undefined && segmentColumns <= safeWidth)
            return { text: segment, asciiColumns: segmentColumns };

        return { text: fitToWidth(segment, safeWidth, ""), asciiColumns: undefined };
    });
}

function wrapAsciiLine(
    line: string,
    width: number,
    firstPrefix: string,
    continuationPrefix: string,
): string[] | undefined {
    if (
        !Number.isInteger(width) ||
        !/^[\x20-\x7e]*$/u.test(line) ||
        !/^[\x20-\x7e]*$/u.test(firstPrefix) ||
        !/^[\x20-\x7e]*$/u.test(continuationPrefix)
    )
        return undefined;

    const prefixWidth = Math.max(firstPrefix.length, continuationPrefix.length);
    if (width <= prefixWidth) return undefined;

    const contentWidth = width - prefixWidth;
    if (line.length <= contentWidth) return [firstPrefix + line];

    const leading = /^ +(?=\S)/u.exec(line)?.[0].length ?? 0;
    const indent = " ".repeat(Math.min(leading, contentWidth - 1));
    const available = contentWidth - indent.length;
    const content = line.slice(leading);
    const wrapped: string[] = [];
    let current = "";
    let columns = 0;

    for (const match of content.matchAll(/ +|[^ ]+/gu)) {
        const token = match[0];
        const space = token.startsWith(" ");
        if (!space && token.length > available) {
            if (current.length > 0) wrapped.push(current.trimEnd());

            let offset = 0;
            while (offset + available < token.length) {
                wrapped.push(token.slice(offset, offset + available));
                offset += available;
            }

            current = token.slice(offset);
            columns = current.length;
        } else if (columns + token.length > available && columns > 0) {
            wrapped.push(current.trimEnd());
            current = "";
            columns = 0;
            if (!space) {
                current = token;
                columns = token.length;
            }
        } else {
            current += token;
            columns += token.length;
        }
    }

    if (current.length > 0) wrapped.push(current.trimEnd());
    if (wrapped.length === 0) wrapped.push("");

    return wrapped.map((segment, index) => {
        let prefix = continuationPrefix;
        if (index === 0) prefix = firstPrefix;

        return prefix + indent + segment;
    });
}

/** Prefixes a segment and fits the row to the width, as fitToWidth does. */
export function fitPrefixedSegment(
    prefix: string,
    prefixColumns: number | undefined,
    segment: StyledSegment,
    width: number,
): StyledSegment {
    const row = `${prefix}${segment.text}`;

    // Printable ASCII and SGR widths add exactly, so a fitting row needs no second measurement.
    if (
        width > 0 &&
        prefixColumns !== undefined &&
        segment.asciiColumns !== undefined &&
        prefixColumns + segment.asciiColumns <= width
    ) {
        return { text: row, asciiColumns: prefixColumns + segment.asciiColumns };
    }

    return { text: fitToWidth(row, width, ""), asciiColumns: undefined };
}

export function wrapSinglePhysicalLineWithContinuation(
    line: string,
    width: number,
    firstPrefix: string,
    continuationPrefix: string,
): string[] {
    const ascii = wrapAsciiLine(line, width, firstPrefix, continuationPrefix);
    if (ascii !== undefined) return ascii;

    const contentWidth = Math.max(
        1,
        width - Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix)),
    );
    const segments = wrapStyledSegments(line, contentWidth);
    const firstColumns = asciiStyledWidth(firstPrefix);
    const continuationColumns = asciiStyledWidth(continuationPrefix);
    const rendered: string[] = [];

    for (const [index, segment] of segments.entries()) {
        let prefix = continuationPrefix;
        let prefixColumns = continuationColumns;

        if (index === 0) {
            prefix = firstPrefix;
            prefixColumns = firstColumns;
        }

        rendered.push(fitPrefixedSegment(prefix, prefixColumns, segment, width).text);
    }

    return rendered;
}

export function wrapPrefixedLine(
    text: string | undefined,
    width: number,
    firstPrefix: string,
    restPrefix: string,
): string[] {
    const normalized = (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const physicalLines = normalized.split("\n");
    const rendered: string[] = [];
    for (const physicalLine of physicalLines) {
        const prefix = rendered.length === 0 ? firstPrefix : restPrefix;
        rendered.push(
            ...wrapSinglePhysicalLineWithContinuation(physicalLine, width, prefix, restPrefix),
        );
    }

    return rendered;
}

export function omittedLinesLabel(count: number): string {
    if (count === 1) {
        return "… +1 line";
    }

    return `… +${count} lines`;
}

export type ToolKeyHint = (keybinding: "app.tools.expand", description: string) => string;

export function toolExpandHint(injectedKeyHint?: ToolKeyHint): string {
    try {
        if (injectedKeyHint !== undefined) return injectedKeyHint("app.tools.expand", "to expand");
        return keyHint("app.tools.expand", "to expand");
    } catch {
        return "to expand";
    }
}
