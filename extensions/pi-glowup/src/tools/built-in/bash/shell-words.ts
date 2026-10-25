import { parse, type Node, type Redirect, type Word } from "unbash";
import { recordRenderError } from "../../../diagnostics/render-events.ts";

type ShellWord = Pick<Word, "pos" | "end" | "text">;

export function shellWords(source: string): readonly ShellWord[] {
    const words: ShellWord[] = [];
    const redirects = (items: readonly Redirect[]): void => {
        for (const redirect of items) {
            if (redirect.target !== undefined) words.push(redirect.target);
        }
    };

    const walk = (node: Node): void => {
        switch (node.type) {
            case "Statement":
                redirects(node.redirects);
                walk(node.command);
                return;
            case "Command":
                words.push(...node.prefix, ...node.suffix);

                if (node.name !== undefined) words.push(node.name);
                redirects(node.redirects);

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
                walk(node.body);
                return;
            case "Function":
                words.push(node.name);
                redirects(node.redirects);
                walk(node.body);
                return;
            case "Coproc":
                if (node.name !== undefined) words.push(node.name);
                redirects(node.redirects);
                walk(node.body);

                return;
            case "ArithmeticFor":
            case "BraceGroup":
            case "Subshell":
                walk(node.body);
                return;
            case "Case":
                words.push(node.word);

                for (const item of node.items) {
                    words.push(...item.pattern);
                    walk(item.body);
                }

                return;
            case "ArithmeticCommand":
            case "TestCommand":
                return;
        }
    };

    try {
        for (const statement of parse(source).commands) walk(statement);
    } catch (cause: unknown) {
        recordRenderError("bash.shell-words-parse", cause);
        return [];
    }

    return words.sort((left, right) => left.pos - right.pos);
}
