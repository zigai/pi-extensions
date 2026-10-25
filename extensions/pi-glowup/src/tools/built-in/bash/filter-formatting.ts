import { visibleWidth } from "@earendil-works/pi-tui";
import type { ScriptFormatterProfile } from "../../../settings-input.ts";

export type FilterFormatterProfile = Extract<ScriptFormatterProfile, { kind: "awk" | "jq" }>;

/** One formatter process result; `output` is undefined when the process did not succeed. */
export type FilterRunResult = { readonly output: string | undefined };

/** Runs the configured formatter executable with extra argv and the program on stdin. */
export type FilterFormatterRun<R extends FilterRunResult> = (
    args: readonly string[],
    input: string,
) => Promise<R>;

/** Why a program is kept as submitted without running the formatter. */
export type FilterSkipReason =
    | "empty"
    | "fits-width"
    | "unparsable"
    | "comment"
    | "defs"
    | "load-directive";

/**
 * Formatting result. `declined` means a safety rule kept the submitted program; `run-failed`
 * means the formatter process itself produced no output. `run` is the last process result.
 */
export type FilterFormatResult<R extends FilterRunResult> =
    | { readonly kind: "formatted"; readonly output: string; readonly run: R }
    | { readonly kind: "unchanged"; readonly detail?: string; readonly run?: R }
    | { readonly kind: "declined"; readonly detail: string; readonly run?: R }
    | { readonly kind: "run-failed"; readonly run: R };

export type FilterLayout = {
    /** Columns available to every program row, measured from the row's base indentation. */
    readonly width: number;

    /** Columns already used before the program's first row, such as `jq -r '`. */
    readonly firstLineOffset: number;
};

const DEFAULT_COMMANDS = { awk: ["gawk"], jq: ["jqfmt"] } as const;

// Pretty-print only: gawk parses without running BEGIN or rules. The sandbox is a second
// fence against extension loading; programs naming @load/@include are never sent.
const GAWK_PRETTY_PRINT_ARGS = ["--sandbox", "-o-", "-f", "-"];

// Least to most exploded; the first layout that fits wins, otherwise the last. jqfmt breaks
// every pipe, including those nested in parentheses or brackets; those are joined back.
const JQ_LAYOUTS: readonly (readonly string[])[] = [
    ["-op", "pipe"],
    ["-op", "pipe", "-ob"],
    ["-op", "pipe", "-ob", "-ar"],
];

export function filterFormatterCommand(profile: FilterFormatterProfile): readonly string[] {
    return profile.command ?? DEFAULT_COMMANDS[profile.kind];
}

function rowsWidth(code: string, layout: FilterLayout): number {
    const rows = code.split("\n");
    let width = 0;
    for (const [index, row] of rows.entries()) {
        let used = visibleWidth(row);
        if (index === 0) used += layout.firstLineOffset;

        // The closing quote follows the final row.
        if (index === rows.length - 1) used += 1;
        width = Math.max(width, used);
    }

    return width;
}

/** True when the submitted program already fits; such programs are never reflowed. */
export function filterProgramFits(code: string, layout: FilterLayout): boolean {
    return rowsWidth(code, layout) <= layout.width;
}

type Masked = {
    readonly text: string;
    readonly originals: ReadonlyMap<string, string>;
};

function placeholderPrefix(source: string): string {
    let letter = 71;
    while (source.includes(`__${String.fromCharCode(letter)}`)) letter += 1;

    return `__${String.fromCharCode(letter)}`;
}

function unmask(text: string, masked: Masked): string | undefined {
    let result = text;

    for (const [placeholder, original] of masked.originals) {
        const first = result.indexOf(placeholder);
        if (first < 0 || result.includes(placeholder, first + 1)) return undefined;

        result = result.slice(0, first) + original + result.slice(first + placeholder.length);
    }

    return result;
}

function reindent(rows: readonly string[], unit: number, indentWidth: number): string[] {
    return rows.map((row) => {
        let index = 0;
        let columns = 0;
        while (row[index] === "\t" || row[index] === " ") {
            if (row[index] === "\t") columns += unit;
            else columns += 1;

            index += 1;
        }

        const levels = Math.round(columns / unit);
        return " ".repeat(levels * indentWidth) + row.slice(index);
    });
}

