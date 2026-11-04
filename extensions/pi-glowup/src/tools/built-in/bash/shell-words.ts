import {
    parse,
    type Node,
    type ArithmeticExpression,
    type TestExpression,
    type ParsedScript,
    type Redirect,
    type Word,
    type WordPart,
} from "unbash";
import { recordRenderError } from "../../../diagnostics/render-events.ts";

type ShellWord = Pick<Word, "pos" | "end" | "text">;

function shellSyntax(source: string, includeNested = false) {
    const words: ShellWord[] = [];
    const heredocs: { redirect: Redirect; headerEnd: number; script: ParsedScript }[] = [];
    const commands = new Map<ParsedScript, { pos: number; end: number }[]>();
    let currentScript: ParsedScript | undefined;
    const redirects = (items: readonly Redirect[], headerEnd: number): void => {
        for (const redirect of items) {
            if (redirect.target !== undefined) {
                words.push(redirect.target);
                visitWord(redirect.target);
            }

            if (redirect.heredocQuoted !== true && redirect.body !== undefined)
                visitWord(redirect.body);

            if (
                (redirect.operator === "<<" || redirect.operator === "<<-") &&
                currentScript !== undefined
            )
                heredocs.push({ redirect, headerEnd, script: currentScript });
        }
    };

    const walk = (node: Node): void => {
        switch (node.type) {
            case "Statement":
                redirects(node.redirects, node.end);
                walk(node.command);
                return;
            case "Command":
                if (includeNested && currentScript !== undefined) {
                    const scriptCommands = commands.get(currentScript) ?? [];
                    scriptCommands.push(node);
                    commands.set(currentScript, scriptCommands);
                }

                words.push(...node.prefix, ...node.suffix);

                for (const assignment of node.prefix) {
                    if (assignment.value !== undefined) visitWord(assignment.value);

                    for (const word of assignment.array ?? []) visitWord(word);
                    visitParts(assignment.indexParts ?? []);
                }

                for (const word of node.suffix) visitWord(word);

                if (node.name !== undefined) {
                    words.push(node.name);
                    visitWord(node.name);
                }

                redirects(node.redirects, node.end);

                return;
            case "Pipeline":
            case "AndOr":
            case "CompoundList":
                for (const child of node.commands) walk(child);

                return;
            case "If":
                walk(node.clause);
                walk(node.then);

                if (node.else !== undefined) walk(node.else);
                return;
            case "While":
                walk(node.clause);
                walk(node.body);
                return;
            case "For":
            case "Select":
                words.push(node.name, ...node.wordlist);
                visitWord(node.name);

                for (const word of node.wordlist) visitWord(word);
                walk(node.body);

                return;
            case "Function":
                words.push(node.name);
                redirects(node.redirects, node.end);
                walk(node.body);
                return;
            case "Coproc":
                if (node.name !== undefined) words.push(node.name);
                redirects(node.redirects, node.end);
                walk(node.body);

                return;
            case "ArithmeticFor":
                visitArithmetic(node.initialize);
                visitArithmetic(node.test);
                visitArithmetic(node.update);
                walk(node.body);
                return;
            case "BraceGroup":
            case "Subshell":
                walk(node.body);
                return;
            case "Case":
                words.push(node.word);
                visitWord(node.word);

                for (const item of node.items) {
                    words.push(...item.pattern);

                    for (const word of item.pattern) visitWord(word);
                    walk(item.body);
                }

                return;
            case "ArithmeticCommand":
                visitArithmetic(node.expression);
                return;
            case "TestCommand":
                visitTest(node.expression);
                return;
        }
    };

    const visitWord = (word: Word): void => {
        if (includeNested) visitParts(word.parts ?? []);
    };

    const visitScript = (script: ParsedScript | undefined): void => {
        if (!includeNested || script === undefined || script.source !== undefined) return;

        const previous = currentScript;
        currentScript = script;

        for (const statement of script.commands) walk(statement);
        currentScript = previous;
    };

    const visitArithmetic = (expression: ArithmeticExpression | undefined): void => {
        if (!includeNested || expression === undefined) return;

        switch (expression.type) {
            case "ArithmeticCommandExpansion":
                visitScript(expression.script);
                return;
            case "ArithmeticWord":
                visitParts(expression.parts ?? []);
                return;
            case "ArithmeticBinary":
                visitArithmetic(expression.left);
                visitArithmetic(expression.right);
                return;
            case "ArithmeticUnary":
                visitArithmetic(expression.operand);
                return;
            case "ArithmeticTernary":
                visitArithmetic(expression.test);
                visitArithmetic(expression.consequent);
                visitArithmetic(expression.alternate);
                return;
            case "ArithmeticGroup":
                visitArithmetic(expression.expression);
                return;
        }
    };

    const visitTest = (expression: TestExpression): void => {
        if (!includeNested) return;

        switch (expression.type) {
            case "TestUnary":
                visitWord(expression.operand);
                return;
            case "TestBinary":
                visitWord(expression.left);
                visitWord(expression.right);
                return;
            case "TestLogical":
                visitTest(expression.left);
                visitTest(expression.right);
                return;
            case "TestNot":
                visitTest(expression.operand);
                return;
            case "TestGroup":
                visitTest(expression.expression);
                return;
        }
    };

    const visitParts = (parts: readonly WordPart[]): void => {
        if (!includeNested) return;

        for (const part of parts) {
            if (part.type === "CommandExpansion" || part.type === "ProcessSubstitution") {
                visitScript(part.script);
            } else if (part.type === "ArithmeticExpansion") {
                visitArithmetic(part.expression);
            } else if (part.type === "ParameterExpansion") {
                visitParts(part.indexParts ?? []);

                if (part.operand !== undefined) visitWord(part.operand);

                if (part.slice !== undefined) {
                    visitWord(part.slice.offset);

                    if (part.slice.length !== undefined) visitWord(part.slice.length);
                }

                if (part.replace !== undefined) {
                    visitWord(part.replace.pattern);
                    visitWord(part.replace.replacement);
                }
            } else if ("parts" in part) visitParts(part.parts ?? []);
        }
    };

    try {
        currentScript = parse(source);
        for (const statement of currentScript.commands) walk(statement);
    } catch (cause: unknown) {
        recordRenderError("bash.shell-words-parse", cause);
        return {
            words: [],
            heredocs: [],
            commands: new Map<ParsedScript, { pos: number; end: number }[]>(),
        };
    }

    words.sort((left, right) => left.pos - right.pos);
    heredocs.sort((left, right) => left.redirect.pos - right.redirect.pos);

    for (const items of commands.values()) items.sort((left, right) => left.pos - right.pos);

    return { words, heredocs, commands };
}

