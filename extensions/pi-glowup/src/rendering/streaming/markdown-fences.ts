import { Lexer } from "marked";
import Type from "typebox";
import { Value } from "typebox/value";

const blockSchema = Type.Object({ type: Type.String(), raw: Type.String() });
const codeSchema = Type.Object({
    type: Type.Literal("code"),
    raw: Type.String(),
    text: Type.String(),
    lang: Type.Optional(Type.String()),
    codeBlockStyle: Type.Optional(Type.Literal("indented")),
});

const quoteSchema = Type.Object({
    type: Type.Literal("blockquote"),
    raw: Type.String(),
    text: Type.String(),
    tokens: Type.Array(Type.Unknown()),
});

const listSchema = Type.Object({
    type: Type.Literal("list"),
    raw: Type.String(),
    ordered: Type.Boolean(),
    start: Type.Union([Type.Number(), Type.Literal("")]),
    items: Type.Array(
        Type.Object({
            raw: Type.String(),
            text: Type.String(),
            task: Type.Boolean(),
            tokens: Type.Array(Type.Unknown()),
        }),
    ),
});

type MappedText = {
    readonly text: string;
    readonly contentEnd: number;
    readonly positions: readonly (number | undefined)[];
    readonly end: number;
};

export type MarkdownFence = {
    readonly start: number;
    readonly end: number;
    readonly opener: string;
    readonly closer: string;
    readonly code: string;
    readonly language: string | undefined;
    readonly closed: boolean;
    readonly complete: boolean;
    readonly widthInset: number;
    readonly prefix: string;
    readonly originalCode: string;
};

function characterEnd(source: string, position: number): number {
    if (source[position] === "\r" && source[position + 1] === "\n") return position + 2;
    return position + 1;
}

function normalize(source: string): MappedText {
    let text = "";
    const positions: number[] = [];
    for (let index = 0; index < source.length; index++) {
        positions.push(index);

        if (source[index] === "\r") {
            text += "\n";

            if (source[index + 1] === "\n") index++;
        } else text += source[index];
    }

    return { text, contentEnd: text.trimEnd().length, positions, end: source.length };
}

function slice(source: string, mapped: MappedText, start: number, end: number): MappedText {
    const last = mapped.positions[end - 1];
    let originalEnd = mapped.end;
    if (last !== undefined && end < mapped.contentEnd) originalEnd = characterEnd(source, last);

    const text = mapped.text.slice(start, end);
    return {
        text,
        contentEnd: text.trimEnd().length,
        positions: mapped.positions.slice(start, end),
        end: originalEnd,
    };
}

function project(mapped: MappedText, text: string): MappedText {
    // Marked removes container prefixes line-by-line and expands list tabs.
    // Keep those source locations: fence-looking lines also occur in HTML
    // and indented code, so searching the original document is ambiguous.
    const positions: (number | undefined)[] = [];
    let parentOffset = 0;
    let offset = 0;
    while (offset < text.length) {
        let end = text.indexOf("\n", offset);
        if (end === -1) end = text.length;

        let parentEnd = mapped.text.indexOf("\n", parentOffset);
        if (parentEnd === -1) parentEnd = mapped.text.length;

        const line = text.slice(offset, end);
        const parentLine = mapped.text.slice(parentOffset, parentEnd);
        let expanded = "";
        const expandedPositions: (number | undefined)[] = [];
        for (let index = 0; index < parentLine.length; index++) {
            const position = mapped.positions[parentOffset + index];
            let value = parentLine[index] ?? "";
            if (value === "\t") value = "    ";
            expanded += value;

            for (let column = 0; column < value.length; column++) expandedPositions.push(position);
        }

        let match = parentLine.lastIndexOf(line);
        let linePositions = mapped.positions.slice(parentOffset, parentEnd);
        if (match === -1) {
            match = expanded.lastIndexOf(line);
            linePositions = expandedPositions;
        }

        if (match === -1) {
            // Setext protection and first-line list tab stops may add leading
            // whitespace. It has no independent source character.
            const content = line.trimStart();
            match = expanded.lastIndexOf(content);

            const leading = line.length - content.length;

            positions.push(...Array.from({ length: leading }, () => undefined));

            if (match === -1) {
                // A normalized prose line may be synthetic (for example a
                // protected setext heading). Keep its logical characters but
                // never manufacture original offsets for them.
                positions.push(...Array.from({ length: content.length }, () => undefined));
            } else positions.push(...expandedPositions.slice(match, match + content.length));
        } else positions.push(...linePositions.slice(match, match + line.length));

        if (end < text.length) positions.push(mapped.positions[parentEnd]);
        offset = end + 1;
        parentOffset = parentEnd + 1;
    }

    return { text, contentEnd: text.trimEnd().length, positions, end: mapped.end };
}

