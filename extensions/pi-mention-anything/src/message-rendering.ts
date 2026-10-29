import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { installLinkedRenderPatch } from "@zigai/pi-extension-internals";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parseMentions, type ChainDefinition } from "./chain-syntax.ts";

// Match terminal controls without counting them as message characters. Keep every control
// in place, including Pi's OSC 133 markers and background colors.
const CONTROL = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|.)/g;

const style = Type.Function([Type.String()], Type.String());
const markdownThemeSchema = Type.Object({
    heading: style,
    link: style,
    linkUrl: style,
    code: style,
    codeBlock: style,
    codeBlockBorder: style,
    quote: style,
    quoteBorder: style,
    hr: style,
    listBullet: style,
    bold: style,
    italic: style,
    strikethrough: style,
    underline: style,
    highlightCode: Type.Optional(
        Type.Function([Type.String(), Type.Optional(Type.String())], Type.Array(Type.String())),
    ),
    codeBlockIndent: Type.Optional(Type.String()),
});
const transformContext = Type.Object({
    messageType: Type.Union([
        Type.Literal("user"),
        Type.Literal("assistant"),
        Type.Literal("assistant-thinking"),
    ]),
    isStreaming: Type.Boolean(),
    availableWidth: Type.Number(),
});
const probeConfigSchema = Type.Object({
    markdownTheme: markdownThemeSchema,
    outputPad: Type.Number(),
    markdownTransformers: Type.Array(
        Type.Function([Type.String(), transformContext], Type.String()),
    ),
});

type Span = { start: number; end: number };

function colorLine(line: string, spans: readonly Span[], prefix: string): string {
    if (!prefix || spans.length === 0) return line;
    let result = "";
    let offset = 0;
    let plain = 0;
    let foreground = "\x1b[39m";
    let active = false;
    const writeText = (text: string): void => {
        for (let i = 0; i < text.length; i++) {
            const highlighted = spans.some((span) => plain >= span.start && plain < span.end);
            if (highlighted !== active) {
                if (highlighted) result += prefix;
                else result += foreground;
                active = highlighted;
            }
            result += text[i];
            plain++;
        }
    };
    for (const match of line.matchAll(CONTROL)) {
        writeText(line.slice(offset, match.index));
        const control = match[0];
        result += control;
        if (control.startsWith("\x1b[") && control.endsWith("m")) {
            const codes = control.slice(2, -1).split(";").map(Number);
            for (let i = 0; i < codes.length; i++) {
                const code = codes[i];
                if (code === 0 || code === 39) foreground = "\x1b[39m";
                else if (
                    code !== undefined &&
                    ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))
                )
                    foreground = `\x1b[${code}m`;
                else if (code === 38 && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
                    foreground = `\x1b[38;5;${codes[i + 2]}m`;
                    i += 2;
                } else if (code === 38 && codes[i + 1] === 2 && codes[i + 4] !== undefined) {
                    foreground = `\x1b[38;2;${codes[i + 2]};${codes[i + 3]};${codes[i + 4]}m`;
                    i += 4;
                } else if ((code === 48 || code === 58) && codes[i + 1] === 5) i += 2;
                else if ((code === 48 || code === 58) && codes[i + 1] === 2) i += 4;
            }
            if (active) result += prefix;
        }
        offset = match.index + control.length;
    }
    writeText(line.slice(offset));
    if (active) result += foreground;
    return result;
}

function mentionSpans(text: string, sources: readonly ChainDefinition[]): Span[] {
    const urlRanges = Array.from(text.matchAll(/https?:\/\/[^\s<>"'`]+/g), (match) => ({
        start: match.index,
        end: match.index + match[0].length,
    }));
    return parseMentions(text, sources)
        .filter((span) => span.complete)
        .flatMap((span) => {
            let parts: Span[] = [{ start: span.start, end: span.end }];
            for (const url of urlRanges) {
                parts = parts.flatMap((part) => {
                    if (url.end <= part.start || url.start >= part.end) return [part];
                    const remainder: Span[] = [];
                    if (part.start < url.start)
                        remainder.push({ start: part.start, end: url.start });
                    if (url.end < part.end) remainder.push({ start: url.end, end: part.end });
                    return remainder;
                });
            }
            return parts;
        });
}