export function shellWords(source: string): readonly ShellWord[] {
    return shellSyntax(source).words;
}

export function heredocBodyRows(source: string): ReadonlySet<number> {
    const rows = new Set<number>();
    const ends = new Map<ParsedScript, Map<number, { offset: number; row: number }>>();
    const headers = new Map<
        ParsedScript,
        { commandIndex: number; resolved: Map<number, number> }
    >();
    const syntax = shellSyntax(source, true);
    if (syntax.heredocs.length === 0) return rows;

    // Index newlines once instead of splitting the entire prefix for every body.
    const lineRows = new Map<number, number>();
    for (let end = source.indexOf("\n"); end >= 0; end = source.indexOf("\n", end + 1))
        lineRows.set(end, lineRows.size);

    for (const { redirect, headerEnd: commandEnd, script } of syntax.heredocs) {
        let headerEnd = source.indexOf("\n", commandEnd);
        let scriptHeaders = headers.get(script);
        if (scriptHeaders === undefined) {
            scriptHeaders = { commandIndex: 0, resolved: new Map() };
            headers.set(script, scriptHeaders);
        }

        const resolved = scriptHeaders.resolved.get(headerEnd);
        if (resolved !== undefined) headerEnd = resolved;
        else {
            const commands = syntax.commands.get(script) ?? [];

            // Redirects are source-ordered, so commands preceding this redirect can
            // be retired permanently. Cache shared headers for multiple heredocs.
            while (
                scriptHeaders.commandIndex < commands.length &&
                commands[scriptHeaders.commandIndex]!.pos <= redirect.pos
            )
                scriptHeaders.commandIndex++;

            const initialEnd = headerEnd;

            for (let index = scriptHeaders.commandIndex; index < commands.length; index++) {
                const command = commands[index]!;
                if (headerEnd < 0 || command.pos > headerEnd) break;

                if (command.end > headerEnd) headerEnd = source.indexOf("\n", command.end);
            }

            scriptHeaders.resolved.set(initialEnd, headerEnd);
        }

        const marker = redirect.target?.value;
        if (headerEnd < 0 || marker === undefined) continue;

        let scriptEnds = ends.get(script);
        if (scriptEnds === undefined) {
            scriptEnds = new Map();
            ends.set(script, scriptEnds);
        }

        const previous = scriptEnds.get(headerEnd);
        let offset = previous?.offset ?? headerEnd + 1;
        let row = previous?.row ?? lineRows.get(headerEnd)! + 1;
        while (offset < source.length) {
            let end = source.indexOf("\n", offset);
            if (end < 0) end = source.length;

            let line = source.slice(offset, end);
            if (redirect.operator === "<<-") line = line.replace(/^\t*/u, "");

            if (line === marker) {
                scriptEnds.set(headerEnd, {
                    offset: Math.min(source.length, end + 1),
                    row: row + 1,
                });
                break;
            }

            if (redirect.heredocQuoted === true) rows.add(row);
            offset = end + 1;
            row++;
        }

        if (offset >= source.length) scriptEnds.set(headerEnd, { offset: source.length, row });
    }

    return rows;
}
