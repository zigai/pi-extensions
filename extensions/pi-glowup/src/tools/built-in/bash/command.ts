import {
    parse,
    type CompoundList,
    type If,
    type Node,
    type ParsedScript,
    type Redirect,
} from "unbash";

import { parseScriptInvocation, type ScriptInvocation } from "./invocation.ts";

export type ShellLayout = "preserve" | "auto" | "always";
export type ShellOperatorPosition = "trailing" | "leading";
export type ShellOutputStyle = "terminal" | "gutter";

export type BashCommandAnalysis = {
    readonly command: string;
    readonly pureScript: ScriptInvocation | undefined;
    readonly reflowedCommand: string | undefined;
    readonly structurallyComplex: boolean;
};

type DisplayBreakpoint = {
    readonly index: number;
    readonly indent: number;
};

const MAX_LAYOUT_SOURCE_CHARACTERS = 256 * 1024;
const MAX_LAYOUT_BREAKPOINTS = 1_000;
const MAX_LAYOUT_DEPTH = 32;
const INDENT = "  ";

function keywordIndex(
    source: string,
    start: number,
    end: number,
    keyword: string,
    protectedRanges: readonly { readonly start: number; readonly end: number }[],
): number | undefined {
    let index = start;
    while (index < end) {
        const protectedRange = protectedRanges.find(
            (range) => index >= range.start && index < range.end,
        );
        if (protectedRange !== undefined) {
            index = protectedRange.end;
        } else if (/[\s;&]/u.test(source[index] ?? "")) {
            index += 1;
        } else if (source[index] === "#") {
            const newline = source.indexOf("\n", index);
            if (newline < 0) return undefined;

            index = newline + 1;
        } else if (source.startsWith("\\\n", index)) {
            index += 2;
        } else {
            const keywordEnd = index + keyword.length;
            if (
                keywordEnd <= end &&
                source.slice(index, keywordEnd) === keyword &&
                (keywordEnd === end || /[\s;&|()<>]/u.test(source[keywordEnd] ?? ""))
            )
                return index;

            return undefined;
        }
    }

    return undefined;
}

function operatorIndex(
    source: string,
    start: number,
    end: number,
    operator: string,
): number | undefined {
    const index = source.indexOf(operator, start);
    return index >= start && index < end ? index : undefined;
}

class BashLayoutCollector {
    readonly #breakpoints = new Map<number, number>();
    readonly #heredocs: Redirect[] = [];
    readonly #source: string;
    readonly #operatorPosition: ShellOperatorPosition;
    #structurallyComplex = false;

    constructor(source: string, operatorPosition: ShellOperatorPosition) {
        this.#source = source;
        this.#operatorPosition = operatorPosition;
    }

