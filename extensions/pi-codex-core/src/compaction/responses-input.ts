import type {
    ExtensionContext,
    SessionBeforeCompactEvent,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { compileSchema } from "../schema-parsing.ts";
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

const JsonValueSchema = Type.Cyclic(
    {
        JsonValue: Type.Union([
            Type.Null(),
            Type.Boolean(),
            Type.Number(),
            Type.String(),
            Type.Array(Type.Ref("JsonValue")),
            Type.Record(Type.String(), Type.Union([Type.Ref("JsonValue"), Type.Undefined()])),
        ]),
    },
    "JsonValue",
);
const JsonObjectSchema = Type.Record(
    Type.String(),
    Type.Union([JsonValueSchema, Type.Undefined()]),
);
export const JsonValueDecoder = compileSchema(JsonValueSchema);
export const JsonArrayDecoder = compileSchema(Type.Array(JsonValueSchema));
export const JsonObjectDecoder = compileSchema(JsonObjectSchema);
export const ResponsesPayloadDecoder = compileSchema(
    Type.Intersect([
        JsonObjectSchema,
        Type.Object({ model: Type.String(), input: Type.Array(JsonObjectSchema) }),
    ]),
);
const StringValidator = compileSchema(Type.String());
export const JsonStringDecoder = StringValidator;
export const JsonNumberDecoder = compileSchema(Type.Number());
const ImageDetailValidator = compileSchema(
    Type.Union([Type.Literal("high"), Type.Literal("original")]),
);
const UnknownArrayValidator = compileSchema(Type.Array(Type.Unknown()));
const CompactionMessageContentValidator = compileSchema(
    Type.Union([Type.String(), Type.Array(Type.Unknown())]),
);

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
            const id = StringValidator.decode(toolCall.call_id);
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
            message.toolCallId === undefined ? undefined : toolCallIdMap.get(message.toolCallId);
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
    const message = parseJsonObject(value);
    if (message === undefined) return undefined;
    if (message.role === "user") {
        const content = parseCompactionMessageContent(message.content);
        return content === undefined ? undefined : { role: "user", content };
    }
    if (message.role === "assistant") {
        const content = parseCompactionContentBlocks(message.content);
        if (!content) return undefined;
        return {
            role: "assistant",
            content,
            provider: parseOptionalString(message.provider),
            api: parseOptionalString(message.api),
            model: parseOptionalString(message.model),
            stopReason: parseOptionalString(message.stopReason),
        };
    }
    if (message.role === "toolResult") {
        const content = parseCompactionContentBlocks(message.content);
        if (!content) return undefined;
        return {
            role: "toolResult",
            toolCallId: parseOptionalString(message.toolCallId),
            content,
        };
    }
    return undefined;
}

function parseCompactionMessageContent(value: unknown): CompactionMessageContent | undefined {
    const content = CompactionMessageContentValidator.decode(value);
    if (content === undefined) return undefined;
    return Array.isArray(content)
        ? parseCompactionContentBlocks(content)
        : [{ type: "text", text: content }];
}

function parseCompactionContentBlocks(
    value: unknown,
): readonly CompactionContentBlock[] | undefined {
    const values = UnknownArrayValidator.decode(value);
    if (values === undefined) return undefined;
    const content: CompactionContentBlock[] = [];
    for (const item of values) {
        const block = parseCompactionContentBlock(item);
        if (block) content.push(block);
    }
    return content;
}

function parseCompactionContentBlock(value: unknown): CompactionContentBlock | undefined {
    const block = parseJsonObject(value);
    if (block === undefined) return undefined;
    const text = StringValidator.decode(block.text);
    if (block.type === "text" && text !== undefined) return { type: "text", text };
    const data = StringValidator.decode(block.data);
    const mimeType = StringValidator.decode(block.mimeType);
    if (block.type === "image" && data !== undefined && mimeType !== undefined) {
        return { type: "image", data, mimeType, detail: imageDetailForResponses(block.detail) };
    }
    if (block.type === "thinking") {
        return {
            type: "thinking",
            thinking: parseOptionalString(block.thinking),
            thinkingSignature: parseOptionalString(block.thinkingSignature),
            redacted: block.redacted === true ? true : undefined,
        };
    }
    const id = StringValidator.decode(block.id);
    const name = StringValidator.decode(block.name);
    if (block.type === "toolCall" && id !== undefined && name !== undefined) {
        return { type: "toolCall", id, name, arguments: parseJsonObject(block.arguments) };
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
        const argumentsText = JSON.stringify(item.arguments ?? {});
        return itemId
            ? [
                  {
                      type: "function_call",
                      id: itemId,
                      call_id: callId,
                      name: item.name,
                      arguments: argumentsText,
                  },
              ]
            : [
                  {
                      type: "function_call",
                      call_id: callId,
                      name: item.name,
                      arguments: argumentsText,
                  },
              ];
    });
}

export function parseResponsesPayload(value: unknown): ResponsesPayload | undefined {
    return ResponsesPayloadDecoder.decode(value);
}

export function parseResponsesInputItems(value: unknown): ResponsesInputItem[] | undefined {
    const rawItems = UnknownArrayValidator.decode(value);
    if (rawItems === undefined) return undefined;
    const items: ResponsesInputItem[] = [];
    for (const item of rawItems) {
        const inputItem = parseJsonObject(item);
        if (!inputItem) return undefined;
        items.push(inputItem);
    }
    return items;
}

export function isInstructionItem(item: ResponsesInputItem | undefined): boolean {
    return item !== undefined && (item.role === "system" || item.role === "developer");
}

export function isRemoteCompactionOutputItem(
    item: ResponsesInputItem | undefined,
): item is ResponsesInputItem & { readonly encrypted_content: string } {
    return (
        item !== undefined &&
        (item.type === "compaction" || item.type === "compaction_summary") &&
        StringValidator.decode(item.encrypted_content) !== undefined
    );
}

export function itemContainsShimSummary(item: ResponsesInputItem): boolean {
    return textFromResponsesContent(item.content).includes(NATIVE_COMPACTION_SHIM_SUMMARY);
}

export function textFromResponsesContent(content: JsonValue | undefined): string {
    const textContent = StringValidator.decode(content);
    if (textContent !== undefined) return textContent;
    if (!isJsonArray(content)) return "";
    return content
        .flatMap((item) => {
            const text = parseJsonObject(item)?.text;
            const parsed = StringValidator.decode(text);
            return parsed === undefined ? [] : [parsed];
        })
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

function parseJsonObject(value: unknown): JsonObject | undefined {
    return JsonObjectDecoder.decode(value);
}

function modelSupportsImages(model: ExtensionContext["model"] | undefined): boolean {
    return Array.isArray(model?.input) && model.input.includes("image");
}

function imageDetailForResponses(value: unknown): "auto" | "high" | "original" {
    return ImageDetailValidator.decode(value) ?? "auto";
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
    if (value === undefined) return undefined;
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
    return StringValidator.decode(value);
}
