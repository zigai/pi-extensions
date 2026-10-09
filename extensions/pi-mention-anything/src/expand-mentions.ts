import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import { mentionPattern, parseMentionName } from "./mention-syntax.ts";

export type MentionExpansionOptions<T> = {
    readonly trigger: string;
    readonly items: readonly T[];
    readonly nameOf: (item: T) => string;
    readonly replacementOf: (item: T) => string;
};

function itemMap<T>(items: readonly T[], nameOf: (item: T) => string): Map<string, T> {
    const byName = new Map<string, T>();
    for (const item of items) {
        const name = nameOf(item);
        if (!byName.has(name)) byName.set(name, item);
    }

    return byName;
}

export function expandMentions<T>(text: string, options: MentionExpansionOptions<T>): string {
    const byName = itemMap(options.items, options.nameOf);
    const knownNames = new Set(byName.keys());

    return text.replace(
        mentionPattern(options.trigger),
        (
            match: string,
            leading: string,
            quotedName: string | undefined,
            unquotedName: string | undefined,
        ) => {
            const parsed = parseMentionName(quotedName, unquotedName, knownNames);
            if (parsed === undefined) return match;

            const item = byName.get(parsed.name);
            if (item === undefined) return match;

            return `${leading}${options.replacementOf(item)}${parsed.suffix}`;
        },
    );
}

type ContextMessage = ContextEvent["messages"][number];
type UserContextMessage = Extract<ContextMessage, { role: "user" }>;
type UserContentBlock = Exclude<UserContextMessage["content"], string>[number];
type UserTextContentBlock = Extract<UserContentBlock, { type: "text" }>;

function isUserTextContentBlock(block: UserContentBlock): block is UserTextContentBlock {
    return block.type === "text";
}

type ParsedUserContent =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "blocks"; readonly blocks: UserContentBlock[] };

function parseUserContent(content: UserContextMessage["content"]): ParsedUserContent {
    if (Array.isArray(content)) return { kind: "blocks", blocks: content };

    return { kind: "text", text: content };
}

function firstRecentMessageIndex(messages: ContextEvent["messages"]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages.at(index);
        if (message?.role === "assistant" && message.stopReason !== "toolUse") return index + 1;
    }

    return 0;
}

function recentUserMessageIndexesWithTrigger(
    messages: ContextEvent["messages"],
    trigger: string,
): number[] {
    const indexes: number[] = [];
    for (let index = firstRecentMessageIndex(messages); index < messages.length; index += 1) {
        const message = messages.at(index);
        if (message?.role !== "user") continue;

        const content = parseUserContent(message.content);
        if (content.kind === "text") {
            if (content.text.includes(trigger)) indexes.push(index);
            continue;
        }

        if (
            content.blocks.some(
                (block) => isUserTextContentBlock(block) && block.text.includes(trigger),
            )
        ) {
            indexes.push(index);
        }
    }

    return indexes;
}

export function contextContainsMentionTrigger(
    messages: ContextEvent["messages"],
    trigger: string,
): boolean {
    return recentUserMessageIndexesWithTrigger(messages, trigger).length > 0;
}

function expandMentionsInUserMessage<T>(
    message: UserContextMessage,
    options: MentionExpansionOptions<T>,
): UserContextMessage {
    const parsedContent = parseUserContent(message.content);
    if (parsedContent.kind === "text") {
        const expanded = expandMentions(parsedContent.text, options);
        if (expanded === parsedContent.text) return message;

        return { ...message, content: expanded };
    }

    let changed = false;
    const content: UserContentBlock[] = [];
    for (const block of parsedContent.blocks) {
        if (!isUserTextContentBlock(block) || !block.text.includes(options.trigger)) {
            content.push(block);
            continue;
        }

        const expanded = expandMentions(block.text, options);
        if (expanded === block.text) {
            content.push(block);
            continue;
        }

        changed = true;
        content.push({ ...block, text: expanded });
    }

    if (!changed) return message;

    return { ...message, content };
}

export function expandMentionsInMessages<T>(
    messages: ContextEvent["messages"],
    options: MentionExpansionOptions<T>,
): ContextEvent["messages"] {
    const indexes = recentUserMessageIndexesWithTrigger(messages, options.trigger);
    if (indexes.length === 0) return messages;

    let expandedMessages: ContextEvent["messages"] | undefined;
    for (const index of indexes) {
        const message = messages.at(index);
        if (message?.role !== "user") continue;

        const expanded = expandMentionsInUserMessage(message, options);
        if (expanded === message) continue;

        expandedMessages ??= [...messages];
        expandedMessages[index] = expanded;
    }

    return expandedMessages ?? messages;
}
