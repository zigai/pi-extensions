import type { Node } from "web-tree-sitter";
import type { StatementUnit } from "./statement-worker.ts";
import { isStatementLiteral } from "./statement-literals.ts";

export type HeaderScaffold = {
    readonly before: string;
    readonly after: string;
    readonly body?: string;
    readonly indent?: string;
};

type Region = {
    readonly id: number;
    readonly start: number;
    readonly end: number;
    readonly bodyEnd: number;
    readonly closeEnd: number;
    readonly scaffold: HeaderScaffold;
    readonly branch: boolean;
};

function indentAt(source: string, index: number): string {
    const text = source.slice(source.lastIndexOf("\n", index - 1) + 1, index);
    if (/^[\t ]*$/u.test(text)) return text;
    return "";
}

/** Structural skeletons contain headers and private placeholders only, never body statements. */
export function structuralUnits(
    source: string,
    language: string,
    root: Node,
    leaves: readonly StatementUnit[],
): StatementUnit[] {
    const regions: Region[] = [];

    function add(
        start: number,
        end: number,
        bodyEnd: number,
        closeEnd: number,
        before: string,
        after: string,
        branch = false,
        body?: string,
        indent?: string,
    ): void {
        if (end <= start) return;

        let scaffold: HeaderScaffold = { before, after };
        if (body !== undefined) scaffold = { ...scaffold, body };
        if (indent !== undefined) scaffold = { ...scaffold, indent };
        regions.push({ id: end, start, end, bodyEnd, closeEnd, scaffold, branch });
    }

    function owner(block: Node): Node {
        let node = block.parent;
        if (node === null) return block;

        while (
            node.parent !== null &&
            [
                "arrow_function",
                "variable_declarator",
                "lexical_declaration",
                "variable_declaration",
                "function_expression",
                "expression_statement",
                "decorated_definition",
                "else_clause",
                "labeled_statement",
                "arguments",
                "call_expression",
                "parenthesized_expression",
                "array",
                "object",
                "pair",
                "await_expression",
            ].includes(node.parent.type)
        )
            node = node.parent;

        return node;
    }

    function closeForHeader(start: number, end: number): string {
        const stack: string[] = [];

        function scan(node: Node): void {
            if (node.endIndex <= start || node.startIndex >= end || node.isMissing) return;

            if (node.childCount === 0) {
                if (node.type === "(") stack.push(")");
                else if (node.type === "[") stack.push("]");
                else if (node.type === "{") stack.push("}");
                else if (stack.at(-1) === node.type) stack.pop();

                return;
            }

            for (const child of node.children) scan(child);
        }

        scan(root);

        return stack.reverse().join("");
    }

    function collect(node: Node): void {
        if (isStatementLiteral(node, language)) return;

        if (
            (language === "javascript" || language === "typescript" || language === "tsx") &&
            (node.type === "statement_block" ||
                node.type === "class_body" ||
                node.type === "switch_body")
        ) {
            const enclosing = owner(node);
            const close = node.children
                .slice()
                .reverse()
                .find((child) => child.type === "}" && !child.isMissing);
            const header = source.slice(enclosing.startIndex, node.startIndex + 1).trimStart();
            let before = "";
            if (/^else\b/u.test(header)) before = "if (true) {}\n";
            if (/^(?:catch|finally)\b/u.test(header)) before = "try {}\n";
            if (enclosing.type === "method_definition") before = "class __glowup_context__ {\n";

            let after = "\n" + closeForHeader(enclosing.startIndex, node.startIndex + 1);
            if (/^try\b/u.test(header)) after += " finally {}";
            if (enclosing.type === "method_definition") after += "\n}";

            let body: string | undefined;
            if (node.type === "class_body") body = "__glowup_placeholder__() {}";
            if (node.type === "switch_body") body = "default:\n    __glowup_placeholder__();";

            add(
                enclosing.startIndex,
                node.startIndex + 1,
                node.endIndex,
                close?.endIndex ?? node.endIndex,
                before,
                after,
                /^(?:else|catch|finally)\b/u.test(header),
                body,
            );
        }

        if (
            ["javascript", "typescript", "tsx"].includes(language) &&
            ["switch_case", "switch_default"].includes(node.type)
        ) {
            const colon = node.children.find((child) => child.type === ":");
            if (colon !== undefined)
                add(
                    node.startIndex,
                    colon.endIndex,
                    node.endIndex,
                    colon.endIndex,
                    "switch (__glowup_value__) {\n",
                    "\n}",
                );
        }

        if (language === "python" && node.type === "block") {
            const enclosing = owner(node);
            const colon = source.lastIndexOf(":", node.startIndex);
            const header = source.slice(enclosing.startIndex, colon + 1).trimStart();
            let before = "";
            let after = "";

            if (/^(?:else|elif)\b/u.test(header)) before = "if True:\n    pass\n";
            if (/^(?:except|finally)\b/u.test(header)) before = "try:\n    pass\n";

            // A try suite alone is invalid formatter input, even while its real
            // handler is still streaming. Keep the private handler outside markers.
            if (/^try\b/u.test(header)) after = "\nfinally:\n    pass";

            let contextIndent: string | undefined;
            if (/^case\b/u.test(header)) {
                before = "match __glowup_value__:\n";
                contextIndent = "    ";
            }

            let body: string | undefined;
            if (/^match\b/u.test(header)) body = "case _:\n        pass";

            add(
                enclosing.startIndex,
                colon + 1,
                node.endIndex,
                node.endIndex,
                before,
                after,
                false,
                body,
                contextIndent,
            );
        }

        if (
            ["javascript", "typescript", "tsx"].includes(language) &&
            [
                "if_statement",
                "while_statement",
                "for_statement",
                "for_in_statement",
                "else_clause",
            ].includes(node.type)
        ) {
            let body = node.childForFieldName("consequence") ?? node.childForFieldName("body");
            if (node.type === "else_clause") body = node.namedChildren[0] ?? null;

            if (body !== null && !["statement_block", "if_statement"].includes(body.type)) {
                const end =
                    node.startIndex +
                    source.slice(node.startIndex, body.startIndex).trimEnd().length;
                let before = "";
                if (node.type === "else_clause") before = "if (true) {}\n";

                add(
                    node.startIndex,
                    end,
                    body.endIndex,
                    end,
                    before,
                    "",
                    node.type === "else_clause",
                );
            }
        }

        if (language === "bash") {
            if (node.type === "case_statement" || node.type === "case_item") {
                const opener = node.children.find(
                    (child) => child.type === "in" || child.type === ")",
                );
                const closer = node.children.at(-1);
                if (opener !== undefined) {
                    let before = "";
                    let after = "\nesac";
                    let body = "__glowup_placeholder__) : ;;";
                    if (node.type === "case_item") {
                        before = "case __glowup_value__ in\n";
                        after = "\n;;\nesac";
                        body = ":";
                    }

                    let closeEnd = opener.endIndex;
                    if (closer !== undefined && !closer.isMissing) closeEnd = closer.endIndex;

                    add(
                        node.startIndex,
                        opener.endIndex,
                        node.endIndex,
                        closeEnd,
                        before,
                        after,
                        false,
                        body,
                    );
                }
            }

            if (["if_statement", "elif_clause", "else_clause"].includes(node.type)) {
                const opener = node.children.find(
                    (child) => child.type === "then" || child.type === "else",
                );
                if (opener !== undefined) {
                    let before = "";
                    if (node.type !== "if_statement") before = "if true; then\n:\n";

                    const close = node.children.find(
                        (child) => child.type === "fi" && !child.isMissing,
                    );
                    const branch = node.children.find(
                        (child) =>
                            child.type === "elif_clause" ||
                            child.type === "else_clause" ||
                            child.type === "fi",
                    );
                    add(
                        node.startIndex,
                        opener.endIndex,
                        branch?.startIndex ?? node.endIndex,
                        close?.endIndex ?? node.endIndex,
                        before,
                        "\nfi",
                    );
                }
            }

            if (["do_group", "compound_statement", "subshell"].includes(node.type)) {
                const opener = node.children[0];
                const closer = node.children.at(-1);
                if (opener !== undefined) {
                    let start = node.startIndex;
                    let after = "\n}";
                    if (node.type === "do_group") {
                        start = node.parent?.startIndex ?? start;
                        after = "\ndone";
                    } else if (node.type === "subshell") after = "\n)";
                    else if (node.parent?.type === "function_definition")
                        start = node.parent.startIndex;

                    let closeEnd = node.endIndex;
                    if (closer?.isMissing !== false) closeEnd = opener.endIndex;
                    add(start, opener.endIndex, node.endIndex, closeEnd, "", after);
                }
            }
        }

        for (const child of node.namedChildren) collect(child);
    }

    collect(root);

    // Tree-sitter ERROR nodes retain real anonymous delimiters even when several
    // missing closings cause it to discard the enclosing block nodes entirely.
    function recover(node: Node): void {
        if (isStatementLiteral(node, language)) return;

        if (node.isError) {
            let segmentStart = node.startIndex;
            for (const child of node.children) {
                if (["{", "then", "do"].includes(child.type) && !child.isMissing) {
                    let start = segmentStart;
                    const whitespace =
                        /^\s*/u.exec(source.slice(start, child.startIndex))?.[0].length ?? 0;
                    start += whitespace;

                    const header = source.slice(start, child.endIndex);
                    let after = "\n}";
                    if (child.type === "then") after = "\nfi";
                    if (child.type === "do") after = "\ndone";

                    if (
                        !regions.some((region) => region.end === child.endIndex) &&
                        (/^(?:(?:async\s+)?function\b|(?:const|let|var)\b|(?:if|for|while|until|else|elif)\b|[\w$]+\s*\(\s*\)\s*\{)/u.test(
                            header,
                        ) ||
                            header.includes("=>") ||
                            /\bfunction\b/u.test(header))
                    ) {
                        if (language !== "bash")
                            after = "\n" + closeForHeader(start, child.endIndex);

                        add(start, child.endIndex, source.length, child.endIndex, "", after);
                    }

                    segmentStart = child.endIndex;
                } else if (
                    leaves.some(
                        (leaf) => leaf.start === child.startIndex && leaf.end === child.endIndex,
                    ) &&
                    /^[\t ]*\r?\n/u.test(source.slice(child.endIndex))
                )
                    segmentStart = child.endIndex;
            }
        }

        for (const child of node.namedChildren) recover(child);
    }

    recover(root);

    const selected = regions.filter((region) =>
        leaves.some((leaf) => leaf.start >= region.end && leaf.end <= region.bodyEnd),
    );

    function parentAt(start: number, own?: Region): Region | undefined {
        let parent: Region | undefined;
        for (const region of selected) {
            if (region === own || region.end > start || region.bodyEnd <= start) continue;
            if (parent === undefined || region.end > parent.end) parent = region;
        }

        return parent;
    }

    const result: StatementUnit[] = [];
    for (const leaf of leaves) {
        if (selected.some((region) => leaf.start < region.end && leaf.end > region.start)) continue;

        const parent = parentAt(leaf.start);
        let unit = leaf;
        if (parent !== undefined) unit = { ...leaf, container: parent.id };
        result.push(unit);
    }

    for (const region of selected) {
        const parent = parentAt(region.start, region);
        const header: StatementUnit = {
            start: region.start,
            end: region.end,
            format: true,
            indent: indentAt(source, region.start),
            kind: "header",
            body: region.id,
            scaffold: region.scaffold,
            branch: region.branch,
        };
        if (parent !== undefined) result.push({ ...header, container: parent.id });
        else result.push(header);

        if (language === "python") continue;

        const close = /(?:\}|\)|;;|;&|;;&|\besac\b|\bfi\b|\bdone\b)[\t ]*$/u.exec(
            source.slice(region.end, region.closeEnd),
        );
        if (close === null) continue;

        const start = region.closeEnd - close[0].length;

        // Bash if bodies span elif/else branches, whose lexical sibling headers
        // share the original if's indentation rather than nesting beneath it.
        const closing: StatementUnit = {
            start,
            end: region.closeEnd,
            format: false,
            indent: indentAt(source, start),
            kind: "close",
            body: region.id,
        };
        if (/^;(?:;|&)/u.test(close[0])) result.push({ ...closing, container: region.id });
        else if (parent !== undefined) result.push({ ...closing, container: parent.id });
        else result.push(closing);
    }

    function privateDeclarationAt(start: number): string | undefined {
        let node: Node | null = root.namedDescendantForIndex(
            start,
            Math.min(source.length, start + 1),
        );
        while (node !== null && node.startIndex >= start) {
            if (
                node.startIndex === start &&
                ["method_definition", "field_definition", "public_field_definition"].includes(
                    node.type,
                )
            ) {
                const name = node.childForFieldName("name") ?? node.childForFieldName("property");
                if (name?.type === "private_property_identifier") return name.text;
            }

            node = node.parent;
        }

        return undefined;
    }

    const contextual = result.map((unit): StatementUnit => {
        if (!unit.format || !["javascript", "typescript", "tsx"].includes(language)) return unit;

        const ancestors = selected
            .filter(
                (region) =>
                    region.end <= unit.start &&
                    unit.end <= region.bodyEnd &&
                    region.start !== unit.start,
            )
            .sort((left, right) => left.end - right.end);
        if (ancestors.length === 0) return unit;

        const privateNames = new Set(
            source.slice(unit.start, unit.end).match(/#[A-Za-z_$][\w$]*/gu) ?? [],
        );
        for (const start of [unit.start, ...ancestors.map((region) => region.start)]) {
            const name = privateDeclarationAt(start);
            if (name !== undefined) privateNames.delete(name);
        }

        let before = "";
        let after = "";
        let insideClass = false;
        let insideSwitch = false;

        for (const region of ancestors) {
            let wrapperBefore = region.scaffold.before;
            let wrapperAfter = region.scaffold.after;
            if (insideClass && wrapperBefore.startsWith("class __glowup_context__")) {
                wrapperBefore = "";
                wrapperAfter = "\n}";
            }

            if (insideSwitch && wrapperBefore.startsWith("switch (__glowup_value__)")) {
                wrapperBefore = "";
                wrapperAfter = "";
            }

            before += wrapperBefore + source.slice(region.start, region.end) + "\n";

            if (/^switch\b/u.test(source.slice(region.start, region.end).trimStart()))
                insideSwitch = true;

            if (region.scaffold.body === "__glowup_placeholder__() {}") {
                insideClass = true;

                for (const name of privateNames) before += name + ";\n";
            }

            after = wrapperAfter + "\n" + after;
        }

        let scaffold = unit.scaffold;
        if (insideClass && scaffold?.before.startsWith("class __glowup_context__") === true)
            scaffold = { ...scaffold, before: "", after: "\n}" };

        if (insideSwitch && scaffold?.before.startsWith("switch (__glowup_value__)") === true)
            scaffold = { ...scaffold, before: "", after: "" };

        if (scaffold !== undefined) return { ...unit, scaffold, context: { before, after } };

        return { ...unit, context: { before, after } };
    });

    return contextual.sort((left, right) => left.start - right.start || left.end - right.end);
}
