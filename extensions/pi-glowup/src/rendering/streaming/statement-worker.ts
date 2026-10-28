import { createRequire } from "node:module";
import {
    bashCompoundRanges,
    extractEmbeddedPrograms,
    type EmbeddedProgram,
} from "../../tools/built-in/bash/embedded-programs.ts";
import { parentPort } from "node:worker_threads";
import { Language, Parser, type Node } from "web-tree-sitter";
import { parse as parseBash, type ParsedScript } from "unbash";
import { structuralUnits, type HeaderScaffold } from "./statement-structure.ts";
import {
    isStatementLiteral,
    statementLiterals,
    type StatementLiteral,
} from "./statement-literals.ts";

export type StatementUnit = {
    readonly start: number;
    readonly end: number;
    readonly format: boolean;
    readonly indent: string;
    readonly kind: string;
    readonly container?: number;
    readonly body?: number;
    readonly scaffold?: HeaderScaffold;
    readonly branch?: boolean;
    readonly context?: HeaderScaffold;
    readonly literals?: readonly StatementLiteral[];
};

export type StatementRequest = {
    readonly id: number;
    readonly source: string;
    readonly language: string;
    readonly complete: boolean;
};

export type StatementResponse =
    | {
          readonly id: number;
          readonly units: StatementUnit[];
          readonly malformed: boolean;
          readonly programs?: EmbeddedProgram[];
      }
    | { readonly id: number; readonly error: string };

export type EmbeddedRequest = {
    readonly id: number;
    readonly kind: "embedded";
    readonly source: string;
};

export type EmbeddedResponse = {
    readonly id: number;
    readonly kind: "embedded";
    readonly programs: EmbeddedProgram[];
};

export type WorkerRequest = StatementRequest | EmbeddedRequest;
export type WorkerResponse = StatementResponse | EmbeddedResponse;

const require = createRequire(import.meta.url);
const parsers = new Map<string, Parser>();
const initialization = Parser.init();
const port = parentPort;
if (port === null) throw new Error("Statement worker requires a parent port");

const javascriptStatements = new Set([
    "expression_statement",
    "lexical_declaration",
    "variable_declaration",
    "return_statement",
    "throw_statement",
    "break_statement",
    "continue_statement",
    "debugger_statement",
    "import_statement",
    "export_statement",
    "empty_statement",
    "type_alias_declaration",
    "interface_declaration",
    "enum_declaration",
    "ambient_declaration",
    "import_alias",
    "field_definition",
    "public_field_definition",
]);

const pythonStatements = new Set([
    "expression_statement",
    "return_statement",
    "raise_statement",
    "assert_statement",
    "pass_statement",
    "break_statement",
    "continue_statement",
    "import_statement",
    "import_from_statement",
    "future_import_statement",
    "global_statement",
    "nonlocal_statement",
    "delete_statement",
    "print_statement",
    "exec_statement",
    "type_alias_statement",
]);

const bashStatements = new Set([
    "command",
    "declaration_command",
    "variable_assignment",
    "pipeline",
    "list",
    "negated_command",
    "test_command",
    "unset_command",
    "redirected_statement",
]);

const containers = new Set(["program", "module", "block", "statement_block", "ERROR"]);

const compounds = new Set([
    "if_statement",
    "else_clause",
    "elif_clause",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "try_statement",
    "catch_clause",
    "finally_clause",
    "with_statement",
    "function_definition",
    "function_declaration",
    "generator_function_declaration",
    "class_definition",
    "class_declaration",
    "class_body",
    "decorated_definition",
    "switch_statement",
    "switch_body",
    "switch_case",
    "switch_default",
    "labeled_statement",
    "match_statement",
    "case_clause",
    "case_statement",
    "case_item",
    "compound_statement",
    "subshell",
    "do_group",
    "c_style_for_statement",
]);