function original(source: string, mapped: MappedText): string {
    let text = "";
    let index = 0;
    while (index < mapped.text.length) {
        const position = mapped.positions[index];
        if (position === undefined) {
            text += mapped.text[index];
            index++;
            continue;
        }

        let end = index + 1;
        while (mapped.positions[end] === position) end++;

        // Marked expands list continuation tabs into four columns. Preserve
        // literal code tabs only when the whole tab survives container dedent;
        // a partially consumed indentation tab contributes its remaining spaces.
        if (source[position] === "\t" && mapped.text[index] === " " && end - index < 4)
            text += mapped.text.slice(index, end);
        else text += source.slice(position, characterEnd(source, position));

        index = end;
    }

    return text;
}

function lineStart(source: string, position: number): number {
    return (
        Math.max(source.lastIndexOf("\n", position - 1), source.lastIndexOf("\r", position - 1)) + 1
    );
}

function lineEnd(source: string, position: number): number {
    const carriageReturn = source.indexOf("\r", position);
    let end = source.indexOf("\n", position);
    if (end === -1 || (carriageReturn !== -1 && carriageReturn < end)) end = carriageReturn;
    if (end === -1) return source.length;
    return characterEnd(source, end);
}

/** A single block lexer owns fence discovery, including arbitrarily nested
 * lists/quotes. Inline tokens are deliberately never traversed.
 */
