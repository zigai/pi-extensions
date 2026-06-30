import type {
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import { resolveCodexRequestModel, type CodexCoreConfig } from "./config.ts";
import {
    resolveActiveCodexResponsesProvider,
    resolveCodexApiProviderBaseUrl,
} from "./codex-auth.ts";

export const NATIVE_COMPACTION_STRATEGY = "pi-codex-core-remote-compaction-v2";
export const NATIVE_COMPACTION_SHIM_SUMMARY = "[Codex native compaction checkpoint]";
export const NATIVE_COMPACTION_MESSAGE_TYPE = "pi-codex-core-native-compaction";
export const NATIVE_COMPACTION_MESSAGE_TEXT = [
    "Codex remote compaction v2 was used for this checkpoint.",
    "The compacted context is provider-specific and not human-readable in Pi.",
    "Avoid disabling native compaction or switching providers mid-session if this checkpoint matters.",
].join("\n");

type NativeCompactionDetails = {
    readonly strategy: typeof NATIVE_COMPACTION_STRATEGY;
    readonly provider: string;
    readonly api: string;
    readonly model: string;
    readonly baseUrl: string;
    readonly compactedWindow: readonly Record<string, unknown>[];
    readonly compactResponseId?: string | undefined;
    readonly createdAt: string;
};

type RemoteCompactionV2Response = {
    readonly compactionOutput: Record<string, unknown>;
    readonly id?: string | undefined;
    readonly createdAt?: number | string | undefined;
};

type ResponsesPayload = {
    readonly model: string;
    readonly input: readonly unknown[];
    readonly instructions?: unknown;
    readonly [key: string]: unknown;
};

export function registerNativeCompactionDisplay(pi: ExtensionAPI): void {
    pi.registerMessageRenderer(NATIVE_COMPACTION_MESSAGE_TYPE, (message, _options, theme) => {
        return {
            render(width: number): string[] {
                const text =
                    typeof message.content === "string"
                        ? message.content
                        : NATIVE_COMPACTION_MESSAGE_TEXT;
                return text.split("\n").map((line) => theme.fg("dim", line).slice(0, width));
            },
            invalidate(): void {},
        };
    });
}

export async function handleCodexNativeCompaction(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    config: CodexCoreConfig,
): Promise<
    | {
          readonly cancel?: true;
          readonly compaction?: {
              readonly summary: string;
              readonly firstKeptEntryId: string;
              readonly tokensBefore: number;
              readonly details: NativeCompactionDetails;
          };
      }
    | undefined
> {
    if (!config.compaction.enabled) return undefined;
    if (event.signal.aborted) return { cancel: true };
    const runtime = await resolveActiveCodexResponsesProvider(ctx);
    if (!runtime) return undefined;

    const input = serializeRemoteCompactionInput(event);
    if (input.length === 0) return undefined;
    const compactionModel = resolveCodexRequestModel(config.openai.compactionModel, runtime.model);

    const request = buildRemoteCompactionV2Request({
        model: compactionModel,
        input,
        instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions),
        promptCacheKey: safePromptCacheKey(ctx.sessionManager.getSessionId()),
        verbosity: config.openai.verbosity,
        fast: config.openai.fast,
        reasoning: buildReasoning(config).reasoning,
    });

    try {
        const response = await executeRemoteCompactionV2(runtime, request, event.signal);
        const compactedWindow = buildRemoteCompactionV2Window(input, response.compactionOutput);
        if (compactedWindow.length === 0 || !hasCompactionOutputItem(compactedWindow)) {
            if (ctx.hasUI) {
                ctx.ui.notify(
                    "Codex remote compaction v2 returned no usable compacted context; Pi compaction will run.",
                    "warning",
                );
            }
            return undefined;
        }
        return {
            compaction: {
                summary: NATIVE_COMPACTION_SHIM_SUMMARY,
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
                details: {
                    strategy: NATIVE_COMPACTION_STRATEGY,
                    provider: runtime.provider,
                    api: runtime.api,
                    model: compactionModel,
                    baseUrl: runtime.baseUrl,
                    compactedWindow,
                    compactResponseId: response.id,
                    createdAt: normalizeCreatedAt(response.createdAt),
                },
            },
        };
    } catch (cause: unknown) {
        if (isAbortCause(cause)) return { cancel: true };
        const message = cause instanceof Error ? cause.message : String(cause);
        if (ctx.hasUI) {
            ctx.ui.notify(
                `Codex remote compaction v2 failed: ${message}; Pi compaction will run.`,
                "warning",
            );
        }
        return undefined;
    }
}