async function parserFor(language: string): Promise<Parser | undefined> {
    if (!["javascript", "typescript", "tsx", "python", "bash"].includes(language)) return undefined;

    const cached = parsers.get(language);
    if (cached !== undefined) return cached;

    await initialization;

    const grammar = await Language.load(
        require.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${language}.wasm`),
    );
    const parser = new Parser();
    parser.setLanguage(grammar);
    parsers.set(language, parser);

    return parser;
}

function indentAt(source: string, start: number): string {
    const line = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
    if (/^[\t ]*$/u.test(line)) return line;
    return "";
}

/** Tree-sitter's Python grammar permits physical newlines in some simple assignments
 * that CPython rejects. Only bracket nesting or an explicit continuation may cross
 * those token gaps; string/comment contents are atomic, not statement boundaries. */
function crossesPythonStatementBoundary(node: Node, source: string): boolean {
    let end = node.startIndex;
    let nesting = 0;
    let crossed = false;

    function scan(token: Node): void {
        if (token.type === "string" || token.type === "comment" || token.childCount === 0) {
            const gap = source.slice(end, token.startIndex).replace(/\\\r?\n/gu, "");
            if (nesting === 0 && /[\r\n]/u.test(gap)) crossed = true;
            if (["(", "[", "{"].includes(token.type)) nesting++;
            if ([")", "]", "}"].includes(token.type)) nesting = Math.max(0, nesting - 1);
            end = token.endIndex;
            return;
        }

        for (const child of token.children) scan(child);
    }

    scan(node);

    return crossed;
}

/** An EOF parse is speculative: in JS even a trailing newline permits `.then(...)`.
 * A following identifier must itself have a terminator (the prefix `i` can become `instanceof`). */
function isSettled(node: Node, source: string, language: string, complete: boolean): boolean {
    if (complete) return true;

    const tail = source.slice(node.endIndex);
    if (node.type === "comment") return /^(?:\r?\n|\r)/u.test(tail) || node.text.endsWith("*/");
    if (language === "python") return /^[\t ]*(?:;|\r?\n)/u.test(tail);
    if (language === "bash") return /^[\t ]*(?:;|&(?!&)|\r?\n)/u.test(tail);
    if (node.text.endsWith(";")) return true;
    if (
        [
            "function_declaration",
            "generator_function_declaration",
            "class_declaration",
            "interface_declaration",
            "enum_declaration",
        ].includes(node.type) &&
        node.text.endsWith("}")
    )
        return true;

    const next = tail.replace(/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*/u, "");
    if (next.length === 0) return false;
    if (next.startsWith("}")) return true;

    const word = /^[\p{ID_Start}_$][\p{ID_Continue}$]*/u.exec(next)?.[0];
    if (word !== undefined) return word.length < next.length;

    // The parser has already separated these nodes; require a complete punctuation
    // token too, never a partial slash/operator that could change tokenization.
    return /^(?:[;{]|["'`])/u.test(next);
}

