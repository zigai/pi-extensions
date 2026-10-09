import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type UserMessageEntry = SessionMessageEntry & {
    message: UserMessage;
};

function isUserMessageEntry(entry: SessionEntry): entry is UserMessageEntry {
    return entry.type === "message" && entry.message.role === "user";
}

function isTextContent(item: TextContent | ImageContent): item is TextContent {
    return item.type === "text";
}

function isTextMessageContent(
    content: UserMessage["content"],
): content is Extract<UserMessage["content"], string> {
    return typeof content === "string";
}

function extractText(content: UserMessage["content"]): string {
    if (isTextMessageContent(content)) return content.trim();
    return content
        .filter(isTextContent)
        .map((item) => item.text)
        .join("")
        .trim();
}

export function collectUserPromptsFromEntries(entries: SessionEntry[]): string[] {
    const prompts: string[] = [];

    for (const entry of entries) {
        if (!isUserMessageEntry(entry)) continue;

        const text = extractText(entry.message.content);
        if (text.length === 0) continue;
        prompts.push(text);
    }

    return prompts;
}
