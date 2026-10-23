import type { HighlighterGeneric } from "shiki";

export function compactPythonStructuralBlankRows(
    code: string,
    grammar: ReturnType<HighlighterGeneric<string, string>["getLanguage"]>,
): string {
    let state: ReturnType<typeof grammar.tokenizeLine>["ruleStack"] | null = null;
    const rows = code.split("\n").map((text) => {
        const rootBefore = state === null || state.depth === 1;
        const result = grammar.tokenizeLine(text, state);
        state = result.ruleStack;

        return {
            text,
            blank: /^[\t ]*$/u.test(text),
            root: rootBefore && state.depth === 1,
            comment: result.tokens.some((token) =>
                token.scopes.some((scope) => scope.startsWith("comment.")),
            ),
        };
    });
    const retained: string[] = [];
    let cursor = 0;
    while (cursor < rows.length) {
        const row = rows[cursor];
        if (row === undefined) break;

        if (!row.blank) {
            retained.push(row.text);
            cursor += 1;
            continue;
        }

        const start = cursor;
        let root = true;
        while (rows[cursor]?.blank === true) {
            root &&= rows[cursor]?.root === true;
            cursor += 1;
        }

        const previous = rows[start - 1];
        const next = rows[cursor];
        if (
            root &&
            previous !== undefined &&
            !previous.comment &&
            next !== undefined &&
            !next.comment &&
            /^\S/u.test(next.text)
        )
            continue;

        retained.push(...rows.slice(start, cursor).map((blank) => blank.text));
    }

    return retained.join("\n");
}
