const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")", "}", "]"]);

export type ChainDefinition = {
    readonly id: string;
    readonly trigger: string;
    readonly separator?: string;
};

export type ParsedChain = {
    readonly sourceId: string;
    readonly trigger: string;
    readonly start: number;
    readonly end: number;
    readonly segments: readonly string[];
    readonly complete: boolean;
};

export type ChainSegmentSpan = {
    readonly index: number;
    readonly start: number;
    readonly end: number;
    readonly contentStart: number;
    readonly contentEnd: number;
    readonly value: string;
    readonly quoted: boolean;
    readonly complete: boolean;
};

export type ActiveChainSegment = {
    readonly chain: ParsedChain;
    readonly separator: string;
    readonly index: number;
    readonly query: string;
    readonly path: readonly string[];
    readonly start: number;
    readonly end: number;
    readonly ownedEnd: number;
    readonly span: ChainSegmentSpan;
};

type ParsedChainWithSpans = {
    readonly chain: ParsedChain;
    readonly separator: string;
    readonly spans: readonly ChainSegmentSpan[];
};

function separatorOf(definition: ChainDefinition): string {
    return definition.separator ?? ":";
}

function assertDefinitions(definitions: readonly ChainDefinition[]): void {
    const triggers = new Set<string>();
    for (const definition of definitions) {
        if (definition.id.length === 0) throw new Error("Mention source id must not be empty.");
        if (definition.trigger.length === 0) throw new Error("Mention trigger must not be empty.");

        if (separatorOf(definition).length === 0) {
            throw new Error(`Mention separator for ${definition.id} must not be empty.`);
        }

        if (triggers.has(definition.trigger)) {
            throw new Error(`Duplicate mention trigger: ${definition.trigger}`);
        }

        triggers.add(definition.trigger);
    }
}

export function isTriggerBoundary(text: string, start: number): boolean {
    if (start <= 0) return true;

    const previous = text.at(start - 1);
    if (previous === undefined) return true;
    return !/[\p{L}\p{N}_\\]/u.test(previous);
}

function decodeEscapes(value: string): string {
    let decoded = "";
    for (let index = 0; index < value.length; index += 1) {
        const character = value.at(index);
        if (character === "\\" && index + 1 < value.length) {
            decoded += value[index + 1];
            index += 1;
        } else if (character !== undefined) {
            decoded += character;
        }
    }

    return decoded;
}

function parseChainAt(
    text: string,
    start: number,
    definition: ChainDefinition,
): ParsedChainWithSpans {
    const separator = separatorOf(definition);
    const bodyStart = start + definition.trigger.length;
    const spans: ChainSegmentSpan[] = [];
    const segments: string[] = [];
    let cursor = bodyStart;
    let expectsSegment = true;
    let syntaxComplete = true;

    while (cursor < text.length) {
        const first = text.at(cursor);
        if (first === undefined || /\s/u.test(first)) break;

        const segmentStart = cursor;
        let contentStart = cursor;
        let contentEnd = cursor;
        let segmentEnd = cursor;
        let value = "";
        let quoted = false;
        let segmentComplete = true;

        if (first === '"') {
            quoted = true;
            contentStart = cursor + 1;
            cursor += 1;

            let closed = false;
            while (cursor < text.length) {
                const character = text.at(cursor);
                if (character === "\\" && cursor + 1 < text.length) {
                    const escaped = text.at(cursor + 1);
                    if (escaped !== undefined) value += escaped;
                    cursor += 2;
                    continue;
                }

                if (character === '"') {
                    contentEnd = cursor;
                    cursor += 1;
                    closed = true;
                    break;
                }

                if (character === undefined || character === "\n" || character === "\r") break;

                value += character;
                cursor += 1;
            }

            if (!closed) {
                contentEnd = cursor;
                segmentComplete = false;
                syntaxComplete = false;
            }

            segmentEnd = cursor;
        } else {
            while (cursor < text.length) {
                const character = text.at(cursor);
                if (character === undefined || /\s/u.test(character)) break;
                if (text.startsWith(separator, cursor)) break;

                if (character === "\\" && cursor + 1 < text.length) {
                    cursor += 2;
                    continue;
                }

                cursor += 1;
            }

            segmentEnd = cursor;
            contentEnd = cursor;

            let raw = text.slice(contentStart, contentEnd);
            while (raw.length > 0) {
                const last = raw.at(-1);
                let precedingBackslashes = 0;
                for (let index = raw.length - 2; index >= 0 && raw[index] === "\\"; index -= 1) {
                    precedingBackslashes += 1;
                }

                const escaped = precedingBackslashes % 2 === 1;
                if (last === undefined || escaped || !TRAILING_PUNCTUATION.has(last)) break;

                raw = raw.slice(0, -1);
                cursor -= 1;
                segmentEnd -= 1;
                contentEnd -= 1;
            }

            value = decodeEscapes(raw);
        }

        if (segmentEnd === segmentStart && !quoted) break;

        spans.push({
            index: spans.length,
            start: segmentStart,
            end: segmentEnd,
            contentStart,
            contentEnd,
            value,
            quoted,
            complete: segmentComplete,
        });

        segments.push(value);
        expectsSegment = false;

        if (!segmentComplete || !text.startsWith(separator, cursor)) break;

        cursor += separator.length;
        expectsSegment = true;
    }

    const end = cursor;
    const complete = segments.length > 0 && !expectsSegment && syntaxComplete;

    return {
        chain: {
            sourceId: definition.id,
            trigger: definition.trigger,
            start,
            end,
            segments,
            complete,
        },
        separator,
        spans,
    };
}

