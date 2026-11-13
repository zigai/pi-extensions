import type { ThemedToken } from "shiki";
import { SYNTAX_ACCENT_COLORS } from "./palette.ts";

const BRACKET_PAIR_COLORS = SYNTAX_ACCENT_COLORS.bracketPair;
const BRACKET_COLORABLE_FOREGROUNDS = new Set<string>(SYNTAX_ACCENT_COLORS.neutralForegrounds);
const PYTHON_IMPORT_IDENTIFIER_COLOR = SYNTAX_ACCENT_COLORS.pythonImportIdentifier;
const PYTHON_CONSTANT_IDENTIFIER_COLOR = SYNTAX_ACCENT_COLORS.pythonConstantIdentifier;
const PYTHON_VARIABLE_IDENTIFIER_COLOR = SYNTAX_ACCENT_COLORS.pythonVariableIdentifier;
const PYTHON_FUNCTION_IDENTIFIER_COLOR = SYNTAX_ACCENT_COLORS.pythonFunctionIdentifier;
const OPEN_BRACKETS = new Set(["(", "[", "{"]);
const CLOSE_BRACKETS = new Set([")", "]", "}"]);

let bracketPairColoringEnabled = true;

type BracketState = {
    depth: number;
};

type TextSegment = {
    readonly text: string;
    readonly fg?: string;
};

/** Enables or disables bracket-pair foreground overrides without changing syntax token colors. */
export function configureBracketPairColoring(enabled: boolean): boolean {
    if (bracketPairColoringEnabled === enabled) {
        return false;
    }

    bracketPairColoringEnabled = enabled;
    return true;
}

/** Applies VS Code-like bracket pair colors to otherwise-neutral punctuation tokens. */
export function colorBracketPairsInTokenRows(
    rows: ReadonlyArray<ReadonlyArray<ThemedToken>>,
    language?: string,
): ThemedToken[][] {
    const state: BracketState = { depth: 0 };
    let imported: ReadonlySet<string> = new Set();
    if (language === "python")
        imported = pythonImportedNames(
            rows.map((row) => row.map((token) => token.content).join("")),
        );

    return rows.map((row) =>
        colorPythonIdentifiersInTokens(row, language, imported).flatMap((token) =>
            splitBracketText(token.content, token.color, state).map((part) => {
                const coloredToken = { ...token, content: part.text };
                return part.color === undefined
                    ? coloredToken
                    : { ...coloredToken, color: part.color };
            }),
        ),
    );
}

/** Applies VS Code-like terminal syntax enhancements to already-flattened highlighted spans. */
export function enhanceSyntaxSegments<TSegment extends TextSegment>(
    segments: ReadonlyArray<TSegment>,
    language?: string,
): TSegment[] {
    const state: BracketState = { depth: 0 };

    return colorPythonIdentifiersInSegments(segments, language).flatMap((segment) =>
        splitBracketText(segment.text, segment.fg, state).map((part) => {
            const coloredSegment = { ...segment, text: part.text };
            return part.color === undefined
                ? coloredSegment
                : { ...coloredSegment, fg: part.color };
        }),
    );
}

function colorPythonIdentifiersInTokens(
    row: ReadonlyArray<ThemedToken>,
    language: string | undefined,
    imported: ReadonlySet<string>,
): ThemedToken[] {
    if (language !== "python") {
        return [...row];
    }

    const line = row.map((token) => token.content).join("");

    return row.flatMap((token) =>
        splitPythonIdentifiers(token.content, token.color, line, imported).map((part) => {
            const coloredToken = { ...token, content: part.text };
            return part.color === undefined ? coloredToken : { ...coloredToken, color: part.color };
        }),
    );
}

function colorPythonIdentifiersInSegments<TSegment extends TextSegment>(
    segments: ReadonlyArray<TSegment>,
    language: string | undefined,
): TSegment[] {
    if (language !== "python") {
        return [...segments];
    }

    const line = segments.map((segment) => segment.text).join("");

    return segments.flatMap((segment) =>
        splitPythonIdentifiers(segment.text, segment.fg, line, new Set()).map((part) => {
            const coloredSegment = { ...segment, text: part.text };
            return part.color === undefined
                ? coloredSegment
                : { ...coloredSegment, fg: part.color };
        }),
    );
}

