import { formatArgumentFlagName, isPositionalArgument } from "../schema.js";
import type {
    PiTypedCommandLookup,
    RegisteredTypedCommand,
} from "./command-types.js";
import { commandInvocationForEditorText } from "./editor-invocation.js";
import { commandArgumentEntries } from "./helper.js";

/** Result of attempting to handle Tab as typed-command flag completion. */
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

/** Complete a partial named flag in editor text when Tab is pressed. */
export function completePartialFlagOnTab(
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

    const tokenMatch = /(?:^|\s)(-\S*)$/.exec(firstLine);
    if (tokenMatch === null) {
        return { handled: false };
    }

    const token = tokenMatch[1];
    if (token === undefined) {
        return { handled: false };
    }

    const completion = flagCompletionForTab(invocation.command, token);
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
