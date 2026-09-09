import {
    type Component,
    truncateToWidth,
    wrapTextWithAnsi,
    visibleWidth,
} from "@earendil-works/pi-tui";
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

            const rendered = renderLines(safeWidth).map((line) =>
                truncateToWidth(neutralizeTerminalControls(line), safeWidth, ""),
            );
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
    const wrapped = wrapTextWithAnsi(neutralizeTerminalControls(text), safeWidth);
    if (wrapped.length === 0) {
        return [""];
    }

    return wrapped.map((line) => truncateToWidth(line, safeWidth, ""));
}

export function wrapSinglePhysicalLineWithContinuation(
    line: string,
    width: number,
    firstPrefix: string,
    continuationPrefix: string,
): string[] {
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

export function toolExpandHint(): string {
    try {
        return keyHint("app.tools.expand", "to expand");
    } catch {
        return "to expand";
    }
}