function splitPythonIdentifiers(
    text: string,
    foreground: string | undefined,
    line: string,
    imported: ReadonlySet<string>,
): Array<{ readonly text: string; readonly color?: string }> {
    if (!isBracketColorableForeground(foreground)) {
        return [{ text }];
    }

    const importLine = isPythonImportLine(line);
    const parts: Array<{ readonly text: string; readonly color?: string }> = [];
    let index = 0;
    for (const match of text.matchAll(/[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/gu)) {
        const start = match.index;
        let value = match[0];

        if (start > index) {
            parts.push({ text: text.slice(index, start) });
        }

        const head = value.split(".", 1)[0] ?? value;
        const attribute = start > 0 && text[start - 1] === ".";
        if (!importLine && !attribute && imported.has(head)) {
            parts.push({ text: head, color: PYTHON_IMPORT_IDENTIFIER_COLOR });
            index = start + head.length;
            if (value === head) continue;

            parts.push({ text: "." });
            index += 1;
            value = value.slice(head.length + 1);
        }

        const end = start + match[0].length;
        parts.push({
            text: value,
            color: pythonIdentifierColor(value, text.slice(end), importLine),
        });
        index = end;
    }

    if (index < text.length) {
        parts.push({ text: text.slice(index) });
    }

    return parts.length > 0 ? parts : [{ text }];
}

function pythonIdentifierColor(value: string, suffix: string, importLine: boolean): string {
    if (importLine) {
        return PYTHON_IMPORT_IDENTIFIER_COLOR;
    }

    if (/^[A-Z_][A-Z0-9_]*$/u.test(value)) {
        return PYTHON_CONSTANT_IDENTIFIER_COLOR;
    }

    if (/^\s*\(/u.test(suffix)) {
        return PYTHON_FUNCTION_IDENTIFIER_COLOR;
    }

    return PYTHON_VARIABLE_IDENTIFIER_COLOR;
}

function pythonImportedNames(lines: readonly string[]): ReadonlySet<string> {
    const names = new Set<string>();
    let continued = false;
    for (const line of lines) {
        let list: string | undefined;
        if (continued) list = line;
        else {
            const plain = /^\s*import\s+(.+)$/u.exec(line);
            const from = /^\s*from\s+\S+\s+import\s+(.+)$/u.exec(line);
            list = plain?.[1] ?? from?.[1];
        }

        if (list === undefined) continue;

        const code = list.replace(/#.*$/u, "");
        continued = (continued || code.includes("(")) && !code.includes(")");
        for (const item of code.replace(/[()\\]/gu, "").split(",")) {
            const binding = /^\s*([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/u.exec(item);
            if (binding === null) continue;

            names.add(binding[2] ?? binding[1]?.split(".", 1)[0] ?? "");
        }
    }

    names.delete("");
    return names;
}

function isPythonImportLine(text: string): boolean {
    return /^\s*(?:from\s+\S+\s+import\s+\S+|import\s+\S+)/u.test(text);
}

function splitBracketText(
    text: string,
    foreground: string | undefined,
    state: BracketState,
): Array<{ readonly text: string; readonly color?: string }> {
    if (text.length === 0) {
        return [];
    }

    if (
        !bracketPairColoringEnabled ||
        !isBracketColorableForeground(foreground) ||
        !hasBracket(text)
    ) {
        return [{ text }];
    }

    const parts: Array<{ readonly text: string; readonly color?: string }> = [];
    let plain = "";
    for (const char of text) {
        if (!isBracket(char)) {
            plain += char;
            continue;
        }

        if (plain.length > 0) {
            parts.push({ text: plain });
            plain = "";
        }

        parts.push({ text: char, color: bracketColor(char, state) });
    }

    if (plain.length > 0) {
        parts.push({ text: plain });
    }

    return parts;
}

function bracketColor(char: string, state: BracketState): string {
    if (CLOSE_BRACKETS.has(char)) {
        state.depth = Math.max(0, state.depth - 1);
        return (
            BRACKET_PAIR_COLORS[state.depth % BRACKET_PAIR_COLORS.length] ?? BRACKET_PAIR_COLORS[0]
        );
    }

    const color =
        BRACKET_PAIR_COLORS[state.depth % BRACKET_PAIR_COLORS.length] ?? BRACKET_PAIR_COLORS[0];

    if (OPEN_BRACKETS.has(char)) {
        state.depth += 1;
    }

    return color;
}

function hasBracket(text: string): boolean {
    return /[()[\]{}]/u.test(text);
}

function isBracket(char: string): boolean {
    return OPEN_BRACKETS.has(char) || CLOSE_BRACKETS.has(char);
}

function isBracketColorableForeground(foreground: string | undefined): boolean {
    if (foreground === undefined) {
        return true;
    }

    return BRACKET_COLORABLE_FOREGROUNDS.has(foreground.toLowerCase());
}
