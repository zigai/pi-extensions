import type { Node } from "web-tree-sitter";

export type StatementLiteral = {
    readonly start: number;
    readonly end: number;
    readonly kind: "string" | "template" | "heredoc";
    readonly delimiter?: string;

    readonly heredoc?: {
        readonly command: string;
        readonly bodyEnd: number;
        readonly quoted: boolean;
        readonly stripTabs: boolean;
    };
};

export function isStatementLiteral(node: Node, language: string): boolean {
    if (language === "python") return node.type === "string";
    if (language === "bash")
        return ["string", "raw_string", "ansi_c_string", "heredoc_body"].includes(node.type);

    return node.type === "string" || node.type === "template_string";
}

/** Literal contents must never acquire indentation from a surrounding display unit. */
export function statementLiterals(source: string, language: string, root: Node) {
    const literals: StatementLiteral[] = [];
    let unsafeHeredocStart: number | undefined;
    let unterminatedHeredoc = false;

    function holdEnclosingStatement(node: Node): void {
        let owner = node;
        while (owner.parent !== null && owner.parent.id !== root.id) owner = owner.parent;
        unsafeHeredocStart = Math.min(unsafeHeredocStart ?? owner.startIndex, owner.startIndex);
    }

    function visit(node: Node): void {
        if (language === "bash" && node.type === "heredoc_redirect") {
            // In particular, this grammar recovers a second << on the same
            // command as ERROR + file_redirect, exposing its body as commands.
            if (node.hasError) holdEnclosingStatement(node);

            const opening = node.namedChildren.find((child) => child.type === "heredoc_start");
            const body = node.namedChildren.find((child) => child.type === "heredoc_body");
            const end = node.namedChildren.find((child) => child.type === "heredoc_end");
            if (
                opening !== undefined &&
                body !== undefined &&
                end !== undefined &&
                !end.isMissing
            ) {
                const delimiter = end.text;
                const stripTabs = node.children.some((child) => child.type === "<<-");

                // The grammar skips leading whitespace before heredoc_body. It is
                // literal payload too, including entirely blank initial lines.
                const bodyTokenStart = body.startIndex;
                let headerEnd = opening.endIndex;

                function headerTokens(token: Node): void {
                    if (["heredoc_body", "heredoc_end"].includes(token.type)) return;

                    if (token.endIndex <= bodyTokenStart) {
                        headerEnd = Math.max(headerEnd, token.endIndex);
                        return;
                    }

                    for (const child of token.children) headerTokens(child);
                }

                // Redirects can precede multiline quoted arguments. Their inner
                // newlines are not the beginning of the heredoc payload.
                headerTokens(node.parent ?? node);

                const bodyStart = source.indexOf("\n", headerEnd) + 1;
                let close: number | undefined;
                let closeStart: number | undefined;
                let lineStart = bodyStart;
                while (lineStart <= source.length) {
                    let lineEnd = source.indexOf("\n", lineStart);
                    if (lineEnd === -1) lineEnd = source.length;

                    let line = source.slice(lineStart, lineEnd);
                    if (stripTabs) line = line.replace(/^\t*/u, "");

                    if (line === delimiter) {
                        close = lineEnd;
                        closeStart = lineStart;
                        break;
                    }

                    if (lineEnd === source.length) break;

                    lineStart = lineEnd + 1;
                }

                if (close !== end.endIndex) {
                    // Tree-sitter can mistake an indented marker in the body for
                    // the terminator. Hold its enclosing top-level statement until
                    // completion rather than formatting these false boundaries.
                    holdEnclosingStatement(node);

                    if (close === undefined) unterminatedHeredoc = true;
                }

                if (close !== undefined && closeStart !== undefined) {
                    let literal: StatementLiteral = {
                        start: bodyStart,
                        end: close,
                        kind: "heredoc",
                        delimiter,
                    };
                    const descriptor = node.namedChildren.find(
                        (child) => child.type === "file_descriptor",
                    );
                    const owner = node.parent;
                    const command = owner?.childForFieldName("body");

                    if (
                        !node.hasError &&
                        command?.type === "command" &&
                        owner !== null &&
                        (descriptor === undefined || descriptor.text === "0")
                    )
                        literal = {
                            ...literal,
                            heredoc: {
                                command:
                                    source.slice(owner.startIndex, node.startIndex) +
                                    source.slice(opening.endIndex, headerEnd),
                                bodyEnd: closeStart,
                                quoted: /['"\\\\]/u.test(opening.text),
                                stripTabs,
                            },
                        };

                    literals.push(literal);
                }
            }

            // Expansions in a heredoc belong to its literal display payload, not
            // independently revealed or reindented statement bodies.
            for (const child of node.namedChildren)
                if (!["heredoc_body", "heredoc_end"].includes(child.type)) visit(child);

            return;
        }

        if (isStatementLiteral(node, language)) {
            if (/[\r\n]/u.test(node.text)) {
                let kind: StatementLiteral["kind"] = "string";
                if (node.type === "template_string") kind = "template";
                literals.push({ start: node.startIndex, end: node.endIndex, kind });
            }

            return;
        }

        for (const child of node.namedChildren) visit(child);
    }

    visit(root);
    literals.sort((left, right) => left.start - right.start || right.end - left.end);

    const disjoint: StatementLiteral[] = [];
    for (const literal of literals) {
        if (literal.start < (disjoint.at(-1)?.end ?? 0)) continue;
        disjoint.push(literal);
    }

    return { literals: disjoint, unsafeHeredocStart, unterminatedHeredoc };
}