export function colorUserMessageLines(
    text: string,
    lines: readonly string[],
    sources: readonly ChainDefinition[],
    prefix: string,
): string[] {
    const logicalText = text.replace(/\t/g, "   ");
    const spans = mentionSpans(logicalText, sources);
    if (!spans.length || !prefix) return [...lines];
    let searchStart = 0;
    let aligned = true;
    const mappings = lines.map((line) => {
        const plain = line.replace(CONTROL, "");
        const content = plain.trim();
        if (!content || !aligned) return undefined;
        const start = logicalText.indexOf(content, searchStart);
        if (start < 0 || logicalText.slice(searchStart, start).trim().length > 0) {
            aligned = false;
            return undefined;
        }
        searchStart = start + content.length;
        return { start, end: searchStart, padding: plain.indexOf(content) };
    });
    if (!aligned || logicalText.slice(searchStart).trim().length > 0) return [...lines];
    return lines.map((line, index) => {
        const mapping = mappings[index];
        if (mapping === undefined) return line;
        const ranges = spans
            .filter((span) => span.start < mapping.end && span.end > mapping.start)
            .map((span) => ({
                start: mapping.padding + Math.max(span.start, mapping.start) - mapping.start,
                end: mapping.padding + Math.min(span.end, mapping.end) - mapping.start,
            }));
        return colorLine(line, ranges, prefix);
    });
}

// OSC markers are rendered only in a separate component, never emitted to the terminal.
const MARKER_PREFIX = "\x1b]777;pi-mention-";
const MARKER = /^\x1b\]777;pi-mention-(\d+)-(start|end)\x07$/;

function probeConfig(component: UserMessageComponent): Static<typeof probeConfigSchema> {
    const markdownTheme: unknown = Object.getOwnPropertyDescriptor(
        component,
        "markdownTheme",
    )?.value;
    const outputPad: unknown = Object.getOwnPropertyDescriptor(component, "outputPad")?.value;
    const markdownTransformers: unknown = Object.getOwnPropertyDescriptor(
        component,
        "markdownTransformers",
    )?.value;
    const fields = { markdownTheme, outputPad, markdownTransformers };
    if (!Value.Check(probeConfigSchema, fields)) {
        throw new Error("Pi user message Markdown render configuration is unavailable or invalid");
    }
    return fields;
}

function colorMarkdownMentions(
    fields: Static<typeof probeConfigSchema>,
    text: string,
    lines: readonly string[],
    width: number,
    spans: readonly Span[],
    prefix: string,
    render: (this: UserMessageComponent, width: number) => string[],
): string[] {
    if (!prefix || !spans.length || text.includes(MARKER_PREFIX)) return [...lines];
    // Split only failing batches: unrelated mentions can share a single probe.
    const retrySeparately = (): string[] => {
        if (spans.length < 2) return [...lines];
        const middle = Math.floor(spans.length / 2);
        const first = colorMarkdownMentions(
            fields,
            text,
            lines,
            width,
            spans.slice(0, middle),
            prefix,
            render,
        );
        return colorMarkdownMentions(
            fields,
            text,
            first,
            width,
            spans.slice(middle),
            prefix,
            render,
        );
    };
    let marked = "";
    let cursor = 0;
    for (const [index, span] of spans.entries()) {
        if (span.start < cursor) return [...lines];
        marked += text.slice(cursor, span.start) + `${MARKER_PREFIX}${index}-start\x07`;
        marked += text.slice(span.start, span.end) + `${MARKER_PREFIX}${index}-end\x07`;
        cursor = span.end;
    }
    marked += text.slice(cursor);

    const clone = new UserMessageComponent(
        marked,
        fields.markdownTheme,
        fields.outputPad,
        fields.markdownTransformers,
    );
    const probe = render.call(clone, width);
    if (
        probe.length !== lines.length ||
        probe.some((line, i) => line.replace(CONTROL, "") !== lines[i]?.replace(CONTROL, ""))
    )
        return retrySeparately();

    const starts = new Map<number, { line: number; offset: number }>();
    const completed = new Map<
        number,
        { start: { line: number; offset: number }; end: { line: number; offset: number } }
    >();
    let invalid = false;
    probe.forEach((line, lineIndex) => {
        let offset = 0;
        let plain = 0;
        for (const match of line.matchAll(CONTROL)) {
            plain += match.index - offset;
            const marker = MARKER.exec(match[0]);
            if (marker) {
                const id = Number(marker[1]);
                if (id >= spans.length || completed.has(id)) invalid = true;
                else if (marker[2] === "start") {
                    if (starts.has(id)) invalid = true;
                    else starts.set(id, { line: lineIndex, offset: plain });
                } else {
                    const start = starts.get(id);
                    if (!start) invalid = true;
                    else {
                        completed.set(id, { start, end: { line: lineIndex, offset: plain } });
                        starts.delete(id);
                    }
                }
            }
            offset = match.index + match[0].length;
        }
    });
    if (invalid || starts.size) return retrySeparately();
    return lines.map((line, lineIndex) => {
        const plain = line.replace(CONTROL, "");
        const ranges: Span[] = [];
        for (const { start, end } of completed.values()) {
            if (lineIndex < start.line || lineIndex > end.line) continue;
            let from = 0;
            let to = plain.length;
            if (lineIndex === start.line) from = start.offset;
            if (lineIndex === end.line) to = end.offset;
            if (lineIndex !== start.line)
                from = Math.max(from, plain.length - plain.trimStart().length);
            if (lineIndex !== end.line) to = Math.min(to, plain.trimEnd().length);
            if (from < to) ranges.push({ start: from, end: to });
        }
        return colorLine(line, ranges, prefix);
    });
}

