import { quoteSerializedValue } from "../parser.js";
import { resolveTypedCommandRoute } from "../command/subcommands.js";
import { formatArgumentFlagName, isPositionalArgument } from "../schema.js";
import type { PiTypedCommandLookup, RegisteredTypedCommand } from "./command-types.js";
import {
    commandInvocationForEditorText,
    type EditorTypedCommandInvocation,
} from "./editor-invocation.js";
import { activeChoiceContext, commandArgumentEntries } from "./helper.js";

/** Result of attempting to handle Tab as typed-command completion. */
export type TabCompletionResult = { handled: false } | { handled: true; editorText?: string };

type FlagCompletionCandidate = {
    stem: string;
    replacement: string;
};

type FlagCompletion = {
    replacement: string;
    addTrailingSpace: boolean;
};

function flagCompletionCandidates(
    command: RegisteredTypedCommand,
    token: string,
): FlagCompletionCandidate[] {
    const stem = token.replace(/^-+/, "");
    if (stem.length === 0) {
        return [];
    }

    const candidates: FlagCompletionCandidate[] = [];
    const seen = new Set<string>();
    for (const [name, definition] of commandArgumentEntries(command)) {
        if (isPositionalArgument(definition)) {
            continue;
        }

        const replacement = formatArgumentFlagName(name, definition);
        const primary = replacement.replace(/^--/, "");
        const searchable = [primary, ...(definition.aliases ?? [])];
        for (const item of searchable) {
            if (!item.startsWith(stem) || seen.has(replacement)) {
                continue;
            }

            seen.add(replacement);
            candidates.push({ stem: item, replacement });
        }
    }

    return candidates;
}

function commonStringPrefix(values: readonly string[]): string {
    const [first] = values;
    if (first === undefined) {
        return "";
    }

    let prefix = first;

    for (const value of values.slice(1)) {
        while (!value.startsWith(prefix)) {
            prefix = prefix.slice(0, -1);
            if (prefix.length === 0) {
                return "";
            }
        }
    }

    return prefix;
}

function flagCompletionForTab(
    command: RegisteredTypedCommand,
    token: string,
): FlagCompletion | undefined {
    const stem = token.replace(/^-+/, "");
    const candidates = flagCompletionCandidates(command, token);
    const exact = candidates.find((candidate) => candidate.stem === stem);
    if (exact !== undefined) {
        return { replacement: exact.replacement, addTrailingSpace: true };
    }

    if (candidates.length === 1) {
        const candidate = candidates[0];
        if (candidate === undefined) {
            return undefined;
        }

        return { replacement: candidate.replacement, addTrailingSpace: true };
    }

    const sharedPrefix = commonStringPrefix(candidates.map((candidate) => candidate.replacement));
    if (sharedPrefix.length > token.length) {
        return { replacement: sharedPrefix, addTrailingSpace: false };
    }

    return undefined;
}

function fixedChoiceCompletionOnTab(
    invocation: EditorTypedCommandInvocation,
    firstLine: string,
    rest: string,
): TabCompletionResult {
    const context = activeChoiceContext(invocation);
    if (context === undefined) {
        return { handled: false };
    }

    const candidates = context.definition.values.filter((value) => value.startsWith(context.query));
    if (candidates.length === 0) {
        return { handled: false };
    }

    let replacement: string | undefined;
    let addTrailingSpace = false;
    const exact = candidates.find((candidate) => candidate === context.query);
    if (exact !== undefined) {
        replacement = exact;
        addTrailingSpace = true;
    } else if (candidates.length === 1) {
        replacement = candidates[0];
        addTrailingSpace = true;
    } else {
        const sharedPrefix = commonStringPrefix(candidates);
        if (sharedPrefix.length > context.query.length) {
            replacement = sharedPrefix;
        }
    }

    if (replacement === undefined) {
        return { handled: context.query.length > 0 };
    }

    const serializedReplacement = quoteSerializedValue(replacement, replacement.startsWith("-"));
    const rawArgsOffset = firstLine.length - invocation.rawArgs.length;
    const replacementStart = rawArgsOffset + context.replacementStart;
    const replacementEnd = rawArgsOffset + context.replacementEnd;
    let completedLine = `${firstLine.slice(0, replacementStart)}${serializedReplacement}${firstLine.slice(replacementEnd)}`;
    if (addTrailingSpace && context.replacementEnd === invocation.rawArgs.length) {
        completedLine += " ";
    }

    return { handled: true, editorText: `${completedLine}${rest}` };
}

/** Complete a partial fixed choice or named flag in editor text when Tab is pressed. */
export function completeTypedCommandOnTab(
    editorText: string,
    commands: PiTypedCommandLookup,
): TabCompletionResult {
    const invocation = commandInvocationForEditorText(editorText, commands);
    if (invocation === undefined) {
        return { handled: false };
    }

    const firstLineEnd = editorText.indexOf("\n");
    let firstLine = editorText;
    let rest = "";
    if (firstLineEnd >= 0) {
        firstLine = editorText.slice(0, firstLineEnd);
        rest = editorText.slice(firstLineEnd);
    }

    const route = resolveTypedCommandRoute(invocation.command, invocation.rawArgs);
    if (invocation.command.subcommands !== undefined && route.status !== "subcommand") {
        const token = invocation.rawArgs.trim();
        if (!token.includes(" ") && !token.startsWith("-")) {
            const candidates = Object.entries(invocation.command.subcommands).flatMap(
                ([name, subcommand]) =>
                    [name, ...(subcommand.aliases ?? [])].filter((spelling) =>
                        spelling.startsWith(token),
                    ),
            );
            if (candidates.length === 0) {
                return { handled: false };
            }

            let replacement = commonStringPrefix(candidates);
            if (candidates.length === 1) {
                const onlyCandidate = candidates[0];
                if (onlyCandidate !== undefined) {
                    replacement = onlyCandidate;
                }
            }

            if (replacement !== undefined && replacement.length > token.length) {
                let trailingSpace = "";
                if (candidates.length === 1) {
                    trailingSpace = " ";
                }

                return {
                    handled: true,
                    editorText: `/${invocation.command.invocationName ?? invocation.command.name} ${replacement}${trailingSpace}${rest}`,
                };
            }

            if (token.length > 0) {
                return { handled: true };
            }
        }
    }

    let completionCommand = invocation.command;
    let completionInvocation = invocation;

    if (route.status === "subcommand" && route.subcommand !== undefined) {
        completionCommand =
            invocation.command.subcommands?.[route.subcommand] ?? invocation.command;
        completionInvocation = {
            command: completionCommand,
            rawArgs: route.rawArgs,
            trailingBody: invocation.trailingBody,
        };
    }

    const choiceCompletion = fixedChoiceCompletionOnTab(completionInvocation, firstLine, rest);
    if (choiceCompletion.handled) {
        return choiceCompletion;
    }

    const tokenMatch = /(?:^|\s)(-\S*)$/.exec(firstLine);
    if (tokenMatch === null) {
        return { handled: false };
    }

    const token = tokenMatch[1];
    if (token === undefined) {
        return { handled: false };
    }

    const completion = flagCompletionForTab(completionCommand, token);
    if (completion === undefined) {
        return { handled: true };
    }

    const tokenStart = firstLine.length - token.length;
    let completedLine = `${firstLine.slice(0, tokenStart)}${completion.replacement}`;
    if (completion.addTrailingSpace) {
        completedLine += " ";
    }

    return { handled: true, editorText: `${completedLine}${rest}` };
}