export function markdownFences(source: string): MarkdownFence[] {
    const result: MarkdownFence[] = [];
    const sourceContentEnd = source.trimEnd().length;

    function walk(
        tokens: readonly unknown[],
        mapped: MappedText,
        widthInset: number,
        nestedList?: { widthInset: number; depth: number },
    ): void {
        let offset = 0;
        for (const token of tokens) {
            // Marked's public Token includes an open extension shape. Project
            // only the concrete built-in block shapes that this adapter owns.
            if (!Value.Check(blockSchema, token)) continue;

            const start = mapped.text.indexOf(token.raw, offset);
            if (start === -1) continue;

            const block = slice(source, mapped, start, start + token.raw.length);

            offset = start + token.raw.length;

            if (Value.Check(quoteSchema, token)) {
                walk(token.tokens, project(block, token.text), widthInset + 2);
            } else if (Value.Check(listSchema, token)) {
                const listInset = nestedList?.widthInset ?? widthInset;
                const listDepth = nestedList?.depth ?? 0;
                let itemOffset = 0;
                for (const [index, item] of token.items.entries()) {
                    const itemStart = block.text.indexOf(item.raw, itemOffset);
                    if (itemStart === -1) continue;
                    itemOffset = itemStart + item.raw.length;

                    const itemText = project(
                        slice(source, block, itemStart, itemOffset),
                        item.text,
                    );
                    let markerWidth = 2;
                    if (token.ordered && token.start !== "")
                        markerWidth = String(token.start + index).length + 2;

                    if (item.task) markerWidth += 4;

                    // Pi renders directly nested lists at four-space levels,
                    // not inside the preceding item's reduced content width.
                    walk(item.tokens, itemText, listInset + listDepth * 4 + markerWidth, {
                        widthInset: listInset,
                        depth: listDepth + 1,
                    });
                }
            } else if (Value.Check(codeSchema, token) && token.codeBlockStyle === "indented") {
                // Indented Markdown code has no language declaration. Treat it as an
                // unknown-language block (hold until complete), never as prose.
                const logical = project(block, token.text);
                const firstPosition = logical.positions.find((position) => position !== undefined);
                if (firstPosition === undefined) continue;

                const originalStart = lineStart(source, firstPosition);
                const prefix = source.slice(originalStart, firstPosition);

                result.push({
                    start: originalStart,
                    end: block.end,
                    opener: "",
                    closer: "",
                    code: token.text,
                    language: undefined,
                    closed: false,
                    complete: block.end < sourceContentEnd,
                    widthInset,
                    prefix,
                    originalCode: source.slice(originalStart, block.end),
                });
            } else if (Value.Check(codeSchema, token)) {
                const opening = /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/u.exec(token.raw);
                const marker = opening?.[1];
                const markerOffset = opening?.[0].indexOf(marker ?? "") ?? 0;
                const firstPosition = block.positions[markerOffset];
                if (opening === null || marker === undefined || firstPosition === undefined)
                    continue;

                const contentStart = opening[0].length;
                const character = marker[0] ?? "`";
                const closing = new RegExp(
                    `(?:^|\\n)( {0,3}${character}{${marker.length},}[ \\t]*)(?:\\n)?$`,
                    "u",
                ).exec(token.raw.slice(contentStart));
                let contentEnd = token.raw.length;
                let closer = "";
                let end = block.end;

                if (closing !== null) {
                    let closeStart = contentStart + closing.index;
                    if (token.raw[closeStart] === "\n") closeStart++;
                    contentEnd = closeStart;

                    const closeIndent = /^ */u.exec(closing[1] ?? "")?.[0].length ?? 0;
                    const closePosition = block.positions[closeStart + closeIndent];
                    if (closePosition !== undefined) {
                        const originalCloseStart = lineStart(source, closePosition);
                        end = lineEnd(source, closePosition);
                        closer = source.slice(originalCloseStart, end);
                    }
                }

                const originalStart = lineStart(source, firstPosition);
                const originalContentStart = lineEnd(source, firstPosition);
                const opener = source.slice(originalStart, originalContentStart);
                let originalContentEnd = end;
                if (closing !== null) originalContentEnd = end - closer.length;

                const body = slice(source, block, contentStart, contentEnd);
                const indent = /^ */u.exec(opening[0])?.[0] ?? "";
                const logicalBody = body.text.replace(
                    new RegExp(`^ {${indent.length}}`, "gmu"),
                    "",
                );
                let code = original(source, project(body, logicalBody));

                // Container tokenizers trim terminal whitespace. Recover those
                // real code characters, but not a blank line's quote markers.
                const last = body.positions.at(-1);
                let boundary = originalContentStart;
                if (last !== undefined) boundary = characterEnd(source, last);

                const tail = source.slice(boundary, originalContentEnd);
                const newline = /[\r\n]/u.exec(tail);
                if (newline === null) code += tail.replace(/>/gu, "");
                else {
                    const endOfLine = characterEnd(tail, newline.index);
                    code +=
                        tail.slice(0, endOfLine) + tail.slice(endOfLine).replace(/[^\r\n]/gu, "");
                }

                const prefix = source
                    .slice(originalStart, firstPosition)
                    .replace(/(?:[-+*]|\d{1,9}[.)])(?=[ \t])/gu, (bullet) =>
                        " ".repeat(bullet.length),
                    );

                result.push({
                    start: originalStart,
                    end,
                    opener,
                    closer,
                    code,
                    language: token.lang?.trim().split(/\s+/u)[0],
                    closed: closing !== null,
                    complete: closing !== null || end < sourceContentEnd,
                    widthInset,
                    prefix,
                    originalCode: source.slice(originalContentStart, originalContentEnd),
                });
            }
        }
    }

    walk(Lexer.lex(source), normalize(source), 0);

    return result;
}

export function displayFenceCode(fence: MarkdownFence, display: string): string {
    if (display === fence.code) return fence.originalCode;
    return display.replace(/(^|\r\n|\r|\n)(?=[\s\S])/gu, `$1${fence.prefix}`);
}