function normalizedRows(output: string): string[] {
    return output
        .replace(/\r\n?/gu, "\n")
        .split("\n")
        .map((row) => row.replace(/[\t ]+$/u, ""))
        .filter((row) => row.length > 0);
}

// ---------------------------------------------------------------- awk

type AwkToken = {
    readonly kind: "string" | "regex" | "comment" | "number" | "name" | "op";
    readonly text: string;
    readonly start: number;
    readonly end: number;
};

const AWK_OPERATORS = [
    "**=",
    "&&",
    "||",
    "==",
    "!=",
    "<=",
    ">=",
    "!~",
    "++",
    "--",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "^=",
    "**",
    ">>",
    "|&",
    "::",
];

const AWK_REGEX_AFTER_NAMES = new Set(["print", "printf", "return", "case"]);
const AWK_DIVISION_AFTER_OPERATORS = new Set([")", "]", "$", "++", "--"]);

function awkRegexAllowed(previous: AwkToken | undefined): boolean {
    if (previous === undefined) return true;
    if (previous.kind === "op") return !AWK_DIVISION_AFTER_OPERATORS.has(previous.text);
    if (previous.kind === "name") return AWK_REGEX_AFTER_NAMES.has(previous.text);
    return previous.kind === "comment";
}

function awkDelimitedEnd(source: string, start: number, delimiter: string): number | undefined {
    let index = start + 1;
    let bracket = false;
    while (index < source.length) {
        const char = source[index];
        if (char === "\n") return undefined;

        if (char === "\\") {
            index += 2;
            continue;
        }

        if (delimiter === "/" && char === "[" && !bracket) {
            bracket = true;
            index += 1;

            // A leading `]` (after an optional `^`) is literal inside a bracket expression.
            if (source[index] === "^") index += 1;
            if (source[index] === "]") index += 1;
            continue;
        }

        if (bracket && char === "[" && source[index + 1] === ":") {
            const close = source.indexOf(":]", index + 2);
            if (close < 0) return undefined;

            index = close + 2;
            continue;
        }

        if (bracket && char === "]") bracket = false;
        else if (!bracket && char === delimiter) return index + 1;

        index += 1;
    }

    return undefined;
}

/** Newlines and semicolons separate statements; gawk replaces one with the other. */
function tokenizeAwk(source: string): AwkToken[] | undefined {
    const tokens: AwkToken[] = [];
    let index = 0;
    while (index < source.length) {
        const char = source[index] ?? "";
        if (char === "\\" && (source[index + 1] === "\n" || source[index + 1] === "\r")) {
            index += 2;
            continue;
        }

        if (/\s/u.test(char) || char === ";") {
            index += 1;
            continue;
        }

        const start = index;
        let kind: AwkToken["kind"];
        if (char === "#") {
            index = source.indexOf("\n", index);
            if (index < 0) index = source.length;
            kind = "comment";
        } else if (char === '"') {
            const end = awkDelimitedEnd(source, index, '"');
            if (end === undefined) return undefined;

            index = end;
            kind = "string";
        } else if (char === "/" && awkRegexAllowed(tokens.at(-1))) {
            const end = awkDelimitedEnd(source, index, "/");
            if (end === undefined) return undefined;

            index = end;
            kind = "regex";
        } else {
            const rest = source.slice(index);
            const number = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/u.exec(
                rest,
            );
            const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(rest);
            const operator = AWK_OPERATORS.find((candidate) => rest.startsWith(candidate));
            if (number !== null) {
                index += number[0].length;
                kind = "number";
            } else if (name !== null) {
                index += name[0].length;
                kind = "name";
            } else {
                index += operator?.length ?? 1;
                kind = "op";
            }
        }

        tokens.push({ kind, text: source.slice(start, index), start, end: index });
    }

    return tokens;
}

function maskAwk(source: string, tokens: readonly AwkToken[]): Masked {
    const prefix = placeholderPrefix(source);
    const originals = new Map<string, string>();
    let text = "";
    let cursor = 0;

    for (const token of tokens) {
        let open = "";
        let close = "";
        if (token.kind === "string") {
            open = '"';
            close = '"';
        } else if (token.kind === "regex") {
            open = "/";
            close = "/";
        } else if (token.kind === "comment") {
            open = "#";
        } else {
            continue;
        }

        const placeholder = `${open}${prefix}${originals.size}__${close}`;
        originals.set(placeholder, token.text);
        text += source.slice(cursor, token.start) + placeholder;
        cursor = token.end;
    }

    return { text: text + source.slice(cursor), originals };
}

