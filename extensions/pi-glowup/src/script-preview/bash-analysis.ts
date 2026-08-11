import { parse, type CompoundList, type If, type Node, type ParsedScript } from "unbash";

import { parseScriptInvocation, type ScriptInvocation } from "../rendering/core.ts";

export type ShellLayout = "preserve" | "auto" | "always";

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
): number | undefined {
    const match = new RegExp(`\\b${keyword}\\b`, "gu").exec(source.slice(start, end));
    return match === null ? undefined : start + match.index;
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
    readonly #source: string;
    #structurallyComplex = false;

    constructor(source: string) {
        this.#source = source;
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
            const elseIndex = keywordIndex(this.#source, node.then.end, node.else.pos, "else");
            if (elseIndex !== undefined) this.add(elseIndex, indent);
            this.add(node.else.pos, indent + 1);
            this.walkCompoundList(node.else, indent + 1, depth + 1);
            closingSearchStart = node.else.end;
        }
        const closingIndex = keywordIndex(this.#source, closingSearchStart, node.end, "fi");
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
        const closingIndex = keywordIndex(this.#source, node.body.end, node.end, closingKeyword);
        if (closingIndex !== undefined) this.add(closingIndex, indent);
    }

    walkNode(node: Node, indent: number, depth: number): void {
        if (depth > MAX_LAYOUT_DEPTH) return;
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
                            if (boundary !== undefined) this.add(boundary, indent);
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
                        if (terminator !== undefined) this.add(terminator, indent + 2);
                    }
                }
                const finalItemEnd = node.items.at(-1)?.end ?? node.word.end;
                const closingIndex = keywordIndex(this.#source, finalItemEnd, node.end, "esac");
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

    render(): string | undefined {
        const breakpoints: DisplayBreakpoint[] = [...this.#breakpoints]
            .map(([index, indent]) => ({ index, indent }))
            .sort((left, right) => left.index - right.index);
        if (breakpoints.length === 0) return undefined;

        const lines: string[] = [];
        let start = 0;
        let indent = 0;
        for (const breakpoint of breakpoints) {
            const text = this.#source.slice(start, breakpoint.index).trim();
            if (text.length > 0) lines.push(`${INDENT.repeat(indent)}${text}`);
            start = breakpoint.index;
            indent = breakpoint.indent;
        }
        const tail = this.#source.slice(start).trim();
        if (tail.length > 0) lines.push(`${INDENT.repeat(indent)}${tail}`);
        return lines.length > 1 ? lines.join("\n") : undefined;
    }
}

type BashLayoutAnalysis = {
    readonly reflowedCommand: string | undefined;
    readonly structurallyComplex: boolean;
};

function analyzeBashLayout(command: string): BashLayoutAnalysis {
    const unchanged = { reflowedCommand: undefined, structurallyComplex: false } as const;
    if (
        command.includes("\n") ||
        command.trim().length === 0 ||
        command.length > MAX_LAYOUT_SOURCE_CHARACTERS
    ) {
        return unchanged;
    }

    let script: ParsedScript;
    try {
        script = parse(command);
    } catch {
        return unchanged;
    }
    if ((script.errors?.length ?? 0) > 0) return unchanged;

    const collector = new BashLayoutCollector(command);
    collector.walkScript(script);
    return {
        reflowedCommand: collector.render(),
        structurallyComplex: collector.structurallyComplex,
    };
}

/** Reflows a complete one-line Bash program while retaining its original non-whitespace text. */
export function reflowBashCommand(command: string): string | undefined {
    return analyzeBashLayout(command).reflowedCommand;
}

/** Identifies clean standalone language calls and a safe display-only Bash reflow. */
export function analyzeBashCommand(command: string): BashCommandAnalysis {
    const pureScript = parseScriptInvocation(command);
    const layout = pureScript === undefined ? analyzeBashLayout(command) : undefined;
    return {
        command,
        pureScript,
        reflowedCommand: layout?.reflowedCommand,
        structurallyComplex: layout?.structurallyComplex ?? false,
    };
}