function unitsFor(
    source: string,
    language: string,
    complete: boolean,
    root: Node,
    literalInfo: ReturnType<typeof statementLiterals>,
    syntax?: ParsedScript,
): StatementUnit[] {
    let statements = javascriptStatements;
    if (language === "python") statements = pythonStatements;
    if (language === "bash") statements = bashStatements;

    const units: StatementUnit[] = [];

    function blocksWithin(node: Node): Node[] {
        if (isStatementLiteral(node, language)) return [];

        const blocks: Node[] = [];
        for (const child of node.namedChildren) {
            if (child.type === "statement_block" || child.type === "block") blocks.push(child);
            else blocks.push(...blocksWithin(child));
        }

        return blocks;
    }

    function visit(node: Node): void {
        if (node.type === "comment") {
            if (isSettled(node, source, language, complete)) {
                units.push({
                    start: node.startIndex,
                    end: node.endIndex,
                    format: false,
                    indent: "",
                    kind: node.type,
                });
            }

            return;
        }

        if (statements.has(node.type)) {
            // Decompose even finished functions identically to their streaming form.
            // Never reformat a growing enclosing statement after revealing its children.
            const blocks = blocksWithin(node);
            if (language === "bash" && node.type === "redirected_statement") {
                const body = node.childForFieldName("body");
                if (body !== null && compounds.has(body.type)) blocks.push(body);
            }

            const before = units.length;

            for (const block of blocks) visit(block);

            if (
                units.length === before &&
                !node.hasError &&
                !node.isMissing &&
                !(language === "python" && crossesPythonStatementBoundary(node, source)) &&
                isSettled(node, source, language, complete)
            ) {
                let end = node.endIndex;
                if (
                    ["field_definition", "public_field_definition"].includes(node.type) &&
                    source[end] === ";"
                )
                    end += 1;

                units.push({
                    start: node.startIndex,
                    end,
                    format: true,
                    indent: indentAt(source, node.startIndex),
                    kind: node.type,
                });
            }

            return;
        }

        if (containers.has(node.type) || compounds.has(node.type)) {
            const before = units.length;

            for (const child of node.namedChildren) visit(child);

            if (
                units.length === before &&
                compounds.has(node.type) &&
                !node.hasError &&
                isSettled(node, source, language, complete)
            ) {
                // Python's recovery tree accepts a colon followed only by a
                // comment as a compound with no missing/error nodes. It is not
                // formatter-ready, and consuming it would prevent the later
                // structural header from establishing its body indentation.
                if (language === "python" && !complete) return;

                units.push({
                    start: node.startIndex,
                    end: node.endIndex,
                    format: true,
                    indent: indentAt(source, node.startIndex),
                    kind: node.type,
                });
            }

            return;
        }

        // Function expressions, methods, and arrow functions may be nested in declarations.
        for (const block of blocksWithin(node)) visit(block);
    }

    visit(root);

    let structured = structuralUnits(source, language, root, units);
    if (language === "bash") {
        const compounds = bashCompoundRanges(source, complete, syntax);

        structured = structured.filter(
            (unit) => !compounds.some((range) => unit.start < range.end && unit.end > range.start),
        );
        for (const range of compounds) {
            if (range.settled)
                structured.push({
                    start: range.start,
                    end: range.end,
                    format: true,
                    indent: indentAt(source, range.start),
                    kind: "compound",
                });
        }

        structured.sort((left, right) => left.start - right.start);
    }

    const ordered: StatementUnit[] = [];
    let end = 0;
    for (const unit of structured) {
        if (unit.start < end) continue;

        // Recovery can find a valid statement after an invalid prefix. Only lexical
        // separators may be copied between validated units while generation is live;
        // otherwise hold this gap and everything after it until final completion.
        const gap = source.slice(end, unit.start);
        let safeGap = /^[\s;]*$/u.test(gap);
        if (language === "bash") safeGap = /^(?:\s|;|&(?!&))*$/u.test(gap);
        if (!complete && !safeGap) break;

        ordered.push(unit);
        end = unit.end;
    }

    if (complete && end < source.length) {
        ordered.push({
            start: end,
            end: source.length,
            format: false,
            indent: "",
            kind: "structure",
        });
    }

    const start = literalInfo.unsafeHeredocStart;
    let result = ordered;

    if (start !== undefined) {
        result = ordered.filter((unit) => unit.end <= start);
        if (complete)
            result.push({
                start,
                end: source.length,
                format: !literalInfo.unterminatedHeredoc,
                indent: "",
                kind: "heredoc-fallback",
            });
    }

    return result.map((unit) => {
        const literals = literalInfo.literals.filter(
            (literal) => literal.start >= unit.start && literal.end <= unit.end,
        );
        if (literals.length === 0) return unit;

        return { ...unit, literals };
    });
}

async function parse(request: StatementRequest): Promise<StatementResponse> {
    try {
        const parser = await parserFor(request.language);
        if (parser === undefined) {
            const units: StatementUnit[] = [];
            if (request.complete && request.source.length > 0) {
                units.push({
                    start: 0,
                    end: request.source.length,
                    format: true,
                    indent: "",
                    kind: "unknown",
                });
            }

            return { id: request.id, units, malformed: false };
        }

        const tree = parser.parse(request.source);
        if (tree === null) throw new Error("Parser did not produce a tree");
        try {
            let syntax: ParsedScript | undefined;
            if (request.language === "bash") syntax = parseBash(request.source);

            return {
                id: request.id,
                ...(syntax !== undefined && {
                    programs: extractEmbeddedPrograms(request.source, syntax),
                }),
                units: unitsFor(
                    request.source,
                    request.language,
                    request.complete,
                    tree.rootNode,
                    statementLiterals(request.source, request.language, tree.rootNode),
                    syntax,
                ),
                malformed: tree.rootNode.hasError,
            };
        } finally {
            tree.delete();
        }
    } catch (error: unknown) {
        let message = "Statement parser failed";
        if (error instanceof Error) message = error.message;

        return { id: request.id, error: message };
    }
}

// Serialize language loading and parsing; a tree never outlives its request.
let work = Promise.resolve();

port.on("message", (request: WorkerRequest) => {
    work = work.then(async () => {
        if ("kind" in request) {
            try {
                port.postMessage({
                    id: request.id,
                    kind: "embedded",
                    programs: extractEmbeddedPrograms(request.source),
                } satisfies EmbeddedResponse);
            } catch (cause: unknown) {
                let message = "Bash parser failed";
                if (cause instanceof Error) message = cause.message;
                port.postMessage({ id: request.id, error: message } satisfies StatementResponse);
            }

            return;
        }

        port.postMessage(await parse(request));
    });
});
