import assert from "node:assert/strict";
import { test } from "vitest";

import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { collectUserPromptsFromEntries } from "../src/prompt-history.ts";

function entryBase(timestamp: number): Pick<SessionMessageEntry, "id" | "parentId" | "timestamp"> {
    return {
        id: `entry-${timestamp}`,
        parentId: null,
        timestamp: new Date(timestamp).toISOString(),
    };
}

function userEntry(content: UserMessage["content"], timestamp: number): SessionEntry {
    return {
        ...entryBase(timestamp),
        type: "message",
        message: {
            role: "user",
            content,
            timestamp,
        },
    };
}

function assistantEntry(content: string, timestamp: number): SessionEntry {
    const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: content }],
        api: "openai-completions",
        provider: "test",
        model: "test-model",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp,
    };

    return {
        ...entryBase(timestamp),
        type: "message",
        message,
    };
}

test("collectUserPromptsFromEntries keeps only non-empty user text", () => {
    const entries: SessionEntry[] = [
        userEntry("  first prompt  ", 10),
        assistantEntry("assistant response", 11),
        userEntry("   ", 12),
        userEntry(
            [
                { type: "text", text: "hello " },
                { type: "image", data: "ignored", mimeType: "image/png" },
                { type: "text", text: "world" },
            ],
            13,
        ),
    ];

    assert.deepEqual(collectUserPromptsFromEntries(entries), ["first prompt", "hello world"]);
});
