import {
    CodexHttpRequestFailed,
    CodexInvalidJson,
    CodexNetworkUnavailable,
    CodexRequestCancelled,
    CodexUnexpectedResponse,
    fail,
    isAbortCause as isCodexAbortCause,
    ok,
    type CodexFailure,
    type CodexResult,
} from "../codex/failures.ts";
import type { CodexRuntime, ScheduledTask } from "../runtime.ts";
import { isJsonObject, isRemoteCompactionOutputItem, parseJsonObject } from "./responses-input.ts";
import type {
    JsonObject,
    RemoteCompactionV2Request,
    RemoteCompactionV2Response,
    ResponsesInputItem,
} from "./types.ts";

const MAX_SSE_TAIL_CHARS = 1_000_000;
const MAX_SSE_EVENT_CHARS = 2_000_000;
const MAX_HTTP_ERROR_BODY_BYTES = 8 * 1024;
const REMOTE_COMPACTION_STREAM_IDLE_TIMEOUT_MS = 300_000;
const MAX_REMOTE_COMPACTION_STREAM_RETRIES = 2;
const REMOTE_COMPACTION_RETRY_INITIAL_DELAY_MS = 200;

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
    let lastResult: CodexResult<RemoteCompactionV2Response> | undefined;
    for (let attempt = 0; attempt <= MAX_REMOTE_COMPACTION_STREAM_RETRIES; attempt += 1) {
        const linkedAttempt = createLinkedAttemptController(signal);
        let result: CodexResult<RemoteCompactionV2Response>;
        try {
            result = await executeRemoteCompactionV2Attempt(
                runtime,
                request,
                linkedAttempt.controller,
                signal,
                services,
            );
            if (result.isErr() && !linkedAttempt.controller.signal.aborted) {
                linkedAttempt.controller.abort(result.error);
            }
        } catch (cause: unknown) {
            if (!linkedAttempt.controller.signal.aborted) linkedAttempt.controller.abort(cause);
            throw cause;
        } finally {
            linkedAttempt.dispose();
        }
        if (
            result.isOk() ||
            !isRetryableRemoteCompactionFailure(result.error) ||
            attempt === MAX_REMOTE_COMPACTION_STREAM_RETRIES
        ) {
            return result;
        }
        lastResult = result;
        try {
            await waitForRetry(
                REMOTE_COMPACTION_RETRY_INITIAL_DELAY_MS * 2 ** attempt,
                signal,
                services,
            );
        } catch (cause: unknown) {
            return cancelledRemoteCompaction(cause);
        }
    }
    return (
        lastResult ??
        fail(
            new CodexNetworkUnavailable({
                operation: "nativeCompaction",
                provider: "openai-codex",
                message: "Codex remote compaction retry limit was exhausted.",
                cause: new Error("Remote compaction retry limit exhausted."),
            }),
        )
    );
}