export async function rewriteProviderRequestWithNativeCompaction(
    payload: unknown,
    ctx: ExtensionContext,
    config: CodexCoreConfig,
): Promise<unknown> {
    if (!config.compaction.enabled || !isResponsesPayload(payload)) return undefined;
    const details = findLatestNativeCompactionDetails(ctx);
    if (!details || !currentModelMatchesDetails(ctx, details)) return undefined;

    const input = [...payload.input];
    const withoutShim = input.filter((item) => !itemContainsShimSummary(item));
    let insertAt = 0;
    while (insertAt < withoutShim.length && isInstructionItem(withoutShim[insertAt])) insertAt += 1;
    return {
        ...payload,
        input: [
            ...withoutShim.slice(0, insertAt),
            ...details.compactedWindow.map((item) => structuredClone(item)),
            ...withoutShim.slice(insertAt),
        ],
    };
}

export function isNativeCompactionDetails(value: unknown): value is NativeCompactionDetails {
    if (!isRecord(value)) return false;
    return (
        value.strategy === NATIVE_COMPACTION_STRATEGY &&
        typeof value.provider === "string" &&
        typeof value.api === "string" &&
        typeof value.model === "string" &&
        typeof value.baseUrl === "string" &&
        typeof value.createdAt === "string" &&
        Array.isArray(value.compactedWindow) &&
        value.compactedWindow.every(isRecord)
    );
}

export function findLatestNativeCompactionDetails(
    ctx: ExtensionContext,
): NativeCompactionDetails | undefined {
    const branch = ctx.sessionManager.getBranch() as readonly unknown[];
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (!isRecord(entry) || entry.type !== "compaction") continue;
        if (isNativeCompactionDetails(entry.details)) return entry.details;
    }
    return undefined;
}

function serializeRemoteCompactionInput(
    event: SessionBeforeCompactEvent,
): Record<string, unknown>[] {
    const messages = [
        ...(event.preparation.previousSummary
            ? [
                  {
                      role: "user",
                      content: `Previous compaction summary:\n${event.preparation.previousSummary}`,
                  },
              ]
            : []),
        ...event.branchEntries.flatMap((entry) =>
            entry.type === "message" ? [entry.message] : [],
        ),
    ];
    const input: Record<string, unknown>[] = [];
    let messageIndex = 0;
    for (const message of messages) {
        input.push(...serializeMessage(message, messageIndex));
        messageIndex += 1;
    }
    if (input.length > 0) return input;

    for (const message of [
        ...event.preparation.messagesToSummarize,
        ...event.preparation.turnPrefixMessages,
    ]) {
        input.push(...serializeMessage(message, messageIndex));
        messageIndex += 1;
    }
    return input;
}

function serializeMessage(message: unknown, messageIndex: number): Record<string, unknown>[] {
    if (!isRecord(message) || typeof message.role !== "string") return [];
    if (message.role === "user") {
        const content = inputContentFromContent(message.content);
        return content.length > 0 ? [{ role: "user", content }] : [];
    }
    if (message.role === "assistant") {
        const items: Record<string, unknown>[] = [];
        const text = textFromContent(message.content);
        if (text) {
            items.push({
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text, annotations: [] }],
                status: "completed",
                id: `msg_pi_compact_${messageIndex}`,
            });
        }
        for (const toolCall of toolCallsFromContent(message.content)) items.push(toolCall);
        return items;
    }
    if (message.role === "toolResult") {
        const callId =
            typeof message.toolCallId === "string" ? message.toolCallId.split("|")[0] : undefined;
        if (!callId) return [];
        return [
            {
                type: "function_call_output",
                call_id: callId,
                output: textFromContent(message.content) ?? "(no output)",
            },
        ];
    }
    return [];
}

function inputContentFromContent(content: unknown): unknown[] {
    if (typeof content === "string") return [{ type: "input_text", text: content }];
    if (!Array.isArray(content)) return [];
    return content.flatMap((item): unknown[] => {
        if (!isRecord(item)) return [];
        if (item.type === "text" && typeof item.text === "string")
            return [{ type: "input_text", text: item.text }];
        if (
            item.type === "image" &&
            typeof item.mimeType === "string" &&
            typeof item.data === "string"
        ) {
            return [
                {
                    type: "input_image",
                    image_url: `data:${item.mimeType};base64,${item.data}`,
                    detail: "auto",
                },
            ];
        }
        return [];
    });
}

function textFromContent(content: unknown): string | undefined {
    if (typeof content === "string") return content.trim() || undefined;
    if (!Array.isArray(content)) return undefined;
    const parts = content.flatMap((item) =>
        isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
    );
    const text = parts.join("\n").trim();
    return text.length > 0 ? text : undefined;
}

