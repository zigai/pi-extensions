export type ProseStreamingMode = "token" | "sentence" | "paragraph";

const ABBREVIATION =
    /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|fig|no|inc|approx|dept|vol)|\b(?:e\.g|i\.e)|\b[A-Z]|(?:\b[A-Za-z]\.)+[A-Za-z])\.$/iu;

const sentenceSegments = new Intl.Segmenter(undefined, { granularity: "sentence" });

function sentenceEnd(source: string): number {
    const candidates = new Map<number, number>();
    for (const segment of sentenceSegments.segment(source)) {
        const terminal = /[.!?。！？][.!?。！？"'”’)*_~]*\s*$/u.exec(segment.segment);
        if (terminal === null) continue;

        const end = segment.index + segment.segment.length;
        if (end === source.length && !/\s$/u.test(segment.segment)) continue;
        candidates.set(segment.index + terminal.index, end);
    }

    // ICU treats lowercase continuations as abbreviation candidates; streaming
    // still releases explicit punctuation plus whitespace unless our abbreviation policy holds it.
    for (const terminal of source.matchAll(/[.!?][.!?"'”’)*_~]*\s+/gu)) {
        candidates.set(terminal.index, terminal.index + terminal[0].length);
    }

    let boundary = 0;
    let ticks = 0;
    let brackets = 0;
    let parentheses = 0;

    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (character === "\\") {
            index++;
            continue;
        }

        if (character === "`") {
            let end = index + 1;
            while (source[end] === "`") end++;
            const count = end - index;
            if (ticks === 0) ticks = count;
            else if (ticks === count) ticks = 0;

            index = end - 1;
            continue;
        }

        if (ticks !== 0) continue;
        if (character === "[") brackets++;
        if (character === "]") brackets = Math.max(0, brackets - 1);
        if (character === "(") parentheses++;
        if (character === ")") parentheses = Math.max(0, parentheses - 1);
        if (brackets !== 0 || parentheses !== 0) continue;

        const end = candidates.get(index);
        if (end === undefined) continue;
        if (character === "." && ABBREVIATION.test(source.slice(0, index + 1))) continue;

        boundary = end;
        index = end - 1;
    }

    return boundary;
}

function paragraphEnd(source: string): number {
    let offset = 0;
    let boundary = 0;
    let content = false;
    let blankAfterContent = false;
    let listIndent: number | undefined;
    const lines = source.match(/[^\n]*\n|[^\n]+$/gu) ?? [];

    for (const line of lines) {
        const body = line.replace(/\r?\n$/u, "");
        if (/^[ \t]*$/u.test(body)) {
            if (content && line.endsWith("\n")) {
                boundary = offset + line.length;
                blankAfterContent = true;
                listIndent = undefined;
            }

            offset += line.length;
            continue;
        }

        const heading = /^ {0,3}#{1,6}(?:\s|$)/u.test(body);
        const item = /^(\s*)(?:[-+*]|\d+[.)])\s+\S/u.exec(body);
        if (item !== null) {
            const indent = item[1]?.length ?? 0;
            if (content && listIndent !== undefined && indent <= listIndent) boundary = offset;
            listIndent = indent;
        } else if (heading) {
            if (content) boundary = offset;
            content = false;
            listIndent = undefined;
        } else if (blankAfterContent) {
            content = false;
            listIndent = undefined;
        }

        if (!heading) content = true;
        blankAfterContent = false;
        offset += line.length;
    }

    return boundary;
}

/** Returns a raw-source prefix. Persisted messages are never transformed here. */
export function revealProse(source: string, mode: ProseStreamingMode, complete: boolean): string {
    if (complete || mode === "token") return source;
    if (mode === "sentence")
        return source.slice(0, Math.max(sentenceEnd(source), paragraphEnd(source)));

    return source.slice(0, paragraphEnd(source));
}