async function executeRemoteCompactionV2Attempt(
    runtime: { readonly responsesUrl: string; readonly headers: Headers },
    request: RemoteCompactionV2Request,
    attemptController: AbortController,
    parentSignal: AbortSignal,
    services: CodexRuntime,
): Promise<CodexResult<RemoteCompactionV2Response>> {
    const signal = attemptController.signal;
    let response: Response;
    try {
        response = await services.fetch(runtime.responsesUrl, {
            method: "POST",
            headers: runtime.headers,
            signal,
            body: JSON.stringify(request),
        });
    } catch (cause: unknown) {
        if (isCodexAbortCause(cause) || parentSignal.aborted) {
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
        let detail: string | undefined;
        try {
            detail = await readSafeHttpErrorDetail(response, signal, services, attemptController);
        } catch (cause: unknown) {
            return cancelledRemoteCompaction(cause);
        }
        return fail(
            new CodexHttpRequestFailed({
                operation: "nativeCompaction",
                provider: "openai-codex",
                status: response.status,
                message: `Codex remote compaction failed with HTTP ${response.status}.${detail ? ` ${detail}` : ""}`,
            }),
        );
    }
    try {
        if (!response.body) {
            const text = await readRemoteCompactionResponseText(
                response,
                signal,
                services,
                attemptController,
            );
            return collectRemoteCompactionV2Output(text);
        }
        return await collectRemoteCompactionV2OutputFromStream(
            response.body,
            signal,
            services,
            attemptController,
        );
    } catch (cause: unknown) {
        if (cause instanceof RemoteCompactionIdleTimeout) {
            return fail(
                new CodexNetworkUnavailable({
                    operation: "nativeCompaction",
                    provider: "openai-codex",
                    message: "Codex remote compaction stream timed out while idle.",
                    cause,
                }),
            );
        }
        if (cause instanceof RemoteCompactionTransportFailure) {
            return fail(
                new CodexNetworkUnavailable({
                    operation: "nativeCompaction",
                    provider: "openai-codex",
                    message: "Codex remote compaction stream failed.",
                    cause: cause.cause,
                }),
            );
        }
        if (isCodexAbortCause(cause) || parentSignal.aborted) {
            return cancelledRemoteCompaction(cause);
        }
        throw cause;
    }
}

class RemoteCompactionIdleTimeout extends Error {
    constructor() {
        super(
            `Remote compaction stream was idle for ${REMOTE_COMPACTION_STREAM_IDLE_TIMEOUT_MS}ms.`,
        );
        this.name = "RemoteCompactionIdleTimeout";
    }
}

class RemoteCompactionTransportFailure extends Error {
    override readonly cause: unknown;

    constructor(message: string, cause: unknown) {
        super(message);
        this.name = "RemoteCompactionTransportFailure";
        this.cause = cause;
    }
}

function createLinkedAttemptController(parentSignal: AbortSignal): {
    readonly controller: AbortController;
    readonly dispose: () => void;
} {
    const controller = new AbortController();
    const onParentAbort = () =>
        controller.abort(parentSignal.reason ?? new DOMException("Aborted", "AbortError"));
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    return {
        controller,
        dispose: () => parentSignal.removeEventListener("abort", onParentAbort),
    };
}

function isRetryableRemoteCompactionFailure(error: CodexFailure): boolean {
    if (error._tag === "CodexNetworkUnavailable") return true;
    if (error._tag !== "CodexHttpRequestFailed") return false;
    return error.status === 408 || error.status === 409 || error.status >= 500;
}

function cancelledRemoteCompaction<T>(cause: unknown): CodexResult<T> {
    return fail(
        new CodexRequestCancelled({
            operation: "nativeCompaction",
            message: "Codex remote compaction request was cancelled.",
            cause,
        }),
    );
}

function withRemoteCompactionIdleTimeout<T>(
    operation: Promise<T>,
    signal: AbortSignal,
    services: CodexRuntime,
    onTimeout: (cause: RemoteCompactionIdleTimeout) => void,
): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timeoutTask: ScheduledTask | undefined;
        const settle = (complete: () => void) => {
            if (settled) return;
            settled = true;
            timeoutTask?.cancel();
            signal.removeEventListener("abort", onAbort);
            complete();
        };
        const onAbort = () =>
            settle(() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")));
        signal.addEventListener("abort", onAbort, { once: true });
        operation.then(
            (value) => settle(() => resolve(value)),
            (cause: unknown) => settle(() => reject(cause)),
        );
        timeoutTask = services.scheduler.set(REMOTE_COMPACTION_STREAM_IDLE_TIMEOUT_MS, () => {
            const cause = new RemoteCompactionIdleTimeout();
            settle(() => reject(cause));
            onTimeout(cause);
        });
        if (settled) timeoutTask.cancel();
    });
}

function readRemoteCompactionResponseText(
    response: Response,
    signal: AbortSignal,
    services: CodexRuntime,
    attemptController: AbortController,
): Promise<string> {
    const text = response.text().catch((cause: unknown) => {
        if (isCodexAbortCause(cause) || signal.aborted) throw cause;
        throw new RemoteCompactionTransportFailure(
            "Remote compaction response body read failed.",
            cause,
        );
    });
    return withRemoteCompactionIdleTimeout(text, signal, services, (cause) =>
        attemptController.abort(cause),
    );
}

function waitForRetry(delayMs: number, signal: AbortSignal, services: CodexRuntime): Promise<void> {
    if (signal.aborted) {
        return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        let task: ScheduledTask | undefined;
        const settle = (complete: () => void) => {
            if (settled) return;
            settled = true;
            task?.cancel();
            signal.removeEventListener("abort", onAbort);
            complete();
        };
        const onAbort = () =>
            settle(() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")));
        signal.addEventListener("abort", onAbort, { once: true });
        task = services.scheduler.set(delayMs, () => settle(resolve));
        if (settled) task.cancel();
    });
}