function sameToken(left: AwkToken | undefined, right: AwkToken | undefined): boolean {
    return left !== undefined && right !== undefined && left.text === right.text;
}

function isParen(token: AwkToken | undefined): boolean {
    return token?.text === "(" || token?.text === ")";
}

/**
 * Aligns gawk's canonical output with the submitted tokens and lists the output spans gawk
 * added: parentheses around print arguments and grouped expressions, an implicit
 * `{ print }` action, and `$0` defaults. Added control-statement braces are kept.
 */
function addedAwkSpans(
    original: readonly AwkToken[],
    formatted: readonly AwkToken[],
    output: string,
): { readonly start: number; readonly end: number }[] | undefined {
    const removed: AwkToken[] = [];
    let addedParens = false;
    let deletedParens = false;
    let cursor = 0;
    let index = 0;

    while (index < formatted.length) {
        const token = formatted[index];
        const expected = original[cursor];

        if (token === undefined) break;

        if (sameToken(token, expected)) {
            cursor += 1;
            index += 1;
            continue;
        }

        const next = formatted[index + 1];
        const after = formatted[index + 2];
        if (token.text === "{" && next?.text === "print" && after?.text === "}") {
            removed.push(token, next, after);
            index += 3;
        } else if (token.text === "," && next?.text === "$" && after?.text === "0") {
            removed.push(token, next, after);
            index += 3;
        } else if (token.text === "$" && next?.text === "0") {
            removed.push(token, next);
            index += 2;
        } else if (isParen(token) && !isParen(expected)) {
            removed.push(token);
            addedParens = true;
            index += 1;
        } else if (isParen(expected) && !isParen(token)) {
            // gawk dropped redundant parentheses such as `printf(...)`.
            deletedParens = true;
            cursor += 1;
        } else if (token.text === "{" || token.text === "}") {
            index += 1;
        } else {
            return undefined;
        }
    }

    while (isParen(original[cursor])) {
        deletedParens = true;
        cursor += 1;
    }

    if (cursor !== original.length || (addedParens && deletedParens)) return undefined;

    const spans: { start: number; end: number }[] = [];
    for (const token of removed) {
        const last = spans.at(-1);
        if (last !== undefined && /^\s*$/u.test(output.slice(last.end, token.start)))
            last.end = token.end;
        else spans.push({ start: token.start, end: token.end });
    }

    return spans;
}

function removeSpans(
    text: string,
    spans: readonly { readonly start: number; readonly end: number }[],
): string {
    let output = "";
    let cursor = 0;
    for (const span of spans) {
        output += text.slice(cursor, span.start);

        let next = span.end;
        const before = output.at(-1) ?? "";
        const after = text[next] ?? "";
        const beforeBlank = before === " " || before === "\t";

        if (beforeBlank && (after === " " || after === "\t")) {
            while (text[next] === " " || text[next] === "\t") next += 1;
        } else if (beforeBlank && (after === "" || /[\n),;\]]/u.test(after))) {
            output = output.replace(/[\t ]+$/u, "");
        } else if (
            before !== "" &&
            !/[\s([]/u.test(before) &&
            after !== "" &&
            !/[\s)\],;]/u.test(after)
        ) {
            output += " ";
        }

        cursor = next;
    }

    return output + text.slice(cursor);
}

function structuralTokens(tokens: readonly AwkToken[], ignoreParens: boolean): string[] {
    return tokens
        .filter((token) => token.text !== "{" && token.text !== "}")
        .filter((token) => !ignoreParens || !isParen(token))
        .map((token) => token.text);
}

/**
 * Puts a block whose statements are all simple rows back on one row when that row fits,
 * innermost first: `END { print n }`, `if (x) { y } else { z }`, `{ a[$1] = $3; n++ }`.
 */