export function installUserMentionRendering(
    sources: readonly ChainDefinition[],
    getPrefix: () => string,
): { dispose(): void } {
    const cache = new WeakMap<UserMessageComponent, { key: unknown[]; lines: string[] }>();
    return installLinkedRenderPatch(
        UserMessageComponent.prototype,
        (predecessor) =>
            function (this: UserMessageComponent, width: number): string[] {
                const lines = predecessor.call(this, width);
                const descriptor = Object.getOwnPropertyDescriptor(this, "text");
                if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return lines;
                const text: unknown = descriptor.value;
                if (!Value.Check(Type.String(), text)) return lines;
                const prefix = getPrefix();
                const direct = colorUserMessageLines(text, lines, sources, prefix);
                if (direct.some((line, index) => line !== lines[index])) return direct;
                const spans = mentionSpans(text, sources);
                if (!prefix || !spans.length || text.includes(MARKER_PREFIX)) return lines;
                const fields = probeConfig(this);
                const key: unknown[] = [
                    text,
                    width,
                    prefix,
                    JSON.stringify(spans),
                    JSON.stringify(lines),
                    fields.outputPad,
                    fields.markdownTheme,
                    fields.markdownTheme.heading,
                    fields.markdownTheme.link,
                    fields.markdownTheme.linkUrl,
                    fields.markdownTheme.code,
                    fields.markdownTheme.codeBlock,
                    fields.markdownTheme.codeBlockBorder,
                    fields.markdownTheme.quote,
                    fields.markdownTheme.quoteBorder,
                    fields.markdownTheme.hr,
                    fields.markdownTheme.listBullet,
                    fields.markdownTheme.bold,
                    fields.markdownTheme.italic,
                    fields.markdownTheme.strikethrough,
                    fields.markdownTheme.underline,
                    fields.markdownTheme.highlightCode,
                    fields.markdownTheme.codeBlockIndent,
                    fields.markdownTransformers,
                    ...Object.entries(fields.markdownTheme)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .flat(),
                    ...fields.markdownTransformers,
                ];
                const previous = cache.get(this);
                if (
                    previous &&
                    previous.key.length === key.length &&
                    previous.key.every((value, index) => Object.is(value, key[index]))
                ) {
                    return [...previous.lines];
                }
                const colored = colorMarkdownMentions(
                    fields,
                    text,
                    lines,
                    width,
                    spans,
                    prefix,
                    predecessor,
                );
                cache.set(this, { key, lines: [...colored] });
                return colored;
            },
    );
}