async function readSafeHttpErrorDetail(
    response: Response,
    signal: AbortSignal,
    services: CodexRuntime,
    attemptController: AbortController,
): Promise<string | undefined> {
    const requestId = safeDiagnosticValue(response.headers.get("x-request-id"));
    let payload: unknown;
    try {
        const body = await readResponseTextPrefix(
            response,
            MAX_HTTP_ERROR_BODY_BYTES,
            signal,
            services,
            attemptController,
        );
        payload = JSON.parse(body);
    } catch (cause: unknown) {
        if (signal.reason instanceof RemoteCompactionIdleTimeout) {
            return requestId ? `request_id=${requestId}` : undefined;
        }
        if (isCodexAbortCause(cause) || signal.aborted) throw cause;
        return requestId ? `request_id=${requestId}` : undefined;
    }
    const root = parseJsonObject(payload);
    if (!root) return requestId ? `request_id=${requestId}` : undefined;
    const nestedError = parseJsonObject(root.error);
    const error = nestedError ?? root;
    const type = safeDiagnosticValue(error.type);
    const code = safeDiagnosticValue(error.code);
    const message = safeDiagnosticValue(error.message ?? error.detail, 500);
    const fields = [
        type ? `type=${type}` : undefined,
        code ? `code=${code}` : undefined,
        message ? `message=${message}` : undefined,
        requestId ? `request_id=${requestId}` : undefined,
    ].filter((field): field is string => field !== undefined);
    return fields.length > 0 ? fields.join(" ") : undefined;
}

async function readResponseTextPrefix(
    response: Response,
    maxBytes: number,
    signal: AbortSignal,
    services: CodexRuntime,
    attemptController: AbortController,
): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let remaining = maxBytes;
    let text = "";
    try {
        for (;;) {
            const { value, done } = await readRemoteCompactionStreamChunk(
                reader,
                signal,
                services,
                attemptController,
            );
            if (done) return text + decoder.decode();
            if (!value || value.length === 0) continue;
            const retained = value.subarray(0, remaining);
            text += decoder.decode(retained, { stream: retained.length === value.length });
            remaining -= retained.length;
            if (remaining === 0) {
                await cancelStreamReader(reader);
                return text + decoder.decode();
            }
        }
    } catch (cause: unknown) {
        await cancelStreamReader(reader);
        throw cause;
    }
}

function readRemoteCompactionStreamChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
    services: CodexRuntime,
    attemptController: AbortController,
): Promise<ReadableStreamReadResult<Uint8Array>> {
    const read = reader.read().catch((cause: unknown) => {
        if (isCodexAbortCause(cause) || signal.aborted) throw cause;
        throw new RemoteCompactionTransportFailure("Remote compaction stream read failed.", cause);
    });
    return withRemoteCompactionIdleTimeout(read, signal, services, (cause) =>
        attemptController.abort(cause),
    );
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
    signal: AbortSignal,
    services: CodexRuntime,
    attemptController: AbortController,
): Promise<CodexResult<RemoteCompactionV2Response>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const collector = createRemoteCompactionV2Collector();
    let buffer = "";
    try {
        for (;;) {
            const { value, done } = await readRemoteCompactionStreamChunk(
                reader,
                signal,
                services,
                attemptController,
            );
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (
                buffer.length > MAX_SSE_TAIL_CHARS &&
                !hasCompleteServerSentEventDelimiter(buffer)
            ) {
                await cancelStreamReader(reader);
                return fail(createOversizedRemoteCompactionStreamError());
            }
            const drained = drainCompleteServerSentEventBlocks(buffer);
            buffer = drained.tail;
            for (const block of drained.blocks) {
                if (block.length > MAX_SSE_EVENT_CHARS) {
                    await cancelStreamReader(reader);
                    return fail(createOversizedRemoteCompactionStreamError());
                }
                const event = parseServerSentEventBlock(block);
                if (!event) continue;
                const consumed = collector.consume(event);
                if (consumed.isErr()) {
                    await cancelStreamReader(reader);
                    return fail(consumed.error);
                }
                if (collector.isComplete()) {
                    await cancelStreamReader(reader);
                    return collector.finish();
                }
            }
        }
    } catch (cause: unknown) {
        await cancelStreamReader(reader);
        throw cause;
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

async function cancelStreamReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
        await reader.cancel();
    } catch {
        // The original stream result or failure is more useful than cancellation cleanup errors.
    }
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
    readonly isComplete: () => boolean;
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
                if (isRemoteCompactionOutputItem(item.value)) {
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
        isComplete: () => completed,
        finish(): CodexResult<RemoteCompactionV2Response> {
            if (!completed) {
                return fail(
                    new CodexNetworkUnavailable({
                        operation: "nativeCompaction",
                        provider: "openai-codex",
                        message: "Remote compaction stream closed before response.completed.",
                        cause: new Error(
                            "Remote compaction stream closed before response.completed.",
                        ),
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