function collapseAwkBlocks(
    rows: readonly string[],
    masked: Masked,
    layout: FilterLayout,
): string[] {
    const result = [...rows];
    let changed = true;
    while (changed) {
        changed = false;
        for (let index = result.length - 1; index >= 0; index -= 1) {
            const header = result[index] ?? "";
            if (!header.endsWith("{") || header.includes("#")) continue;

            const depth = indentation(header);
            let end = index + 1;
            while (end < result.length && indentation(result[end] ?? "") > depth) end += 1;
            const closing = result[end]?.trim();
            const items = result.slice(index + 1, end).map((row) => row.trim());
            if (
                closing === undefined ||
                !closing.startsWith("}") ||
                closing.includes("#") ||
                items.length === 0 ||
                // Comments, nested open blocks, and switch labels keep their rows.
                items.some((row) => row.includes("#") || row.endsWith("{") || row.endsWith(":"))
            )
                continue;

            const joined = `${header} ${items.join("; ")} ${closing}`;
            const plain = unmask(joined, {
                ...masked,
                originals: presentOriginals(joined, masked),
            });
            let used = visibleWidth(plain ?? joined);
            if (index === 0) used += layout.firstLineOffset;
            if (end === result.length - 1) used += 1;
            if (used > layout.width) continue;

            result.splice(index, end - index + 1, joined);
            changed = true;
        }
    }

    return result;
}

function presentOriginals(text: string, masked: Masked): Map<string, string> {
    const present = new Map<string, string>();
    for (const [placeholder, original] of masked.originals)
        if (text.includes(placeholder)) present.set(placeholder, original);

    return present;
}

function awkSkipReason(code: string): FilterSkipReason | undefined {
    const tokens = tokenizeAwk(code);
    if (tokens === undefined) return "unparsable";
    if (/@(?:load|include)\b/u.test(maskAwk(code, tokens).text)) return "load-directive";
    return undefined;
}

async function formatAwk<R extends FilterRunResult>(
    code: string,
    profile: FilterFormatterProfile,
    layout: FilterLayout,
    run: FilterFormatterRun<R>,
): Promise<FilterFormatResult<R>> {
    const original = tokenizeAwk(code);
    if (original === undefined) return { kind: "declined", detail: "unparsable" };

    const masked = maskAwk(code, original);
    if (/@(?:load|include)\b/u.test(masked.text))
        return { kind: "declined", detail: "load-directive" };

    const completed = await run(GAWK_PRETTY_PRINT_ARGS, masked.text);
    const output = completed.output;
    if (output === undefined) return { kind: "run-failed", run: completed };

    const declined = (detail: string): FilterFormatResult<R> => ({
        kind: "declined",
        detail,
        run: completed,
    });

    const maskedOriginal = tokenizeAwk(masked.text);
    const formatted = tokenizeAwk(output);
    if (maskedOriginal === undefined || formatted === undefined)
        return declined("unparsable-output");

    const spans = addedAwkSpans(maskedOriginal, formatted, output);
    if (spans === undefined) return declined("reordered");

    const indentWidth = profile.indentWidth ?? 2;
    const rows = reindent(normalizedRows(removeSpans(output, spans)), 8, indentWidth);
    const collapsed = collapseAwkBlocks(rows, masked, layout);
    const result = unmask(collapsed.join("\n"), masked);
    if (result === undefined) return declined("placeholder-lost");
    if (result.includes("'")) return declined("single-quote");

    const resultTokens = tokenizeAwk(result);
    if (resultTokens === undefined) return declined("unparsable-output");

    const parensDropped = original.filter(isParen).length !== resultTokens.filter(isParen).length;
    if (
        structuralTokens(resultTokens, parensDropped).join("\0") !==
        structuralTokens(original, parensDropped).join("\0")
    )
        return declined("reordered");

    return { kind: "formatted", output: result, run: completed };
}

// ----------------------------------------------------------------- jq

function jqStringEnd(source: string, start: number): number | undefined {
    let index = start + 1;
    while (index < source.length) {
        const char = source[index];
        if (char === '"') return index + 1;

        if (char === "\\" && source[index + 1] === "(") {
            index = jqInterpolationEnd(source, index + 2);
            if (index < 0) return undefined;
            continue;
        }

        if (char === "\\") index += 2;
        else index += 1;
    }

    return undefined;
}