function toolCallsFromContent(content: unknown): Record<string, unknown>[] {
    if (!Array.isArray(content)) return [];
    return content.flatMap((item) => {
        if (
            !isRecord(item) ||
            item.type !== "toolCall" ||
            typeof item.id !== "string" ||
            typeof item.name !== "string"
        )
            return [];
        const [callId, itemId] = item.id.split("|");
        if (!callId) return [];
        return [
            {
                type: "function_call",
                ...(itemId ? { id: itemId } : {}),
                call_id: callId,
                name: item.name,
                arguments: JSON.stringify(isRecord(item.arguments) ? item.arguments : {}),
            },
        ];
    });
}

function buildRemoteCompactionV2Request(input: {
    readonly model: string;
    readonly input: readonly Record<string, unknown>[];
    readonly instructions: string;
    readonly promptCacheKey: string;
    readonly verbosity: string;
    readonly fast: boolean;
    readonly reasoning?: { readonly effort: string; readonly summary: "auto" } | undefined;
}): Record<string, unknown> {
    return {
        model: input.model,
        instructions: input.instructions,
        input: [...input.input, { type: "compaction_trigger" }],
        tool_choice: "auto",
        parallel_tool_calls: true,
        store: false,
        stream: true,
        include: input.reasoning ? ["reasoning.encrypted_content"] : [],
        prompt_cache_key: input.promptCacheKey,
        text: { verbosity: input.verbosity },
        ...(input.fast ? { service_tier: "priority" } : {}),
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    };
}

async function executeRemoteCompactionV2(
    runtime: { readonly responsesUrl: string; readonly headers: Headers },
    request: unknown,
    signal: AbortSignal,
): Promise<RemoteCompactionV2Response> {
    const response = await fetch(runtime.responsesUrl, {
        method: "POST",
        headers: runtime.headers,
        signal,
        body: JSON.stringify(request),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    return collectRemoteCompactionV2Output(text);
}

function collectRemoteCompactionV2Output(sseText: string): RemoteCompactionV2Response {
    let outputItemCount = 0;
    const compactionItems: Record<string, unknown>[] = [];
    let completed = false;
    let responseId: string | undefined;
    let createdAt: number | string | undefined;

    for (const event of parseServerSentEvents(sseText)) {
        if (event.event === "response.output_item.done") {
            const item = parseEventItem(event.data);
            if (!item) continue;
            outputItemCount += 1;
            if (item.type === "compaction" || item.type === "compaction_summary") {
                compactionItems.push(item);
            }
            continue;
        }
        if (event.event === "response.completed") {
            const response = parseEventResponse(event.data);
            completed = true;
            responseId = typeof response?.id === "string" ? response.id : undefined;
            createdAt = parseCreatedAt(response);
            continue;
        }
        if (event.event === "response.failed" || event.event === "response.incomplete") {
            throw new Error(formatResponsesStreamFailure(event.data, event.event));
        }
    }

    if (!completed) throw new Error("remote compaction v2 stream closed before response.completed");
    if (compactionItems.length !== 1) {
        throw new Error(
            `remote compaction v2 expected exactly one compaction output item, got ${compactionItems.length} from ${outputItemCount} output items`,
        );
    }
    return {
        compactionOutput: compactionItems[0] ?? unreachableCompactionOutput(),
        id: responseId,
        createdAt,
    };
}

function buildRemoteCompactionV2Window(
    promptInput: readonly Record<string, unknown>[],
    compactionOutput: Record<string, unknown>,
): Record<string, unknown>[] {
    const retained = promptInput
        .filter(isRetainedRemoteCompactionMessage)
        .map((item) => structuredClone(item));
    const truncated = truncateRetainedMessages(retained, 64_000);
    return [...truncated, structuredClone(compactionOutput)];
}

function parseServerSentEvents(
    text: string,
): Array<{ readonly event: string; readonly data: readonly string[] }> {
    const events: Array<{ readonly event: string; readonly data: string[] }> = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
        let event = "message";
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice("event:".length).trim();
            else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
        }
        if (data.length > 0) events.push({ event, data });
    }
    return events;
}

function parseEventItem(data: readonly string[]): Record<string, unknown> | undefined {
    const parsed = parseEventPayload(data);
    if (!isRecord(parsed)) return undefined;
    return isRecord(parsed.item) ? parsed.item : undefined;
}

function parseEventResponse(data: readonly string[]): Record<string, unknown> | undefined {
    const parsed = parseEventPayload(data);
    if (!isRecord(parsed)) return undefined;
    return isRecord(parsed.response) ? parsed.response : undefined;
}