function parseMentionsWithSpans(
    text: string,
    definitions: readonly ChainDefinition[],
): readonly ParsedChainWithSpans[] {
    assertDefinitions(definitions);

    const ordered = [...definitions].sort(
        (left, right) => right.trigger.length - left.trigger.length,
    );
    const parsed: ParsedChainWithSpans[] = [];

    for (let index = 0; index < text.length;) {
        let definition: ChainDefinition | undefined;
        for (const candidate of ordered) {
            if (text.startsWith(candidate.trigger, index) && isTriggerBoundary(text, index)) {
                definition = candidate;
                break;
            }
        }

        if (definition === undefined) {
            index += 1;
            continue;
        }

        const mention = parseChainAt(text, index, definition);
        parsed.push(mention);
        index = Math.max(index + definition.trigger.length, mention.chain.end);
    }

    return parsed;
}

/** Parses registered mention chains without resolving their provider-owned segment values. */
export function parseMentions(
    text: string,
    definitions: readonly ChainDefinition[],
): readonly ParsedChain[] {
    return parseMentionsWithSpans(text, definitions).map((parsed) => parsed.chain);
}

function queryThroughCursor(text: string, span: ChainSegmentSpan, cursor: number): string {
    const through = Math.min(Math.max(cursor, span.contentStart), span.contentEnd);
    return decodeEscapes(text.slice(span.contentStart, through));
}

/** Finds the segment edited at an absolute cursor and the chain suffix that completion owns. */
export function activeChainSegment(
    text: string,
    definitions: readonly ChainDefinition[],
    cursor: number,
): ActiveChainSegment | undefined {
    for (const parsed of parseMentionsWithSpans(text, definitions)) {
        const bodyStart = parsed.chain.start + parsed.chain.trigger.length;
        if (cursor < bodyStart || cursor > parsed.chain.end) continue;

        for (const span of parsed.spans) {
            if (cursor < span.start || cursor > span.end) continue;
            return {
                chain: parsed.chain,
                separator: parsed.separator,
                index: span.index,
                query: queryThroughCursor(text, span, cursor),
                path: parsed.chain.segments.slice(0, span.index),
                start: span.start,
                end: span.end,
                ownedEnd: parsed.chain.end,
                span,
            };
        }

        const index = parsed.spans.length;
        const emptySpan: ChainSegmentSpan = {
            index,
            start: cursor,
            end: cursor,
            contentStart: cursor,
            contentEnd: cursor,
            value: "",
            quoted: false,
            complete: false,
        };

        return {
            chain: parsed.chain,
            separator: parsed.separator,
            index,
            query: "",
            path: parsed.chain.segments,
            start: cursor,
            end: cursor,
            ownedEnd: parsed.chain.end,
            span: emptySpan,
        };
    }

    return undefined;
}

function formatSegment(segment: string, separator: string): string {
    if (
        segment.length > 0 &&
        !segment.includes(separator) &&
        !/[\s"\\]/u.test(segment) &&
        !TRAILING_PUNCTUATION.has(segment[segment.length - 1] ?? "")
    ) {
        return segment;
    }

    return `"${segment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Formats independently quoted chain segments using the same grammar as parseMentions. */
export function formatChain(segments: readonly string[], trigger: string, separator = ":"): string {
    if (trigger.length === 0) throw new Error("Mention trigger must not be empty.");
    if (separator.length === 0) throw new Error("Mention separator must not be empty.");
    return `${trigger}${segments.map((segment) => formatSegment(segment, separator)).join(separator)}`;
}
