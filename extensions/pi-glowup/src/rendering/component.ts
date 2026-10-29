import {
    type Component,
    truncateToWidth,
    wrapTextWithAnsi,
    visibleWidth,
    sliceByColumn,
} from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { neutralizeTerminalControls } from "../text-boundaries.ts";
import { keyHint } from "@earendil-works/pi-coding-agent";

const MAX_COMPONENT_CACHE_LINES = 300;
const MAX_COMPONENT_CACHE_BYTES = 128 * 1024;

export function makeComponent(renderLines: (width: number) => string[]): Component {
    let cachedWidth: number | undefined;
    let cachedLines: string[] | undefined;

    return {
        render(width: number): string[] {
            const safeWidth = Math.max(1, Math.floor(width));
            if (cachedWidth === safeWidth && cachedLines !== undefined) {
                return cachedLines;
            }

            const rendered = renderLines(safeWidth).map((line) => clipLine(line, safeWidth));
            if (shouldCacheRenderedLines(rendered)) {
                cachedWidth = safeWidth;
                cachedLines = rendered;
            } else {
                cachedWidth = undefined;
                cachedLines = undefined;
            }

            return rendered;
        },
        invalidate(): void {
            cachedWidth = undefined;
            cachedLines = undefined;
        },
    };
}

function clipLine(line: string, width: number): string {
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

export function wrapStyledText(text: string, width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const safeText = neutralizeTerminalControls(text);
    if (visibleWidth(safeText) <= safeWidth) {
        return [safeText];
    }

    const leadingSpaces = /^ +(?=\S)/u.exec(stripVTControlCharacters(safeText))?.[0].length ?? 0;
    const indentWidth = Math.min(leadingSpaces, safeWidth - 1);
    const indent = " ".repeat(indentWidth);
    let content = safeText;
    if (leadingSpaces > 0) {
        content = sliceByColumn(safeText, leadingSpaces, visibleWidth(safeText));
    }

    const wrapped = wrapTextWithAnsi(content, safeWidth - indentWidth);
    if (wrapped.length === 0) {
        return [""];
    }

    return wrapped.map((line) => truncateToWidth(`${indent}${line}`, safeWidth, ""));
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
    const segments = wrapStyledText(line, contentWidth);
    const rendered: string[] = [];
    for (const [index, segment] of segments.entries()) {
        const prefix = index === 0 ? firstPrefix : continuationPrefix;
        rendered.push(truncateToWidth(`${prefix}${segment}`, width, ""));
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

export function toolExpandHint(): string {
    try {
        return keyHint("app.tools.expand", "to expand");
    } catch {
        return "to expand";
    }
}