function jqInterpolationEnd(source: string, start: number): number {
    let depth = 1;
    let index = start;
    while (index < source.length) {
        const char = source[index];
        if (char === '"') {
            const end = jqStringEnd(source, index);
            if (end === undefined) return -1;

            index = end;
            continue;
        }

        if (char === "(") depth += 1;
        if (char === ")") depth -= 1;
        index += 1;
        if (depth === 0) return index;
    }

    return -1;
}

/** Masks string literals (with their interpolations); undefined when comments are present. */
function maskJq(source: string): Masked | undefined {
    const prefix = placeholderPrefix(source);
    const originals = new Map<string, string>();
    let text = "";
    let index = 0;

    while (index < source.length) {
        const char = source[index] ?? "";

        // jqfmt drops comments; losing them from the preview is not acceptable.
        if (char === "#") return undefined;

        if (char !== '"') {
            text += char;
            index += 1;
            continue;
        }

        const end = jqStringEnd(source, index);
        if (end === undefined) return undefined;

        const placeholder = `"${prefix}${originals.size}__"`;
        originals.set(placeholder, source.slice(index, end));
        text += placeholder;
        index = end;
    }

    return { text, originals };
}

function joinNestedPipeBreaks(rows: readonly string[]): string[] {
    const result: string[] = [];
    let depth = 0;
    for (const row of rows) {
        const previous = result.at(-1);
        if (previous !== undefined && previous.endsWith("|") && depth > 0)
            result[result.length - 1] = `${previous} ${row.trim()}`;
        else result.push(row);

        // `if … end` nests like brackets; field names such as `.end` and `{end: 1}` do not.
        for (const match of row.matchAll(/[([{]|[)\]}]|(?<![.$\w])(?:if|end)\b(?!\s*:)/gu)) {
            if (match[0] === "end" || ")]}".includes(match[0])) depth -= 1;
            else depth += 1;
        }
    }

    return result;
}

function indentation(row: string): number {
    return /^ */u.exec(row)?.[0].length ?? 0;
}

/** Re-collapses objects and arrays jqfmt exploded when their one-row form fits. */
function collapseJqBrackets(
    rows: readonly string[],
    masked: Masked,
    layout: FilterLayout,
): string[] {
    const result = [...rows];
    let changed = true;
    while (changed) {
        changed = false;
        for (let index = result.length - 1; index >= 0; index -= 1) {
            const opener = result[index] ?? "";
            const bracket = opener.at(-1);
            if (bracket !== "{" && bracket !== "[") continue;

            let closer = "]";
            if (bracket === "{") closer = "}";

            const depth = indentation(opener);
            let end = index + 1;
            while (end < result.length && indentation(result[end] ?? "") > depth) end += 1;
            const closing = result[end];
            if (closing === undefined || !closing.trimStart().startsWith(closer)) continue;

            const items = result.slice(index + 1, end).map((row) => row.trim());
            if (items.some((row) => row.endsWith("{") || row.endsWith("["))) continue;

            let pad = "";
            if (bracket === "{") pad = " ";

            const joined = `${opener}${pad}${items.join(" ")}${pad}${closing.trimStart()}`;
            const plain = unmask(joined, {
                ...masked,
                originals: presentOriginals(joined, masked),
            });
            let used = visibleWidth(plain ?? joined);
            if (index === 0) used += layout.firstLineOffset;
            if (end === result.length - 1) used += 1;
            if (used > layout.width) continue;

            result.splice(index, end - index + 1, joined);
            changed = true;
        }
    }

    return result;
}

function withoutWhitespace(text: string): string {
    return text.replace(/\s+/gu, "");
}

/**
 * The first row shares its line with the command prefix. When that prefix alone pushes it
 * past the width, more breaks only help if they can split the row itself; jqfmt's object and
 * array levels can, pipe-joined parentheses cannot.
 */
