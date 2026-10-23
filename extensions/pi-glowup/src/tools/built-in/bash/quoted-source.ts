import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sgrSequenceEnd } from "../../../text-boundaries.ts";

export function highlightDoubleQuotedSource(
    source: string,
    highlight: (code: string) => string[],
): string[] {
    if (!source.includes("\\")) return highlight(source);

    const sourceCharacters: string[] = [];
    let code = "";
    let continuation = "";
    for (const match of source.matchAll(/\\(?:["$`\\]|\n)|[\s\S]/gu)) {
        const raw = match[0];
        if (raw === "\\\n") {
            continuation += raw;
            continue;
        }

        sourceCharacters.push(continuation + raw);
        continuation = "";

        if (raw.startsWith("\\") && raw.length > 1) {
            code += raw.slice(1);
        } else {
            code += raw;
        }
    }

    const highlighted = highlight(code).join("\n");
    let index = 0;
    let sequenceEnd = 0;
    let rendered = "";

    for (const match of highlighted.matchAll(/[\s\S]/gu)) {
        if (match.index < sequenceEnd) continue;

        const end = sgrSequenceEnd(highlighted, match.index);
        if (end !== undefined) {
            rendered += highlighted.slice(match.index, end);
            sequenceEnd = end;
            continue;
        }

        const original = sourceCharacters[index];
        if (original === undefined) throw new Error("Nested Bash highlighting changed source text");

        index += 1;
        rendered += original;
    }

    if (index !== sourceCharacters.length)
        throw new Error("Nested Bash highlighting changed source text");

    return wrapTextWithAnsi(rendered + continuation, Number.POSITIVE_INFINITY);
}
