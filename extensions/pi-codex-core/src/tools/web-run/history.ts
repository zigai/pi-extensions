import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { CodexTokenizer, TokenizerOperationOptions } from "../../compaction/tokenizer.ts";
import { compileSchema } from "../../schema-parsing.ts";

const ASSISTANT_CONTEXT_TOKEN_LIMIT = 1_000;

const MessageSchema = compileSchema(
    Type.Object({
        role: Type.String(),
        content: Type.Union([Type.String(), Type.Array(Type.Unknown())]),
    }),
);
const TextBlockSchema = compileSchema(
    Type.Object({ type: Type.Literal("text"), text: Type.String() }),
);

type VisibleMessage = {
    readonly role: "user" | "assistant";
    readonly text: string;
};

export type WebSearchInputItem = {
    readonly type: "message";
    readonly role: "user" | "assistant";
    readonly content: readonly [
        {
            readonly type: "input_text" | "output_text";
            readonly text: string;
        },
    ];
};

/** Build the same visible two-user-message history tail used by Codex web.run. */
export async function recentWebSearchInput(
    ctx: ExtensionContext,
    tokenizer: CodexTokenizer,
    options: TokenizerOperationOptions = {},
): Promise<readonly WebSearchInputItem[] | undefined> {
    const messages = ctx.sessionManager.getBranch().flatMap((entry) => visibleMessage(entry) ?? []);
    const latestUserIndex = findPreviousUserIndex(messages, messages.length);
    if (latestUserIndex < 0) return undefined;

    const previousUserIndex = findPreviousUserIndex(messages, latestUserIndex);
    const retained = messages.slice(
        previousUserIndex >= 0 ? previousUserIndex : latestUserIndex,
        latestUserIndex + 1,
    );
    const input: WebSearchInputItem[] = [];
    let assistantTokensRemaining = ASSISTANT_CONTEXT_TOKEN_LIMIT;

    for (const message of retained) {
        let text = message.text;
        if (message.role === "assistant") {
            if (assistantTokensRemaining <= 0) continue;
            const tokenCount = await tokenizer.count(text, options);
            if (tokenCount > assistantTokensRemaining) {
                text = await tokenizer.truncate(text, assistantTokensRemaining, options);
                assistantTokensRemaining = 0;
            } else {
                assistantTokensRemaining -= tokenCount;
            }
            if (text.length === 0) continue;
        }
        input.push({
            type: "message",
            role: message.role,
            content: [
                {
                    type: message.role === "user" ? "input_text" : "output_text",
                    text,
                },
            ],
        });
    }
    return input.length > 0 ? input : undefined;
}

function findPreviousUserIndex(messages: readonly VisibleMessage[], before: number): number {
    for (let index = before - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === "user") return index;
    }
    return -1;
}

function visibleMessage(entry: SessionEntry): VisibleMessage | undefined {
    if (entry.type !== "message") return undefined;
    const message = MessageSchema.decode(entry.message);
    if (!message || (message.role !== "user" && message.role !== "assistant")) return undefined;
    const text = textFromContent(message.content);
    return text ? { role: message.role, text } : undefined;
}

function textFromContent(content: string | unknown[]): string | undefined {
    if (!Array.isArray(content)) return content.trim() || undefined;
    const text = content
        .flatMap((item) => {
            const block = TextBlockSchema.decode(item);
            return block ? [block.text] : [];
        })
        .join("\n")
        .trim();
    return text.length > 0 ? text : undefined;
}