    add(index: number, indent: number): void {
        if (
            index <= 0 ||
            index >= this.#source.length ||
            this.#breakpoints.size >= MAX_LAYOUT_BREAKPOINTS
        ) {
            return;
        }

        const normalizedIndent = Math.max(0, Math.min(MAX_LAYOUT_DEPTH, indent));
        const existing = this.#breakpoints.get(index);
        this.#breakpoints.set(
            index,
            existing === undefined ? normalizedIndent : Math.min(existing, normalizedIndent),
        );
    }

    addOperator(index: number, operator: string, indent: number): void {
        this.add(this.#operatorPosition === "trailing" ? index + operator.length : index, indent);
    }

    get structurallyComplex(): boolean {
        return this.#structurallyComplex;
    }

    walkScript(script: ParsedScript): void {
        if (script.commands.length > 1) this.#structurallyComplex = true;

        for (const [index, statement] of script.commands.entries()) {
            if (index > 0) this.add(statement.pos, 0);
            this.walkNode(statement, 0, 0);
        }
    }

    walkCompoundList(list: CompoundList, indent: number, depth: number): void {
        if (depth > MAX_LAYOUT_DEPTH) return;

        for (const [index, statement] of list.commands.entries()) {
            if (index > 0) this.add(statement.pos, indent);
            this.walkNode(statement, indent, depth + 1);
        }
    }

    keywordIndex(start: number, end: number, keyword: string): number | undefined {
        const ranges = this.heredocRanges();
        if (ranges === undefined) return undefined;
        return keywordIndex(this.#source, start, end, keyword, ranges);
    }

    walkIf(node: If, indent: number, depth: number): void {
        this.walkCompoundList(node.clause, indent + 1, depth + 1);
        this.add(node.then.pos, indent + 1);
        this.walkCompoundList(node.then, indent + 1, depth + 1);

        if (node.else?.type === "If") {
            this.add(node.else.pos, indent);
            this.walkIf(node.else, indent, depth + 1);
            return;
        }

        let closingSearchStart = node.then.end;
        if (node.else !== undefined) {
            const elseIndex = this.keywordIndex(node.then.end, node.else.pos, "else");
            if (elseIndex !== undefined) this.add(elseIndex, indent);
            this.add(node.else.pos, indent + 1);
            this.walkCompoundList(node.else, indent + 1, depth + 1);
            closingSearchStart = node.else.end;
        }

        const closingIndex = this.keywordIndex(closingSearchStart, node.end, "fi");
        if (closingIndex !== undefined) this.add(closingIndex, indent);
    }

    walkBodyWithClosingKeyword(
        node: { readonly body: CompoundList; readonly end: number },
        indent: number,
        depth: number,
        closingKeyword: string,
    ): void {
        this.add(node.body.pos, indent + 1);
        this.walkCompoundList(node.body, indent + 1, depth + 1);
        const closingIndex = this.keywordIndex(node.body.end, node.end, closingKeyword);
        if (closingIndex !== undefined) this.add(closingIndex, indent);
    }

    walkNode(node: Node, indent: number, depth: number): void {
        if (depth > MAX_LAYOUT_DEPTH) return;

        if ("redirects" in node) {
            this.#heredocs.push(
                ...node.redirects.filter(
                    (redirect) => redirect.operator === "<<" || redirect.operator === "<<-",
                ),
            );
        }

        switch (node.type) {
            case "Statement":
                this.walkNode(node.command, indent, depth + 1);
                return;
            case "AndOr": {
                const hasStepBoundary = node.operators.includes("&&");
                if (node.commands.length >= 3 && hasStepBoundary) {
                    this.#structurallyComplex = true;
                }

                for (const [index, command] of node.commands.entries()) {
                    if (index > 0) {
                        const previous = node.commands[index - 1];
                        const operator = node.operators[index - 1];
                        if (previous !== undefined && operator === "&&") {
                            const boundary = operatorIndex(
                                this.#source,
                                previous.end,
                                command.pos,
                                operator,
                            );
                            if (boundary !== undefined) {
                                this.addOperator(boundary, operator, indent);
                            }
                        }
                    }

                    this.walkNode(command, indent, depth + 1);
                }

                return;
            }
            case "Pipeline":
                for (const command of node.commands) {
                    this.walkNode(command, indent, depth + 1);
                }

                return;
            case "If":
                this.#structurallyComplex = true;
                this.walkIf(node, indent, depth + 1);
                return;
            case "For":
            case "ArithmeticFor":
            case "Select":
            case "While":
                this.#structurallyComplex = true;
                this.walkBodyWithClosingKeyword(node, indent, depth + 1, "done");
                return;
            case "Case": {
                this.#structurallyComplex = true;

                for (const item of node.items) {
                    this.add(item.pos, indent + 1);
                    this.add(item.body.pos, indent + 2);
                    this.walkCompoundList(item.body, indent + 2, depth + 1);

                    if (item.terminator !== undefined) {
                        const terminator = operatorIndex(
                            this.#source,
                            item.body.end,
                            item.end,
                            item.terminator,
                        );
                        if (terminator !== undefined) {
                            this.addOperator(terminator, item.terminator, indent + 2);
                        }
                    }
                }

                const finalItemEnd = node.items.at(-1)?.end ?? node.word.end;
                const closingIndex = this.keywordIndex(finalItemEnd, node.end, "esac");
                if (closingIndex !== undefined) this.add(closingIndex, indent);
                return;
            }
            case "Function":
            case "Coproc":
                this.#structurallyComplex = true;
                this.walkNode(node.body, indent, depth + 1);
                return;
            case "BraceGroup": {
                this.#structurallyComplex = true;
                this.add(node.body.pos, indent + 1);
                this.walkCompoundList(node.body, indent + 1, depth + 1);

                const closingIndex = this.#source.lastIndexOf("}", node.end - 1);
                if (closingIndex >= node.body.end) this.add(closingIndex, indent);
                return;
            }
            case "Subshell": {
                this.#structurallyComplex = true;
                this.add(node.body.pos, indent + 1);
                this.walkCompoundList(node.body, indent + 1, depth + 1);

                const closingIndex = this.#source.lastIndexOf(")", node.end - 1);
                if (closingIndex >= node.body.end) this.add(closingIndex, indent);
                return;
            }
            case "CompoundList":
                this.walkCompoundList(node, indent, depth + 1);
                return;
            case "Command":
            case "TestCommand":
            case "ArithmeticCommand":
                return;
        }
    }

    heredocRanges(): Array<{ start: number; end: number }> | undefined {
        const protectedRanges: Array<{ start: number; end: number }> = [];
        const headerEnds = new Map<number, number>();
        for (const heredoc of this.#heredocs.sort((left, right) => left.pos - right.pos)) {
            const headerEnd = this.#source.indexOf("\n", heredoc.end);
            if (headerEnd < 0 || heredoc.content === undefined) return undefined;

            const bodyStart = this.#source.indexOf(
                heredoc.content,
                headerEnds.get(headerEnd) ?? headerEnd + 1,
            );
            if (bodyStart < 0) return undefined;

            const bodyEnd = bodyStart + heredoc.content.length;
            const delimiterEnd = this.#source.indexOf("\n", bodyEnd);
            let end = this.#source.length;
            if (delimiterEnd >= 0) end = delimiterEnd + 1;
            protectedRanges.push({ start: heredoc.pos, end });
            headerEnds.set(headerEnd, end);
        }

        return protectedRanges;
    }

    render(): string | undefined {
        const breakpoints: DisplayBreakpoint[] = [...this.#breakpoints]
            .map(([index, indent]) => ({ index, indent }))
            .sort((left, right) => left.index - right.index);
        if (breakpoints.length === 0) return undefined;

        const protectedRanges = this.heredocRanges();
        if (protectedRanges === undefined) return undefined;

        let rendered = "";
        let start = 0;
        let changed = false;
        for (const breakpoint of breakpoints) {
            if (
                protectedRanges.some(
                    (range) => breakpoint.index > range.start && breakpoint.index < range.end,
                )
            )
                continue;

            if (breakpoint.index <= start) {
                rendered = rendered.replace(/[\t ]*$/u, INDENT.repeat(breakpoint.indent));
                continue;
            }

            const segment = this.#source.slice(start, breakpoint.index);

            start = breakpoint.index;
            if (/\n[\t ]*$/u.test(segment) || /^[\t ]*\r?\n/u.test(this.#source.slice(start))) {
                rendered += segment;
            } else {
                rendered += `${segment.replace(/[\t ]+$/u, "")}\n${INDENT.repeat(breakpoint.indent)}`;

                while (this.#source[start] === " " || this.#source[start] === "\t") start += 1;
                changed = true;
            }
        }

        rendered += this.#source.slice(start);
        if (changed) return rendered;
        return undefined;
    }
}

type BashLayoutAnalysis = {
    readonly reflowedCommand: string | undefined;
    readonly structurallyComplex: boolean;
};

function analyzeBashLayout(
    command: string,
    operatorPosition: ShellOperatorPosition,
): BashLayoutAnalysis {
    const unchanged = { reflowedCommand: undefined, structurallyComplex: false } as const;
    if (command.trim().length === 0 || command.length > MAX_LAYOUT_SOURCE_CHARACTERS) {
        return unchanged;
    }

    let script: ParsedScript;
    try {
        script = parse(command);
    } catch {
        return unchanged;
    }

    if ((script.errors?.length ?? 0) > 0) return unchanged;

    const collector = new BashLayoutCollector(command, operatorPosition);
    collector.walkScript(script);

    return {
        reflowedCommand: collector.render(),
        structurallyComplex: collector.structurallyComplex,
    };
}

/** Reflows a complete Bash program while preserving quoted text and heredoc content. */
export function reflowBashCommand(
    command: string,
    operatorPosition: ShellOperatorPosition = "trailing",
): string | undefined {
    return analyzeBashLayout(command, operatorPosition).reflowedCommand;
}

/** Identifies clean standalone language calls and a safe display-only Bash reflow. */
export function analyzeBashCommand(
    command: string,
    operatorPosition: ShellOperatorPosition = "trailing",
): BashCommandAnalysis {
    const pureScript = parseScriptInvocation(command);
    const layout =
        pureScript === undefined ? analyzeBashLayout(command, operatorPosition) : undefined;
    return {
        command,
        pureScript,
        reflowedCommand: layout?.reflowedCommand,
        structurallyComplex: layout?.structurallyComplex ?? false,
    };
}