function parseEventPayload(data: readonly string[]): unknown {
    const text = data.join("\n").trim();
    if (text.length === 0 || text === "[DONE]") return undefined;
    try {
        return JSON.parse(text) as unknown;
    } catch (cause: unknown) {
        throw new Error(
            `failed to parse remote compaction v2 stream event: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    }
}

function parseCreatedAt(
    response: Record<string, unknown> | undefined,
): number | string | undefined {
    const createdAt = response?.created_at;
    return typeof createdAt === "string" || typeof createdAt === "number" ? createdAt : undefined;
}

function formatResponsesStreamFailure(data: readonly string[], event: string): string {
    const response = parseEventResponse(data);
    const error = response?.error;
    if (isRecord(error) && typeof error.message === "string" && error.message.trim().length > 0)
        return `${event}: ${error.message.trim()}`;
    return `${event} event received during remote compaction v2`;
}

function isRetainedRemoteCompactionMessage(item: Record<string, unknown>): boolean {
    return item.role === "user";
}

function truncateRetainedMessages(
    items: readonly Record<string, unknown>[],
    maxTokens: number,
): Record<string, unknown>[] {
    let remaining = maxTokens;
    const retainedReversed: Record<string, unknown>[] = [];
    for (const item of [...items].reverse()) {
        if (remaining <= 0) continue;
        const tokenCount = Math.max(1, approximateResponseItemTokens(item));
        if (tokenCount <= remaining) {
            retainedReversed.push(item);
            remaining -= tokenCount;
        } else {
            const truncated = truncateResponseItemText(item, remaining);
            if (truncated) retainedReversed.push(truncated);
            remaining = 0;
        }
    }
    return retainedReversed.reverse();
}

function approximateResponseItemTokens(item: Record<string, unknown>): number {
    return Math.ceil(JSON.stringify(item).length / 4);
}

function truncateResponseItemText(
    item: Record<string, unknown>,
    maxTokens: number,
): Record<string, unknown> | undefined {
    if (maxTokens <= 0) return undefined;
    const cloned = structuredClone(item);
    const maxCharacters = Math.max(1, maxTokens * 4);
    const content = cloned.content;
    if (!Array.isArray(content)) return cloned;
    let remaining = maxCharacters;
    const nextContent: unknown[] = [];
    for (const part of content) {
        if (!isRecord(part) || typeof part.text !== "string") {
            nextContent.push(part);
            continue;
        }
        if (remaining <= 0) continue;
        const text = part.text.slice(-remaining);
        remaining -= text.length;
        nextContent.push({ ...part, text });
    }
    cloned.content = nextContent;
    return cloned;
}

function unreachableCompactionOutput(): Record<string, unknown> {
    throw new Error("remote compaction v2 compaction output disappeared");
}

function hasCompactionOutputItem(compactedWindow: readonly Record<string, unknown>[]): boolean {
    return compactedWindow.some(
        (item) =>
            item.type === "compaction" ||
            item.type === "compaction_summary" ||
            item.type === "context_compaction",
    );
}

function buildCompactionInstructions(systemPrompt: string, customInstructions?: string): string {
    const guidance = customInstructions?.trim();
    return guidance
        ? `${systemPrompt}\n\nAdditional user guidance for this manual /compact request:\n${guidance}`
        : systemPrompt;
}

function buildReasoning(config: CodexCoreConfig): {
    readonly reasoning?: { readonly effort: string; readonly summary: "auto" };
} {
    if (config.openai.compactionReasoning === "current") return {};
    return { reasoning: { effort: config.openai.compactionReasoning, summary: "auto" } };
}

function currentModelMatchesDetails(
    ctx: ExtensionContext,
    details: NativeCompactionDetails,
): boolean {
    const model = ctx.model;
    if (!model) return false;
    return (
        model.provider === details.provider &&
        model.api === details.api &&
        resolveCodexApiProviderBaseUrl(model.baseUrl) === details.baseUrl
    );
}

function isResponsesPayload(value: unknown): value is ResponsesPayload {
    return isRecord(value) && typeof value.model === "string" && Array.isArray(value.input);
}

function isInstructionItem(item: unknown): boolean {
    return isRecord(item) && (item.role === "system" || item.role === "developer");
}

function itemContainsShimSummary(item: unknown): boolean {
    if (!isRecord(item)) return false;
    const content = item.content;
    if (typeof content === "string") return content.includes(NATIVE_COMPACTION_SHIM_SUMMARY);
    if (!Array.isArray(content)) return false;
    return content.some(
        (block) =>
            isRecord(block) &&
            typeof block.text === "string" &&
            block.text.includes(NATIVE_COMPACTION_SHIM_SUMMARY),
    );
}

function normalizeCreatedAt(value: unknown): string {
    if (typeof value === "number" && Number.isFinite(value))
        return new Date(value > 1_000_000_000_000 ? value : value * 1000).toISOString();
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
    }
    return new Date().toISOString();
}

function safePromptCacheKey(value: string): string {
    return Array.from(value).slice(0, 64).join("");
}

function isAbortCause(cause: unknown): boolean {
    return cause instanceof DOMException && cause.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
