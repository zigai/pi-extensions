import {
    CodexHttpRequestFailed,
    CodexInvalidJson,
    CodexNetworkUnavailable,
    CodexRequestCancelled,
    CodexUnexpectedResponse,
    fail,
    isAbortCause as isCodexAbortCause,
    ok,
    type CodexResult,
} from "../codex/failures.ts";
import type { CodexRuntime } from "../runtime.ts";
import { isJsonObject, parseJsonObject } from "./responses-input.ts";
import type {
    JsonObject,
    RemoteCompactionV2Request,
    RemoteCompactionV2Response,
    ResponsesInputItem,
} from "./types.ts";

const MAX_SSE_TAIL_CHARS = 1_000_000;
const MAX_SSE_EVENT_CHARS = 2_000_000;
const MAX_HTTP_ERROR_BODY_BYTES = 8 * 1024;

type ServerSentEvent = {
    readonly event: string;
    readonly data: readonly string[];
};

export async function executeRemoteCompactionV2(
    runtime: { readonly responsesUrl: string; readonly headers: Headers },
    request: RemoteCompactionV2Request,
    signal: AbortSignal,
    services: CodexRuntime,
): Promise<CodexResult<RemoteCompactionV2Response>> {
    let response: Response;
    try {
        response = await services.fetch(runtime.responsesUrl, {
            method: "POST",
            headers: runtime.headers,
            signal,
            body: JSON.stringify(request),
        });
    } catch (cause: unknown) {
        if (isCodexAbortCause(cause)) {
            return fail(
                new CodexRequestCancelled({
                    operation: "nativeCompaction",
                    message: "Codex remote compaction request was cancelled.",
                    cause,
                }),
            );
        }
        return fail(
            new CodexNetworkUnavailable({
                operation: "nativeCompaction",
                provider: "openai-codex",
                message: "Codex remote compaction network request failed.",
                cause,
            }),
        );
    }
    if (!response.ok) {
        const detail = await readSafeHttpErrorDetail(response);
        return fail(
            new CodexHttpRequestFailed({
                operation: "nativeCompaction",
                provider: "openai-codex",
                status: response.status,
                message: `Codex remote compaction failed with HTTP ${response.status}.${detail ? ` ${detail}` : ""}`,
            }),
        );
    }
    if (!response.body) return collectRemoteCompactionV2Output(await response.text());
    return collectRemoteCompactionV2OutputFromStream(response.body);
}

async function readSafeHttpErrorDetail(response: Response): Promise<string | undefined> {
    const requestId = safeDiagnosticValue(response.headers.get("x-request-id"));
    let payload: unknown;
    try {
        const body = await readResponseTextPrefix(response, MAX_HTTP_ERROR_BODY_BYTES);
        payload = JSON.parse(body);
    } catch {
        return requestId ? `request_id=${requestId}` : undefined;
    }
    const root = parseJsonObject(payload);
    if (!root) return requestId ? `request_id=${requestId}` : undefined;
    const nestedError = parseJsonObject(root.error);
    const error = nestedError ?? root;
    const type = safeDiagnosticValue(error.type);
    const code = safeDiagnosticValue(error.code);
    const message = safeDiagnosticValue(error.message, 500);
    const fields = [
        type ? `type=${type}` : undefined,
        code ? `code=${code}` : undefined,
        message ? `message=${message}` : undefined,
        requestId ? `request_id=${requestId}` : undefined,
    ].filter((field): field is string => field !== undefined);
    return fields.length > 0 ? fields.join(" ") : undefined;
}

async function readResponseTextPrefix(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let remaining = maxBytes;
    let text = "";
    for (;;) {
        const { value, done } = await reader.read();
        if (done) return text + decoder.decode();
        if (!value || value.length === 0) continue;
        const retained = value.subarray(0, remaining);
        text += decoder.decode(retained, { stream: retained.length === value.length });
        remaining -= retained.length;
        if (remaining === 0) {
            await reader.cancel();
            return text + decoder.decode();
        }
    }
}

function safeDiagnosticValue(value: unknown, maxCharacters = 128): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const normalized = String(value)
        .replaceAll(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
        .replaceAll(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
        .replaceAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
        .replaceAll(/\s+/g, " ")
        .trim();
    if (normalized.length === 0) return undefined;
    return Array.from(normalized).slice(0, maxCharacters).join("");
}

async function collectRemoteCompactionV2OutputFromStream(
    body: ReadableStream<Uint8Array>,
): Promise<CodexResult<RemoteCompactionV2Response>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const collector = createRemoteCompactionV2Collector();
    let buffer = "";
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_TAIL_CHARS && !hasCompleteServerSentEventDelimiter(buffer)) {
            await reader.cancel();
            return fail(createOversizedRemoteCompactionStreamError());
        }
        const drained = drainCompleteServerSentEventBlocks(buffer);
        buffer = drained.tail;
        for (const block of drained.blocks) {
            if (block.length > MAX_SSE_EVENT_CHARS) {
                await reader.cancel();
                return fail(createOversizedRemoteCompactionStreamError());
            }
            const event = parseServerSentEventBlock(block);
            if (!event) continue;
            const consumed = collector.consume(event);
            if (consumed.isErr()) return fail(consumed.error);
        }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
        if (buffer.length > MAX_SSE_EVENT_CHARS)
            return fail(createOversizedRemoteCompactionStreamError());
        const event = parseServerSentEventBlock(buffer);
        if (event) {
            const consumed = collector.consume(event);
            if (consumed.isErr()) return fail(consumed.error);
        }
    }
    return collector.finish();
}

