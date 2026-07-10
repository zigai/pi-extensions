import type {
    ExtensionContext,
    SessionBeforeCompactEvent,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { compileSchema, parseWithSchema } from "../schema-parsing.ts";
import { NATIVE_COMPACTION_SHIM_SUMMARY } from "./messages.ts";
import type {
    BuildPromptInputResult,
    CompactionContentBlock,
    CompactionMessage,
    CompactionMessageContent,
    FoundNativeCompactionEntry,
    JsonObject,
    JsonValue,
    ResponsesInputItem,
    ResponsesPayload,
} from "./types.ts";

const COMPACTION_SUMMARY_PREFIX =
    "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const BRANCH_SUMMARY_PREFIX =
    "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "</summary>";

const JsonObjectSchema = Type.Record(Type.String(), Type.Unknown());
const JsonObjectValidator = compileSchema(JsonObjectSchema);

export function buildRemoteCompactionPromptInput(
    event: SessionBeforeCompactEvent,
    model: ExtensionContext["model"] | undefined,
    latestNativeCompaction: FoundNativeCompactionEntry | undefined,
): BuildPromptInputResult {
    if (latestNativeCompaction) {
        return {
            input: [
                ...latestNativeCompaction.entry.details.compactedWindow,
                ...serializeEntriesToResponsesInput(
                    model,
                    event.branchEntries.slice(latestNativeCompaction.index + 1),
                ),
            ],
            previousCompactionEntryId: latestNativeCompaction.entry.id,
        };
    }

    const messages: CompactionMessage[] = [];
    if (event.preparation.previousSummary) {
        messages.push(compactionSummaryMessage(event.preparation.previousSummary));
    }
    for (const rawMessage of [
        ...event.preparation.messagesToSummarize,
        ...event.preparation.turnPrefixMessages,
    ]) {
        const message = parseCompactionMessage(rawMessage);
        if (message) messages.push(message);
    }

    const firstKeptEntryIndex = event.branchEntries.findIndex(
        (entry) => entry.id === event.preparation.firstKeptEntryId,
    );
    if (firstKeptEntryIndex >= 0) {
        for (const message of compactionMessagesFromSessionEntries(
            event.branchEntries
                .slice(firstKeptEntryIndex)
                .filter((entry) => entry.type !== "compaction"),
        )) {
            messages.push(message);
        }
    }
    return { input: serializeMessagesToResponsesInput(model, messages) };
}

export function serializeEntriesToResponsesInput(
    model: ExtensionContext["model"] | undefined,
    entries: readonly SessionEntry[],
): ResponsesInputItem[] {
    return serializeMessagesToResponsesInput(model, compactionMessagesFromSessionEntries(entries));
}

function* compactionMessagesFromSessionEntries(
    entries: readonly SessionEntry[],
): Generator<CompactionMessage> {
    for (const entry of entries) {
        const message = compactionMessageFromSessionEntry(entry);
        if (message) yield message;
    }
}

function serializeMessagesToResponsesInput(
    model: ExtensionContext["model"] | undefined,
    messages: Iterable<CompactionMessage>,
): ResponsesInputItem[] {
    const input: ResponsesInputItem[] = [];
    const toolCallIdMap = new Map<string, string>();
    let pendingToolCalls: ResponsesInputItem[] = [];
    let existingToolResultIds = new Set<string>();
    let messageIndex = 0;

    const serializeNormalizedMessage = (message: CompactionMessage) => {
        input.push(...serializeMessage(message, messageIndex, model));
        messageIndex += 1;
    };

    const insertSyntheticToolResults = () => {
        if (pendingToolCalls.length === 0) return;
        for (const toolCall of pendingToolCalls) {
            const id = typeof toolCall.call_id === "string" ? toolCall.call_id : undefined;
            if (id && !existingToolResultIds.has(id)) {
                serializeNormalizedMessage({
                    role: "toolResult",
                    toolCallId: id,
                    content: [{ type: "text", text: "No result provided" }],
                });
            }
        }
        pendingToolCalls = [];
        existingToolResultIds = new Set();
    };

    for (const rawMessage of messages) {
        const message = transformMessageForResponses(model, rawMessage, toolCallIdMap);
        if (message.role === "assistant") {
            insertSyntheticToolResults();
            if (message.stopReason === "error" || message.stopReason === "aborted") continue;
            pendingToolCalls = toolCallsFromContent(message.content);
            serializeNormalizedMessage(message);
            continue;
        }
        if (message.role === "toolResult") {
            const callId = responseCallIdFromToolCallId(message.toolCallId);
            if (callId) existingToolResultIds.add(callId);
            serializeNormalizedMessage(message);
            continue;
        }
        if (message.role === "user") {
            insertSyntheticToolResults();
            serializeNormalizedMessage(message);
            continue;
        }
        serializeNormalizedMessage(message);
    }

    insertSyntheticToolResults();
    return input;
}

function transformMessageForResponses(
    model: ExtensionContext["model"] | undefined,
    message: CompactionMessage,
    toolCallIdMap: Map<string, string>,
): CompactionMessage {
    if (message.role === "toolResult") {
        const mapped =
            typeof message.toolCallId === "string"
                ? toolCallIdMap.get(message.toolCallId)
                : undefined;
        return mapped ? { ...message, toolCallId: mapped } : message;
    }
    if (message.role !== "assistant") return message;

    const isSameModel =
        model &&
        message.provider === model.provider &&
        message.api === model.api &&
        message.model === model.id;
    const content = message.content.flatMap((block): CompactionContentBlock[] => {
        if (block.type === "thinking") {
            if (block.redacted) return isSameModel ? [block] : [];
            if (isSameModel && block.thinkingSignature) return [block];
            return block.thinking && block.thinking.trim().length > 0
                ? [{ type: "text", text: block.thinking }]
                : [];
        }
        if (block.type === "toolCall") {
            const normalizedId = normalizeResponsesToolCallId(block.id, Boolean(isSameModel));
            if (normalizedId !== block.id) toolCallIdMap.set(block.id, normalizedId);
            return [{ ...block, id: normalizedId }];
        }
        return [block];
    });
    return { ...message, content };
}

function compactionMessageFromSessionEntry(entry: SessionEntry): CompactionMessage | undefined {
    if (entry.type === "message") return parseCompactionMessage(entry.message);
    if (entry.type === "custom_message") {
        return parseCompactionMessage({ role: "user", content: entry.content });
    }
    if (entry.type === "branch_summary") {
        return {
            role: "user",
            content: [
                {
                    type: "text",
                    text: `${BRANCH_SUMMARY_PREFIX}${entry.summary}${BRANCH_SUMMARY_SUFFIX}`,
                },
            ],
        };
    }
    if (entry.type === "compaction") {
        return compactionSummaryMessage(entry.summary);
    }
    return undefined;
}

function compactionSummaryMessage(summary: string): CompactionMessage {
    return {
        role: "user",
        content: [
            {
                type: "text",
                text: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`,
            },
        ],
    };
}

function parseCompactionMessage(value: unknown): CompactionMessage | undefined {
    if (!isJsonObject(value)) return undefined;
    if (value.role === "user") {
        const content = parseCompactionMessageContent(value.content);
        return content === undefined ? undefined : { role: "user", content };
    }
    if (value.role === "assistant") {
        const content = parseCompactionContentBlocks(value.content);
        if (!content) return undefined;
        return {
            role: "assistant",
            content,
            provider: parseOptionalString(value.provider),
            api: parseOptionalString(value.api),
            model: parseOptionalString(value.model),
            stopReason: parseOptionalString(value.stopReason),
        };
    }
    if (value.role === "toolResult") {
        const content = parseCompactionContentBlocks(value.content);
        if (!content) return undefined;
        return {
            role: "toolResult",
            toolCallId: parseOptionalString(value.toolCallId),
            content,
        };
    }
    return undefined;
}

function parseCompactionMessageContent(value: unknown): CompactionMessageContent | undefined {
    if (typeof value === "string") return value;
    return parseCompactionContentBlocks(value);
}

function parseCompactionContentBlocks(
    value: unknown,
): readonly CompactionContentBlock[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const content: CompactionContentBlock[] = [];
    for (const item of value) {
        const block = parseCompactionContentBlock(item);
        if (block) content.push(block);
    }
    return content;
}

function parseCompactionContentBlock(value: unknown): CompactionContentBlock | undefined {
    if (!isJsonObject(value)) return undefined;
    if (value.type === "text" && typeof value.text === "string") {
        return { type: "text", text: value.text };
    }
    if (
        value.type === "image" &&
        typeof value.data === "string" &&
        typeof value.mimeType === "string"
    ) {
        return {
            type: "image",
            data: value.data,
            mimeType: value.mimeType,
            detail: imageDetailForResponses(value.detail),
        };
    }
    if (value.type === "thinking") {
        return {
            type: "thinking",
            thinking: parseOptionalString(value.thinking),
            thinkingSignature: parseOptionalString(value.thinkingSignature),
            redacted: value.redacted === true ? true : undefined,
        };
    }
    if (
        value.type === "toolCall" &&
        typeof value.id === "string" &&
        typeof value.name === "string"
    ) {
        return {
            type: "toolCall",
            id: value.id,
            name: value.name,
            arguments: parseJsonObject(value.arguments),
        };
    }
    return undefined;
}

function serializeMessage(
    message: CompactionMessage,
    messageIndex: number,
    model: ExtensionContext["model"] | undefined,
): ResponsesInputItem[] {
    if (message.role === "user") {
        const content = inputContentFromContent(message.content, model);
        return content.length > 0 ? [{ role: "user", content }] : [];
    }
    if (message.role === "assistant") {
        const items: ResponsesInputItem[] = [];
        const text = textFromContent(message.content);
        if (text) {
            items.push({
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: sanitizeSurrogates(text), annotations: [] }],
                status: "completed",
                id: `msg_pi_compact_${messageIndex}`,
            });
        }
        for (const toolCall of toolCallsFromContent(message.content)) items.push(toolCall);
        return items;
    }
    if (message.role === "toolResult") {
        const callId = responseCallIdFromToolCallId(message.toolCallId);
        if (!callId) return [];
        return [
            {
                type: "function_call_output",
                call_id: callId,
                output: toolResultOutputFromContent(message.content, model),
            },
        ];
    }
    return [];
}

function inputContentFromContent(
    content: CompactionMessageContent,
    model: ExtensionContext["model"] | undefined,
): ResponsesInputItem[] {
    if (typeof content === "string")
        return [{ type: "input_text", text: sanitizeSurrogates(content) }];
    return content.flatMap((item): ResponsesInputItem[] => {
        if (item.type === "text") {
            return [{ type: "input_text", text: sanitizeSurrogates(item.text) }];
        }
        if (item.type === "image" && modelSupportsImages(model)) {
            return [
                {
                    type: "input_image",
                    image_url: `data:${item.mimeType};base64,${item.data}`,
                    detail: imageDetailForResponses(item.detail),
                },
            ];
        }
        if (item.type === "image") {
            return [{ type: "input_text", text: "(image omitted: model does not support images)" }];
        }
        return [];
    });
}

function toolResultOutputFromContent(
    content: readonly CompactionContentBlock[],
    model: ExtensionContext["model"] | undefined,
): string | ResponsesInputItem[] {
    const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
    const images = content.flatMap((item): ResponsesInputItem[] => {
        if (item.type !== "image") return [];
        return [
            {
                type: "input_image",
                image_url: `data:${item.mimeType};base64,${item.data}`,
                detail: imageDetailForResponses(item.detail),
            },
        ];
    });
    if (images.length > 0 && modelSupportsImages(model)) {
        return [
            ...(text.trim().length > 0
                ? [{ type: "input_text", text: sanitizeSurrogates(text) }]
                : []),
            ...images,
        ];
    }
    if (text.trim().length > 0) return sanitizeSurrogates(text);
    return images.length > 0 ? "(see attached image)" : "(no output)";
}

function textFromContent(content: CompactionMessageContent): string | undefined {
    if (typeof content === "string") return sanitizeSurrogates(content).trim() || undefined;
    const parts = content.flatMap((item) =>
        item.type === "text" ? [sanitizeSurrogates(item.text)] : [],
    );
    const text = parts.join("\n").trim();
    return text.length > 0 ? text : undefined;
}

function toolCallsFromContent(content: readonly CompactionContentBlock[]): ResponsesInputItem[] {
    return content.flatMap((item) => {
        if (item.type !== "toolCall") return [];
        const [callId, itemId] = splitResponseToolCallId(item.id);
        if (!callId) return [];
        return [
            {
                type: "function_call",
                ...(itemId ? { id: itemId } : {}),
                call_id: callId,
                name: item.name,
                arguments: JSON.stringify(item.arguments ?? {}),
            },
        ];
    });
}

export function asResponsesPayload(value: unknown): ResponsesPayload | undefined {
    if (!isJsonObject(value) || typeof value.model !== "string" || !Array.isArray(value.input)) {
        return undefined;
    }
    if (!value.input.every(isJsonObject)) return undefined;
    return {
        ...value,
        model: value.model,
        // SAFETY: The provider request rewrite path only needs object-shaped response input items;
        // recursively rebuilding long provider payloads here duplicates session-sized data.
        input: value.input as readonly ResponsesInputItem[],
    };
}

export function parseResponsesInputItems(value: unknown): ResponsesInputItem[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items: ResponsesInputItem[] = [];
    for (const item of value) {
        const inputItem = parseJsonObject(item);
        if (!inputItem) return undefined;
        items.push(inputItem);
    }
    return items;
}

export function isInstructionItem(item: ResponsesInputItem | undefined): boolean {
    return isJsonObject(item) && (item.role === "system" || item.role === "developer");
}

export function isRemoteCompactionOutputItem(
    item: ResponsesInputItem | undefined,
): item is ResponsesInputItem & { readonly encrypted_content: string } {
    return (
        isJsonObject(item) &&
        (item.type === "compaction" || item.type === "compaction_summary") &&
        typeof item.encrypted_content === "string"
    );
}

export function itemContainsShimSummary(item: ResponsesInputItem): boolean {
    if (!isJsonObject(item)) return false;
    return textFromResponsesContent(item.content).includes(NATIVE_COMPACTION_SHIM_SUMMARY);
}

export function textFromResponsesContent(content: JsonValue | undefined): string {
    if (typeof content === "string") return content;
    if (!isJsonArray(content)) return "";
    return content
        .flatMap((item) => (isJsonObject(item) && typeof item.text === "string" ? [item.text] : []))
        .join("\n");
}

export function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
    return Array.isArray(value);
}

export function sanitizeSurrogates(text: string): string {
    return text.replace(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
        "",
    );
}

export function parseJsonValue(value: unknown): JsonValue | undefined {
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (Array.isArray(value)) {
        const items: JsonValue[] = [];
        for (const item of value) {
            const parsed = parseJsonValue(item);
            if (parsed === undefined) return undefined;
            items.push(parsed);
        }
        return items;
    }
    return parseJsonObject(value);
}

export function parseJsonObject(value: unknown): JsonObject | undefined {
    const record = parseWithSchema(JsonObjectValidator, value);
    if (!record) return undefined;
    const object: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(record)) {
        const parsed = parseJsonValue(nested);
        if (parsed !== undefined) object[key] = parsed;
    }
    return object;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
    return parseWithSchema(JsonObjectValidator, value) !== undefined;
}

function modelSupportsImages(model: ExtensionContext["model"] | undefined): boolean {
    return Array.isArray(model?.input) && model.input.includes("image");
}

function imageDetailForResponses(value: unknown): "auto" | "high" | "original" {
    return value === "high" || value === "original" ? value : "auto";
}

function normalizeResponsesToolCallId(id: string, isSameModel: boolean): string {
    const [callId, itemId] = splitResponseToolCallId(id);
    const normalizedCallId = normalizeResponseIdPart(callId ?? id);
    if (!itemId) return normalizedCallId;
    const normalizedItemId = normalizeResponseIdPart(
        isSameModel ? itemId : `fc_${shortHash(itemId)}`,
    );
    return `${normalizedCallId}|${normalizedItemId.startsWith("fc_") ? normalizedItemId : `fc_${normalizedItemId}`}`;
}

function responseCallIdFromToolCallId(value: string | undefined): string | undefined {
    if (typeof value !== "string") return undefined;
    return splitResponseToolCallId(value)[0];
}

function splitResponseToolCallId(id: string): readonly [string | undefined, string | undefined] {
    const [callId, itemId] = id.split("|");
    return [callId && callId.length > 0 ? normalizeResponseIdPart(callId) : undefined, itemId];
}

function normalizeResponseIdPart(value: string): string {
    const sanitized = value
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 64)
        .replace(/_+$/, "");
    return sanitized.length > 0 ? sanitized : "id";
}

function shortHash(value: string): string {
    let hash = 2_166_136_261;
    for (const char of value) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16_777_619);
    }
    const unsignedHash = hash < 0 ? hash + 4_294_967_296 : hash;
    return Math.trunc(unsignedHash).toString(16);
}

function parseOptionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}