function jqLayoutFits(rows: readonly string[], masked: Masked, layout: FilterLayout): boolean {
    const plain = rows.map(
        (row) => unmask(row, { ...masked, originals: presentOriginals(row, masked) }) ?? row,
    );
    const [first = "", ...rest] = plain;
    const restFits = filterProgramFits(rest.join("\n"), { ...layout, firstLineOffset: 0 });
    if (rest.length > 0 && !restFits) return false;

    const firstUsed = visibleWidth(first) + layout.firstLineOffset + Number(rest.length === 0);
    return firstUsed <= layout.width || !/[{[]/u.test(rows[0] ?? "");
}

// `def` introduces a function definition; `.def`, `$def`, and `{def: 1}` do not.
const JQ_DEFINITION = /(?<![.$\w])def\s+[A-Za-z_]/u;

function jqSkipReason(code: string): FilterSkipReason | undefined {
    const masked = maskJq(code);
    if (masked === undefined) {
        // Masking also fails on an unterminated string; only a comment is fixed by removing `#`.
        if (maskJq(code.replaceAll("#", "")) !== undefined) return "comment";
        return "unparsable";
    }

    // jqfmt silently drops function definitions.
    if (JQ_DEFINITION.test(masked.text)) return "defs";
    return undefined;
}

async function formatJq<R extends FilterRunResult>(
    code: string,
    profile: FilterFormatterProfile,
    layout: FilterLayout,
    run: FilterFormatterRun<R>,
): Promise<FilterFormatResult<R>> {
    const skip = jqSkipReason(code);
    if (skip !== undefined) return { kind: "declined", detail: skip };

    const masked = maskJq(code);
    if (masked === undefined) return { kind: "declined", detail: "unparsable" };

    const indentWidth = profile.indentWidth ?? 2;
    let best: { readonly output: string; readonly run: R } | undefined;
    const fallback = (result: FilterFormatResult<R>): FilterFormatResult<R> => {
        if (best === undefined) return result;
        return { kind: "formatted", ...best };
    };

    for (const candidate of JQ_LAYOUTS) {
        const completed = await run(candidate, masked.text);
        const output = completed.output;
        if (output === undefined) return fallback({ kind: "run-failed", run: completed });

        // jqfmt silently drops some constructs. Only whitespace may change; anything else
        // keeps the submitted program.
        if (withoutWhitespace(output) !== withoutWhitespace(masked.text))
            return fallback({ kind: "declined", detail: "non-whitespace-change", run: completed });

        const rows = joinNestedPipeBreaks(normalizedRows(output));
        const indented = collapseJqBrackets(reindent(rows, 4, indentWidth), masked, layout);
        const result = unmask(indented.join("\n"), masked);
        if (result === undefined)
            return fallback({ kind: "declined", detail: "placeholder-lost", run: completed });

        if (result.includes("'"))
            return fallback({ kind: "declined", detail: "single-quote", run: completed });

        best = { output: result, run: completed };

        if (jqLayoutFits(indented, masked, layout)) return { kind: "formatted", ...best };
    }

    return fallback({ kind: "declined", detail: "no-layout" });
}

/**
 * Why a program is kept as submitted without running the formatter; undefined when it will
 * be handed to the formatter. Mirrors the checks `formatFilterProgram` makes before running.
 */
export function filterProgramSkipReason(
    code: string,
    kind: FilterFormatterProfile["kind"],
    layout: FilterLayout,
): FilterSkipReason | undefined {
    if (code.trim().length === 0) return "empty";
    if (filterProgramFits(code, layout)) return "fits-width";
    return filterProgramSafetyReason(code, kind);
}

/** The width-independent part of `filterProgramSkipReason`. */
export function filterProgramSafetyReason(
    code: string,
    kind: FilterFormatterProfile["kind"],
): FilterSkipReason | undefined {
    if (code.trim().length === 0) return "empty";
    if (kind === "awk") return awkSkipReason(code);
    return jqSkipReason(code);
}

/** Display-only awk/jq formatting at the available width; only `formatted` replaces the original. */
export async function formatFilterProgram<R extends FilterRunResult>(
    code: string,
    profile: FilterFormatterProfile,
    layout: FilterLayout,
    run: FilterFormatterRun<R>,
): Promise<FilterFormatResult<R>> {
    if (code.trim().length === 0) return { kind: "unchanged", detail: "empty" };
    if (filterProgramFits(code, layout)) return { kind: "unchanged", detail: "fits-width" };

    let result: FilterFormatResult<R>;
    if (profile.kind === "awk") result = await formatAwk(code, profile, layout, run);
    else result = await formatJq(code, profile, layout, run);

    if (result.kind === "formatted" && result.output === code)
        return { kind: "unchanged", run: result.run };

    return result;
}