function collectRemoteCompactionV2Output(sseText: string): CodexResult<RemoteCompactionV2Response> {
    const collector = createRemoteCompactionV2Collector();
    for (const event of parseServerSentEvents(sseText)) {
        const consumed = collector.consume(event);
        if (consumed.isErr()) return fail(consumed.error);
    }
    return collector.finish();
}

function createRemoteCompactionV2Collector(): {
    readonly consume: (event: ServerSentEvent) => CodexResult<void>;
    readonly finish: () => CodexResult<RemoteCompactionV2Response>;
} {
    let outputItemCount = 0;
    const compactionItems: ResponsesInputItem[] = [];
    let completed = false;
    let responseId: string | undefined;
    let createdAt: number | string | undefined;

    return {
        consume(event: ServerSentEvent): CodexResult<void> {
            if (event.event === "response.output_item.done") {
                const item = parseEventItem(event.data);
                if (item.isErr()) return fail(item.error);
                if (!item.value) return ok(undefined);
                outputItemCount += 1;
                if (item.value.type === "compaction" || item.value.type === "compaction_summary") {
                    compactionItems.push(item.value);
                }
                return ok(undefined);
            }
            if (event.event === "response.completed") {
                const response = parseEventResponse(event.data);
                if (response.isErr()) return fail(response.error);
                completed = true;
                responseId = typeof response.value?.id === "string" ? response.value.id : undefined;
                createdAt = parseCreatedAt(response.value);
                return ok(undefined);
            }
            if (event.event === "response.failed" || event.event === "response.incomplete") {
                return fail(
                    new CodexUnexpectedResponse({
                        operation: "nativeCompaction",
                        provider: "openai-codex",
                        message: formatResponsesStreamFailure(event.data, event.event),
                    }),
                );
            }
            return ok(undefined);
        },
        finish(): CodexResult<RemoteCompactionV2Response> {
            if (!completed) {
                return fail(
                    new CodexUnexpectedResponse({
                        operation: "nativeCompaction",
                        provider: "openai-codex",
                        message: "Remote compaction stream closed before response.completed.",
                    }),
                );
            }
            if (compactionItems.length !== 1) {
                return fail(
                    new CodexUnexpectedResponse({
                        operation: "nativeCompaction",
                        provider: "openai-codex",
                        message: `Remote compaction expected exactly one compaction output item, got ${compactionItems.length} from ${outputItemCount} output items.`,
                    }),
                );
            }
            const [compactionOutput] = compactionItems;
            if (!compactionOutput) {
                return fail(
                    new CodexUnexpectedResponse({
                        operation: "nativeCompaction",
                        provider: "openai-codex",
                        message: "Remote compaction output disappeared.",
                    }),
                );
            }
            return ok({ compactionOutput, id: responseId, createdAt });
        },
    };
}

function hasCompleteServerSentEventDelimiter(buffer: string): boolean {
    return /\r?\n\r?\n/.test(buffer);
}

function createOversizedRemoteCompactionStreamError(): CodexUnexpectedResponse {
    return new CodexUnexpectedResponse({
        operation: "nativeCompaction",
        provider: "openai-codex",
        message: "Remote compaction stream event exceeded maximum size.",
    });
}

function drainCompleteServerSentEventBlocks(buffer: string): {
    readonly blocks: readonly string[];
    readonly tail: string;
} {
    const blocks: string[] = [];
    let tail = buffer;
    for (;;) {
        const separator = /\r?\n\r?\n/.exec(tail);
        if (!separator) return { blocks, tail };
        blocks.push(tail.slice(0, separator.index));
        tail = tail.slice(separator.index + separator[0].length);
    }
}

function parseServerSentEvents(text: string): ServerSentEvent[] {
    return text.split(/\r?\n\r?\n/).flatMap((block) => {
        const event = parseServerSentEventBlock(block);
        return event ? [event] : [];
    });
}

function parseServerSentEventBlock(block: string): ServerSentEvent | undefined {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice("event:".length).trim();
        else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
    }
    return data.length > 0 ? { event, data } : undefined;
}

function parseEventItem(data: readonly string[]): CodexResult<ResponsesInputItem | undefined> {
    const payload = parseEventPayload(data);
    if (payload.isErr()) return payload;
    return ok(parseJsonObject(payload.value?.item));
}

function parseEventResponse(data: readonly string[]): CodexResult<ResponsesInputItem | undefined> {
    const payload = parseEventPayload(data);
    if (payload.isErr()) return payload;
    return ok(parseJsonObject(payload.value?.response));
}

function parseEventPayload(data: readonly string[]): CodexResult<JsonObject | undefined> {
    const text = data.join("\n").trim();
    if (text.length === 0 || text === "[DONE]") return ok(undefined);
    try {
        const rawPayload: unknown = JSON.parse(text);
        return ok(parseJsonObject(rawPayload));
    } catch (cause: unknown) {
        return fail(
            new CodexInvalidJson({
                operation: "nativeCompaction",
                provider: "openai-codex",
                message: "Remote compaction stream event was not valid JSON.",
                cause,
            }),
        );
    }
}

function parseCreatedAt(response: ResponsesInputItem | undefined): number | string | undefined {
    const createdAt = response?.created_at;
    return typeof createdAt === "string" || typeof createdAt === "number" ? createdAt : undefined;
}

function formatResponsesStreamFailure(data: readonly string[], event: string): string {
    const response = parseEventResponse(data);
    if (response.isErr()) return response.error.message;
    const error = response.value?.error;
    if (isJsonObject(error) && typeof error.message === "string" && error.message.trim().length > 0)
        return `${event}: ${error.message.trim()}`;
    return `${event} event received during remote compaction v2`;
}
