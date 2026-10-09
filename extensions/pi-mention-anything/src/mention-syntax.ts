const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")", "}", "]"]);

export type ParsedMention = {
    readonly name: string;
    readonly suffix: string;
};

export type MentionPrefix = {
    readonly prefix: string;
    readonly query: string;
};

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function autocompleteTriggerCharacter(trigger: string): string {
    return Array.from(trigger)[0] ?? trigger;
}

export function mentionPattern(trigger: string): RegExp {
    return new RegExp(`(^|\\s)${escapeRegExp(trigger)}(?:"((?:\\\\.|[^"\\\\])*)"|([^\\s]+))`, "g");
}

function unescapeQuotedName(value: string): string {
    return value.replace(/\\(["\\])/g, "$1");
}

function escapeQuotedName(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isBareName(name: string, trigger: string): boolean {
    if (name.length === 0 || name.includes(trigger)) return false;
    return /^[^\s"'/]+$/.test(name);
}

export function formatMention(name: string, trigger: string): string {
    if (isBareName(name, trigger)) return `${trigger}${name}`;
    return `${trigger}"${escapeQuotedName(name)}"`;
}

function parseUnquotedName(
    rawName: string,
    knownNames: ReadonlySet<string>,
): ParsedMention | undefined {
    if (knownNames.has(rawName)) return { name: rawName, suffix: "" };

    let end = rawName.length;
    while (end > 0) {
        const last = rawName.at(end - 1);
        if (last === undefined || !TRAILING_PUNCTUATION.has(last)) break;

        end -= 1;

        const candidate = rawName.slice(0, end);
        if (knownNames.has(candidate)) {
            return { name: candidate, suffix: rawName.slice(end) };
        }
    }

    return undefined;
}

export function parseMentionName(
    quotedName: string | undefined,
    unquotedName: string | undefined,
    knownNames: ReadonlySet<string>,
): ParsedMention | undefined {
    if (quotedName !== undefined) {
        const name = unescapeQuotedName(quotedName);
        if (!knownNames.has(name)) return undefined;

        return { name, suffix: "" };
    }

    if (unquotedName === undefined) return undefined;
    return parseUnquotedName(unquotedName, knownNames);
}

export function extractMentionPrefix(
    textBeforeCursor: string,
    trigger: string,
): MentionPrefix | undefined {
    const escapedTrigger = escapeRegExp(trigger);
    const quotedMatch = new RegExp(`(?:^|\\s)(${escapedTrigger}"([^"]*)$)`).exec(textBeforeCursor);
    const quotedPrefix = quotedMatch?.at(1);
    const quotedQuery = quotedMatch?.at(2);
    if (quotedPrefix !== undefined && quotedQuery !== undefined) {
        return { prefix: quotedPrefix, query: quotedQuery };
    }

    const match = new RegExp(`(?:^|\\s)(${escapedTrigger}([^\\s"]*)$)`).exec(textBeforeCursor);
    const prefix = match?.at(1);
    const query = match?.at(2);
    if (prefix !== undefined && query !== undefined) {
        return { prefix, query };
    }

    return undefined;
}

export function isMentionContext(text: string, trigger: string): boolean {
    return extractMentionPrefix(text, trigger) !== undefined;
}
