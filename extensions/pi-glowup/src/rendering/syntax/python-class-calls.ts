import type {
    DynamicImportLanguageRegistration,
    HighlighterGeneric,
    LanguageRegistration,
    ThemedToken,
    ThemeRegistration,
} from "shiki";

// The Python grammar scopes `PluginError(...)` like any other call, so themes leave the name
// uncolored. Editors color it as a class only through language-server semantic tokens. This
// injection gives PascalCase callees the scope VS Code maps class semantic tokens to, so the
// active theme's type color applies. `\G` anchors the match to the start of the call region,
// which keeps nested calls and keyword arguments under the stock grammar rules. A grammar sees
// one call at a time, so PascalCase functions defined with `def` in the shown code are drawn
// back in the plain call color afterwards.
const pythonClassCalls: LanguageRegistration = {
    name: "python-class-calls",
    scopeName: "source.python.class-calls",
    injectTo: ["source.python", "text.html.markdown"],
    injectionSelector: "L:meta.function-call.python",
    patterns: [{ match: "\\G[A-Z]\\w*[a-z]\\w*\\b", name: "entity.name.type.class.python" }],
    repository: {},
};

/** Bundled languages with Python loading its class-call injection alongside it. */
export function withPythonClassCalls<
    TLanguages extends Readonly<Record<"python", DynamicImportLanguageRegistration>>,
>(languages: TLanguages) {
    const python = languages.python;
    const load: DynamicImportLanguageRegistration = async () => ({
        default: [...(await python()).default, pythonClassCalls],
    });

    return { ...languages, python: load, py: load };
}

export type PythonCallColors = {
    readonly classCall: string;
    readonly functionCall: string;
};

const FUNCTION_DEFINITION = /^\s*(?:async\s+)?def\s+([A-Z]\w*[a-z]\w*)\s*\(/u;
const CLASS_DEFINITION = /^\s*class\s+([A-Z]\w*[a-z]\w*)\b/u;
const PASCAL_CASE_NAME = /[A-Z]\w*[a-z]\w*/gu;
const CALL_OPENING = /\s*\(/uy;
const WORD_CHARACTER = /\w/u;

/** PascalCase names the code defines with `def` and never with `class`. */
export function pythonFunctionNames(lines: Iterable<string>): ReadonlySet<string> {
    const functions = new Set<string>();
    const classes = new Set<string>();
    for (const line of lines) {
        const definedFunction = FUNCTION_DEFINITION.exec(line)?.[1];
        if (definedFunction !== undefined) {
            functions.add(definedFunction);
            continue;
        }

        const definedClass = CLASS_DEFINITION.exec(line)?.[1];
        if (definedClass !== undefined) classes.add(definedClass);
    }

    for (const name of classes) functions.delete(name);

    return functions;
}

/** The theme's colors for a PascalCase call and a plain call, or undefined when they match. */
export function pythonCallColors(
    syntax: HighlighterGeneric<string, string>,
    theme: ThemeRegistration,
): PythonCallColors | undefined {
    const [plainRow, pascalRow] = syntax.codeToTokensBase("call()\nCall()", {
        lang: "python",
        theme,
    });
    const functionCall = plainRow?.find((token) => token.content.includes("call"))?.color;
    const classCall = pascalRow?.find((token) => token.content === "Call")?.color;
    if (functionCall === undefined || classCall === undefined) return undefined;
    if (sameColor(functionCall, classCall)) return undefined;

    return { classCall, functionCall };
}

export function sameColor(left: string | undefined, right: string | undefined): boolean {
    return left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase();
}

/** Ranges of calls to `names` that lie inside `[start, end)` of `line`. */
export function functionCallRanges(
    line: string,
    start: number,
    end: number,
    names: ReadonlySet<string>,
): Array<readonly [number, number]> {
    const ranges: Array<readonly [number, number]> = [];
    PASCAL_CASE_NAME.lastIndex = start;
    for (
        let match = PASCAL_CASE_NAME.exec(line);
        match !== null && match.index < end;
        match = PASCAL_CASE_NAME.exec(line)
    ) {
        const matchEnd = match.index + match[0].length;
        if (matchEnd > end) break;
        if (!names.has(match[0])) continue;
        if (WORD_CHARACTER.test(line[match.index - 1] ?? "")) continue;

        if (opensCall(line, matchEnd)) ranges.push([match.index, matchEnd]);
    }

    return ranges;
}

function opensCall(line: string, index: number): boolean {
    CALL_OPENING.lastIndex = index;
    return CALL_OPENING.test(line);
}

/** Draws calls to PascalCase functions defined in the shown code in the plain call color. */
export function recolorPythonFunctionCalls(
    syntax: HighlighterGeneric<string, string>,
    rows: ThemedToken[][],
    theme: ThemeRegistration,
): ThemedToken[][] {
    const lines = rows.map((row) => row.map((token) => token.content).join(""));
    const names = pythonFunctionNames(lines);
    if (names.size === 0) return rows;

    const colors = pythonCallColors(syntax, theme);
    if (colors === undefined) return rows;

    return rows.map((row, index) => recolorRow(row, lines[index] ?? "", names, colors));
}

function recolorRow(
    row: ThemedToken[],
    line: string,
    names: ReadonlySet<string>,
    colors: PythonCallColors,
): ThemedToken[] {
    const recolored: ThemedToken[] = [];
    let start = 0;
    for (const token of row) {
        const end = start + token.content.length;
        let ranges: Array<readonly [number, number]> = [];
        if (sameColor(token.color, colors.classCall))
            ranges = functionCallRanges(line, start, end, names);

        if (ranges.length === 0) {
            appendToken(recolored, token);
            start = end;
            continue;
        }

        let cursor = start;
        const part = (from: number, to: number, color: string | undefined): void => {
            const piece: ThemedToken = {
                ...token,
                content: line.slice(from, to),
                offset: token.offset + from - start,
            };
            if (color !== undefined) piece.color = color;
            appendToken(recolored, piece);
        };

        for (const [rangeStart, rangeEnd] of ranges) {
            if (rangeStart > cursor) part(cursor, rangeStart, token.color);
            part(rangeStart, rangeEnd, colors.functionCall);
            cursor = rangeEnd;
        }

        if (cursor < end) part(cursor, end, token.color);
        start = end;
    }

    return recolored;
}

// Shiki merges neighbors of one style, and later passes read a call's `(` from the same token.
function appendToken(tokens: ThemedToken[], token: ThemedToken): void {
    const previous = tokens.at(-1);
    if (
        previous === undefined ||
        !sameColor(previous.color, token.color) ||
        previous.fontStyle !== token.fontStyle
    ) {
        tokens.push(token);
        return;
    }

    tokens[tokens.length - 1] = { ...previous, content: previous.content + token.content };
}
