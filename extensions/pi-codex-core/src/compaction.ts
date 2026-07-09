import { createHash } from "node:crypto";
import type {
    CompactionEntry,
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
    SessionEntry,
    ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { resolveCodexRequestModel, type CodexCoreConfig } from "./config.ts";
import {
    CodexHttpRequestFailed,
    CodexInvalidJson,
    CodexNetworkUnavailable,
    CodexRequestCancelled,
    CodexUnexpectedResponse,
    fail,
    isAbortCause as isCodexAbortCause,
    ok,
    safeCauseMessage,
    type CodexResult,
} from "./failures.ts";
import { defaultCodexRuntime, type CodexRuntime, type ScheduledTask } from "./runtime.ts";
import {
    resolveActiveCodexResponsesProvider,
    resolveCodexApiProviderBaseUrl,
} from "./codex-auth.ts";
import {
    NATIVE_COMPACTION_SHIM_SUMMARY,
    NATIVE_COMPACTION_STRATEGY,
} from "./compaction-messages.ts";
import { compileSchema, parseWithSchema } from "./schema-parsing.ts";
import {
    countCodexTextTokens,
    shutdownCodexTokenizer,
    truncateCodexTextToTokenBudget,
} from "./tokenizer.ts";
import { codexModelRequestProfile, codexReasoningEffortForRequest } from "./codex-models.ts";
import {
    CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY,
    CODEX_RESPONSES_LITE_HEADER,
} from "./responses-compat.ts";

export {
    NATIVE_COMPACTION_MESSAGE_TYPE,
    NATIVE_COMPACTION_SHIM_SUMMARY,
    NATIVE_COMPACTION_STRATEGY,
} from "./compaction-messages.ts";

const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
const RETAINED_INPUT_IMAGE_MIN_TOKEN_COST = 4_096;
const RETAINED_IMAGE_OMITTED_TEXT = "(image omitted from retained compacted window)";
const COMPACTION_REQUEST_BUDGET_RATIO = 0.8;
const TRUNCATED_TOOL_OUTPUT_MESSAGE = "[truncated]";
const COMPACTION_SUMMARY_PREFIX =
    "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const BRANCH_SUMMARY_PREFIX =
    "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "</summary>";
const CODEX_CORE_WORLD_STATE_TAG = "codex_core_world_state";
const AUTO_COMPACTION_MIN_INTERVAL_MS = 30_000;
const MAX_SSE_TAIL_CHARS = 1_000_000;
const MAX_SSE_EVENT_CHARS = 2_000_000;
const TOKEN_ESTIMATE_CHUNK_CHARS = 512 * 1024;
const TOKEN_ESTIMATE_CACHE_TEXT_MAX_CHARS = 8 * 1024;
const PENDING_NATIVE_WINDOW_MAX_AGE_MS = 5 * 60 * 1000;
const INLINE_IMAGE_TOKEN_ESTIMATE_TEXT = "(inline image data omitted for token estimate)";

const JsonObjectSchema = Type.Record(Type.String(), Type.Unknown());
const StringArraySchema = Type.Array(Type.String());
const NativeCompactionRequestMetaSchema = Type.Object({
    previousCompactionEntryId: Type.Optional(Type.String()),
    retainedInputItems: Type.Number(),
    rewrittenToolOutputs: Type.Number(),
    estimatedTokensBefore: Type.Number(),
    estimatedTokensAfter: Type.Number(),
    budgetTokens: Type.Optional(Type.Number()),
});
const NativeCompactionWorldStateSchema = Type.Object({
    cwd: Type.String(),
    model: Type.String(),
    activeToolNames: StringArraySchema,
    readFiles: StringArraySchema,
    modifiedFiles: StringArraySchema,
    capturedAt: Type.String(),
});
const NativeCompactionDetailsSchema = Type.Object({
    strategy: Type.Literal(NATIVE_COMPACTION_STRATEGY),
    provider: Type.String(),
    api: Type.String(),
    model: Type.String(),
    baseUrl: Type.String(),
    compactedWindow: Type.Array(JsonObjectSchema),
    replacementInput: Type.Optional(Type.Array(JsonObjectSchema)),
    windowNumber: Type.Number(),
    windowId: Type.String(),
    firstWindowId: Type.String(),
    previousWindowId: Type.Optional(Type.String()),
    sourceCompactionEntryId: Type.Optional(Type.String()),
    worldState: NativeCompactionWorldStateSchema,
    compactResponseId: Type.Optional(Type.String()),
    createdAt: Type.String(),
    requestMeta: Type.Optional(NativeCompactionRequestMetaSchema),
});
const JsonObjectValidator = compileSchema(JsonObjectSchema);
const NativeCompactionRequestMetaValidator = compileSchema(NativeCompactionRequestMetaSchema);
const NativeCompactionWorldStateValidator = compileSchema(NativeCompactionWorldStateSchema);
const NativeCompactionDetailsValidator = compileSchema(NativeCompactionDetailsSchema);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
type JsonObject = { readonly [key: string]: JsonValue | undefined };

type ResponsesInputItem = JsonObject;

type CompactionTextBlock = {
    readonly type: "text";
    readonly text: string;
};

type CompactionImageBlock = {
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
    readonly detail?: "auto" | "high" | "original" | undefined;
};

type CompactionThinkingBlock = {
    readonly type: "thinking";
    readonly thinking?: string | undefined;
    readonly thinkingSignature?: string | undefined;
    readonly redacted?: boolean | undefined;
};

type CompactionToolCallBlock = {
    readonly type: "toolCall";
    readonly id: string;
    readonly name: string;
    readonly arguments?: JsonObject | undefined;
};

type CompactionContentBlock =
    | CompactionTextBlock
    | CompactionImageBlock
    | CompactionThinkingBlock
    | CompactionToolCallBlock;

type CompactionMessageContent = string | readonly CompactionContentBlock[];

type CompactionMessage =
    | {
          readonly role: "user";
          readonly content: CompactionMessageContent;
      }
    | {
          readonly role: "assistant";
          readonly content: readonly CompactionContentBlock[];
          readonly provider?: string | undefined;
          readonly api?: string | undefined;
          readonly model?: string | undefined;
          readonly stopReason?: string | undefined;
      }
    | {
          readonly role: "toolResult";
          readonly toolCallId?: string | undefined;
          readonly content: readonly CompactionContentBlock[];
      };

type ResponsesTool = {
    readonly type: "function";
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonValue;
    readonly strict: null;
};

type NativeCompactionRequestMeta = {
    readonly previousCompactionEntryId?: string | undefined;
    readonly retainedInputItems: number;
    readonly rewrittenToolOutputs: number;
    readonly estimatedTokensBefore: number;
    readonly estimatedTokensAfter: number;
    readonly budgetTokens?: number | undefined;
};

type NativeCompactionWorldState = {
    readonly cwd: string;
    readonly model: string;
    readonly activeToolNames: readonly string[];
    readonly readFiles: readonly string[];
    readonly modifiedFiles: readonly string[];
    readonly capturedAt: string;
};

type NativeCompactionDetails = {
    readonly strategy: typeof NATIVE_COMPACTION_STRATEGY;
    readonly provider: string;
    readonly api: string;
    readonly model: string;
    readonly baseUrl: string;
    readonly compactedWindow: readonly ResponsesInputItem[];
    readonly windowNumber: number;
    readonly windowId: string;
    readonly firstWindowId: string;
    readonly previousWindowId?: string | undefined;
    readonly sourceCompactionEntryId?: string | undefined;
    readonly worldState: NativeCompactionWorldState;
    readonly compactResponseId?: string | undefined;
    readonly createdAt: string;
    readonly requestMeta?: NativeCompactionRequestMeta | undefined;
};

type NativeCompactionEntry = CompactionEntry<NativeCompactionDetails> & {
    readonly details: NativeCompactionDetails;
};

type RemoteCompactionV2Response = {
    readonly compactionOutput: ResponsesInputItem;
    readonly id?: string | undefined;
    readonly createdAt?: number | string | undefined;
};

type RemoteCompactionV2Request = {
    readonly model: string;
    readonly instructions?: string | undefined;
    readonly input: readonly ResponsesInputItem[];
    readonly tool_choice: "auto";
    readonly parallel_tool_calls: boolean;
    readonly store: false;
    readonly stream: true;
    readonly include: readonly string[];
    readonly prompt_cache_key: string;
    readonly text: { readonly verbosity: string };
    readonly service_tier?: "priority" | undefined;
    readonly reasoning?: RemoteCompactionReasoning | undefined;
    readonly tools?: readonly ResponsesTool[] | undefined;
    readonly client_metadata?: Readonly<Record<string, string>> | undefined;
};

type RemoteCompactionReasoning = {
    readonly effort?: string | undefined;
    readonly summary?: "auto" | undefined;
    readonly context?: "all_turns" | undefined;
};

type ResponsesPayload = JsonObject & {
    readonly model: string;
    readonly input: readonly ResponsesInputItem[];
    readonly instructions?: JsonValue | undefined;
};

type NativeCompactionMatch = {
    readonly provider: string;
    readonly api: string;
    readonly baseUrl: string;
};

type FoundNativeCompactionEntry = {
    readonly entry: NativeCompactionEntry;
    readonly index: number;
};

type PendingPiCompactionNativeWindow = NativeCompactionMatch & {
    readonly sessionId: string;
    readonly replacementInput: readonly ResponsesInputItem[];
    readonly createdAtMs: number;
};

type BuildPromptInputResult = {
    readonly input: readonly ResponsesInputItem[];
    readonly previousCompactionEntryId?: string | undefined;
};

type RemoteCompactionRequestParts = {
    readonly model: string;
    readonly instructions: string;
    readonly promptCacheKey: string;
    readonly verbosity: string;
    readonly fast: boolean;
    readonly reasoning?: RemoteCompactionReasoning | undefined;
    readonly tools?: readonly ResponsesTool[] | undefined;
};

type RemoteCompactionPreflightResult = {
    readonly input: readonly ResponsesInputItem[];
    readonly rewrittenToolOutputs: number;
    readonly estimatedTokensBefore: number;
    readonly estimatedTokensAfter: number;
};

type TokenEstimateCache = {
    readonly objectTokens: WeakMap<object, number>;
    readonly textTokens: Map<string, number>;
};

type ShrinkRemoteCompactionRequestResult =
    | {
          readonly kind: "ok";
          readonly request: RemoteCompactionV2Request;
          readonly promptInput: readonly ResponsesInputItem[];
          readonly rewrittenToolOutputs: number;
          readonly estimatedTokensBefore: number;
          readonly estimatedTokensAfter: number;
          readonly budgetTokens?: number | undefined;
      }
    | {
          readonly kind: "too_large";
          readonly rewrittenToolOutputs: number;
          readonly estimatedTokensBefore: number;
          readonly estimatedTokensAfter: number;
          readonly budgetTokens: number;
      };

type NativeReplayResult =
    | { readonly ok: true; readonly payload: ResponsesPayload }
    | { readonly ok: false; readonly reason: string };

type AutoCompactionSessionState = {
    readonly lastTriggeredEntryId?: string | undefined;
    readonly lastTriggeredAt: number;
    readonly inFlight: boolean;
    readonly timer?: ScheduledTask | undefined;
};

type AgentEndCompactionMessage = {
    readonly role?: string | undefined;
    readonly stopReason?: string | undefined;
};

type ScheduleCodexAutoCompactionOptions = {
    readonly completedMessages?: readonly AgentEndCompactionMessage[] | undefined;
};

const pendingPiCompactionNativeWindows = new Map<string, PendingPiCompactionNativeWindow>();
const autoCompactionBySession = new Map<string, AutoCompactionSessionState>();
const nativeReplayWarningKeys = new Set<string>();

export async function handleCodexNativeCompaction(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    pi: ExtensionAPI,
    runtimeServices: CodexRuntime = defaultCodexRuntime,
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
    if (runtime.isErr() || !runtime.value) return undefined;

    const match: NativeCompactionMatch = {
        provider: runtime.value.provider,
        api: runtime.value.api,
        baseUrl: runtime.value.baseUrl,
    };
    const compactionModel = resolveCodexRequestModel(
        config.openai.compactionModel,
        runtime.value.model,
    );
    const targetModel = resolveCompactionTargetModel(ctx, compactionModel);
    const requestProfile = codexModelRequestProfile(compactionModel);
    const contextWindow = requestProfile?.effectiveContextWindow ?? targetModel?.contextWindow;
    const latestNativeCompaction = findLatestNativeCompactionEntry(event.branchEntries, match);
    let promptInput = buildRemoteCompactionPromptInput(event, targetModel, latestNativeCompaction);
    if (promptInput.input.length === 0) return undefined;
    const instructions = buildCompactionInstructions(
        ctx.getSystemPrompt(),
        event.customInstructions,
    );
    const tools = buildCompactionTools(pi);
    const promptCacheKey = safePromptCacheKey(ctx.sessionManager.getSessionId());
    const reasoning = buildReasoning(config, compactionModel).reasoning;
    let tokenCache = createTokenEstimateCache();
    const preflight = await rewriteRemoteCompactionToolOutputsForContextWindow(
        promptInput.input,
        {
            model: compactionModel,
            instructions,
            promptCacheKey,
            verbosity: config.openai.verbosity,
            fast: config.openai.fast,
            reasoning,
            tools,
        },
        contextWindow,
        tokenCache,
    );
    promptInput = { ...promptInput, input: preflight.input };

    const request = buildRemoteCompactionV2Request({
        model: compactionModel,
        input: promptInput.input,
        instructions,
        promptCacheKey,
        verbosity: config.openai.verbosity,
        fast: config.openai.fast,
        reasoning,
        tools,
    });
    const shrink = await shrinkRemoteCompactionRequestForContextWindow(
        request,
        contextWindow,
        tokenCache,
        preflight,
    );
    if (shrink.kind === "too_large") {
        notifyCompactionFallback(
            ctx,
            pi,
            runtimeServices,
            event.branchEntries,
            match,
            `Codex remote compaction v2 request is too large for the context window (${shrink.estimatedTokensAfter}/${shrink.budgetTokens} estimated tokens).`,
        );
        await shutdownCodexTokenizer();
        return undefined;
    }
    tokenCache = createTokenEstimateCache();
    try {
        const headers = new Headers(runtime.value.headers);
        if (requestProfile?.useResponsesLite) {
            headers.set(CODEX_RESPONSES_LITE_HEADER, "true");
        }
        const responseResult = await executeRemoteCompactionV2(
            { responsesUrl: runtime.value.responsesUrl, headers },
            shrink.request,
            event.signal,
            runtimeServices,
        );
        if (responseResult.isErr()) {
            notifyCompactionFallback(
                ctx,
                pi,
                runtimeServices,
                event.branchEntries,
                match,
                responseResult.error.message,
            );
            await shutdownCodexTokenizer();
            return responseResult.error._tag === "CodexRequestCancelled"
                ? { cancel: true }
                : undefined;
        }
        const response = responseResult.value;
        const compactedWindow = await buildRemoteCompactionV2Window(
            shrink.promptInput,
            response.compactionOutput,
            tokenCache,
        );
        if (compactedWindow.length === 0 || !hasCompactionOutputItem(compactedWindow)) {
            notifyCompactionFallback(
                ctx,
                pi,
                runtimeServices,
                event.branchEntries,
                match,
                "Codex remote compaction v2 returned no usable compacted context",
            );
            await shutdownCodexTokenizer();
            return undefined;
        }
        const worldState = captureNativeCompactionWorldState(ctx, pi, runtimeServices, event);
        const lifecycle = buildWindowLifecycle(latestNativeCompaction, runtimeServices);
        pendingPiCompactionNativeWindows.delete(ctx.sessionManager.getSessionId());
        await shutdownCodexTokenizer();
        return {
            compaction: {
                summary: NATIVE_COMPACTION_SHIM_SUMMARY,
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
                details: {
                    strategy: NATIVE_COMPACTION_STRATEGY,
                    provider: runtime.value.provider,
                    api: runtime.value.api,
                    model: compactionModel,
                    baseUrl: runtime.value.baseUrl,
                    compactedWindow,
                    windowNumber: lifecycle.windowNumber,
                    windowId: lifecycle.windowId,
                    firstWindowId: lifecycle.firstWindowId,
                    previousWindowId: lifecycle.previousWindowId,
                    sourceCompactionEntryId: lifecycle.sourceCompactionEntryId,
                    worldState,
                    compactResponseId: response.id,
                    createdAt: normalizeCreatedAt(response.createdAt, runtimeServices),
                    requestMeta: {
                        previousCompactionEntryId: promptInput.previousCompactionEntryId,
                        retainedInputItems: compactedWindow.length,
                        rewrittenToolOutputs: shrink.rewrittenToolOutputs,
                        estimatedTokensBefore: shrink.estimatedTokensBefore,
                        estimatedTokensAfter: shrink.estimatedTokensAfter,
                        budgetTokens: shrink.budgetTokens,
                    },
                },
            },
        };
    } catch (cause: unknown) {
        if (isCodexAbortCause(cause)) {
            await shutdownCodexTokenizer();
            return { cancel: true };
        }
        const message = safeCauseMessage(cause);
        notifyCompactionFallback(
            ctx,
            pi,
            runtimeServices,
            event.branchEntries,
            match,
            `Codex remote compaction v2 failed: ${message}`,
        );
        await shutdownCodexTokenizer();
        return undefined;
    }
}

export async function rewriteProviderRequestWithNativeCompaction(
    payload: unknown,
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    pi: ExtensionAPI,
    runtime: CodexRuntime = defaultCodexRuntime,
): Promise<unknown> {
    if (!config.compaction.enabled) return undefined;
    const model = ctx.model;
    if (!model) return undefined;
    const match: NativeCompactionMatch = {
        provider: model.provider,
        api: model.api,
        baseUrl: resolveCodexApiProviderBaseUrl(model.baseUrl),
    };

    const sessionId = ctx.sessionManager.getSessionId();
    const branchEntries = ctx.sessionManager.getBranch();
    const latestNativeCompaction = findLatestNativeCompactionEntry(branchEntries, match);
    const pendingNativeWindow = getPendingNativeWindow(sessionId, match, runtime);
    if (!latestNativeCompaction && !pendingNativeWindow) return undefined;

    const responsesPayload = asResponsesPayload(payload);
    if (!responsesPayload) return undefined;

    const pendingFallbackRewrite = injectPendingNativeWindowIntoPiCompactionRequest(
        responsesPayload,
        ctx,
        match,
        runtime,
    );
    if (pendingFallbackRewrite) return pendingFallbackRewrite;

    if (!latestNativeCompaction) return undefined;
    const replacementInput = buildFreshReplacementInput(
        latestNativeCompaction.entry.details,
        ctx,
        pi,
        runtime,
    );

    const replay = rewriteResponsesPayloadWithNativeReplay({
        payload: responsesPayload,
        model,
        branchEntries,
        compactionEntry: latestNativeCompaction.entry,
        replacementInput,
    });
    if (replay.ok) return replay.payload;

    notifyNativeReplayFallbackOnce(ctx, latestNativeCompaction.entry.id, replay.reason);
    return buildLenientNativeReplayPayload(responsesPayload, replacementInput);
}

export function isNativeCompactionDetails(value: unknown): value is NativeCompactionDetails {
    return parseNativeCompactionDetails(value) !== undefined;
}

function parseNativeCompactionDetails(value: unknown): NativeCompactionDetails | undefined {
    const details = parseWithSchema(NativeCompactionDetailsValidator, value);
    if (!details) return undefined;
    const compactedWindow = parseResponsesInputItems(details.compactedWindow);
    const legacyReplacementInput =
        details.replacementInput === undefined
            ? undefined
            : parseResponsesInputItems(details.replacementInput);
    const worldState = parseWithSchema(NativeCompactionWorldStateValidator, details.worldState);
    const requestMeta =
        details.requestMeta === undefined
            ? undefined
            : parseWithSchema(NativeCompactionRequestMetaValidator, details.requestMeta);
    if (
        !compactedWindow ||
        (details.replacementInput !== undefined && !legacyReplacementInput) ||
        !worldState ||
        !Number.isFinite(details.windowNumber) ||
        details.windowNumber < 1 ||
        (details.requestMeta !== undefined && !requestMeta)
    ) {
        return undefined;
    }
    return {
        strategy: NATIVE_COMPACTION_STRATEGY,
        provider: details.provider,
        api: details.api,
        model: details.model,
        baseUrl: details.baseUrl,
        compactedWindow,
        windowNumber: details.windowNumber,
        windowId: details.windowId,
        firstWindowId: details.firstWindowId,
        previousWindowId: details.previousWindowId,
        sourceCompactionEntryId: details.sourceCompactionEntryId,
        worldState,
        compactResponseId: details.compactResponseId,
        createdAt: details.createdAt,
        requestMeta,
    };
}

export function findLatestNativeCompactionDetails(
    ctx: ExtensionContext,
): NativeCompactionDetails | undefined {
    const branch = ctx.sessionManager.getBranch();
    const latest = findLatestNativeCompactionEntry(branch);
    return latest?.entry.details;
}

export function scheduleCodexAutoCompaction(
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    runtime: CodexRuntime = defaultCodexRuntime,
    options: ScheduleCodexAutoCompactionOptions = {},
): boolean {
    if (!config.compaction.enabled || !config.compaction.auto) return false;
    if (latestAssistantEndedWithError(options.completedMessages)) return false;
    const sessionId = ctx.sessionManager.getSessionId();
    const state = autoCompactionBySession.get(sessionId);
    if (state?.timer || state?.inFlight) return false;

    const timer = runtime.scheduler.set(0, () => {
        const latestState = autoCompactionBySession.get(sessionId);
        if (latestState?.timer === timer) {
            autoCompactionBySession.set(sessionId, { ...latestState, timer: undefined });
        }
        maybeTriggerCodexAutoCompaction(ctx, config, runtime);
    });

    autoCompactionBySession.set(sessionId, {
        lastTriggeredEntryId: state?.lastTriggeredEntryId,
        lastTriggeredAt: state?.lastTriggeredAt ?? 0,
        inFlight: state?.inFlight ?? false,
        timer,
    });
    return true;
}

export function cancelScheduledCodexAutoCompaction(): void {
    for (const state of autoCompactionBySession.values()) {
        if (state.timer) state.timer.cancel();
    }
    pendingPiCompactionNativeWindows.clear();
    autoCompactionBySession.clear();
    nativeReplayWarningKeys.clear();
}

export function clearCodexCompactionSessionState(sessionId: string): void {
    const state = autoCompactionBySession.get(sessionId);
    state?.timer?.cancel();
    autoCompactionBySession.delete(sessionId);
    pendingPiCompactionNativeWindows.delete(sessionId);
    for (const key of nativeReplayWarningKeys) {
        if (key.startsWith(`${sessionId}:`)) nativeReplayWarningKeys.delete(key);
    }
}

function latestAssistantEndedWithError(
    messages: readonly AgentEndCompactionMessage[] | undefined,
): boolean {
    if (messages === undefined) return false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === "assistant") return message.stopReason === "error";
    }
    return false;
}

export function maybeTriggerCodexAutoCompaction(
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    runtime: CodexRuntime = defaultCodexRuntime,
): boolean {
    if (!config.compaction.enabled || !config.compaction.auto) return false;
    if (!ctx.isIdle()) return false;
    const usage = ctx.getContextUsage();
    if (!usage) return false;
    const effectiveContextWindow = codexModelRequestProfile(ctx.model?.id)?.effectiveContextWindow;
    const usagePercent =
        effectiveContextWindow && usage.tokens !== null
            ? (usage.tokens / effectiveContextWindow) * 100
            : usage.percent;
    if (usagePercent === null || usagePercent < config.compaction.thresholdPercent) return false;

    const sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    const latestEntryId = branch.at(-1)?.id;
    const state = autoCompactionBySession.get(sessionId);
    const now = runtime.clock.nowMs();
    if (state?.inFlight) return false;
    if (state?.lastTriggeredEntryId === latestEntryId) return false;
    if (state && now - state.lastTriggeredAt < AUTO_COMPACTION_MIN_INTERVAL_MS) return false;

    autoCompactionBySession.set(sessionId, {
        lastTriggeredEntryId: latestEntryId,
        lastTriggeredAt: now,
        inFlight: true,
        timer: state?.timer,
    });
    try {
        ctx.compact({
            onComplete: () => finishAutoCompaction(sessionId),
            onError: () => finishAutoCompaction(sessionId),
        });
        return true;
    } catch {
        finishAutoCompaction(sessionId);
        return false;
    }
}

function finishAutoCompaction(sessionId: string): void {
    const state = autoCompactionBySession.get(sessionId);
    if (!state) return;
    autoCompactionBySession.set(sessionId, { ...state, inFlight: false });
}

function buildRemoteCompactionPromptInput(
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

    const branchInput = serializeEntriesToResponsesInput(model, event.branchEntries);
    if (branchInput.length > 0) return { input: branchInput };

    const messages: CompactionMessage[] = [];
    if (event.preparation.previousSummary) {
        messages.push({
            role: "user",
            content: `Previous compaction summary:\n${event.preparation.previousSummary}`,
        });
    }
    for (const rawMessage of [
        ...event.preparation.messagesToSummarize,
        ...event.preparation.turnPrefixMessages,
    ]) {
        const message = parseCompactionMessage(rawMessage);
        if (message) messages.push(message);
    }
    return { input: serializeMessagesToResponsesInput(model, messages) };
}

function serializeEntriesToResponsesInput(
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
        return parseCompactionMessage({
            role: "user",
            content: entry.content,
        });
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
        return {
            role: "user",
            content: [
                {
                    type: "text",
                    text: `${COMPACTION_SUMMARY_PREFIX}${entry.summary}${COMPACTION_SUMMARY_SUFFIX}`,
                },
            ],
        };
    }
    return undefined;
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

function buildRemoteCompactionV2Request(input: {
    readonly model: string;
    readonly input: readonly ResponsesInputItem[];
    readonly instructions: string;
    readonly promptCacheKey: string;
    readonly verbosity: string;
    readonly fast: boolean;
    readonly reasoning?: RemoteCompactionReasoning | undefined;
    readonly tools?: readonly ResponsesTool[] | undefined;
}): RemoteCompactionV2Request {
    const profile = codexModelRequestProfile(input.model);
    const serviceTier =
        input.fast && (profile?.supportsPriorityServiceTier ?? true)
            ? { service_tier: "priority" as const }
            : {};
    if (profile?.useResponsesLite) {
        const instructions = sanitizeSurrogates(input.instructions);
        return {
            model: input.model,
            input: [
                {
                    type: "additional_tools",
                    role: "developer",
                    tools: (input.tools ?? []).map((tool) => ({ ...tool })),
                },
                ...(instructions.length > 0
                    ? [
                          {
                              type: "message",
                              role: "developer",
                              content: [{ type: "input_text", text: instructions }],
                          },
                      ]
                    : []),
                ...input.input.map(stripResponsesLiteImageDetails),
                { type: "compaction_trigger" },
            ],
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
            stream: true,
            include: input.reasoning ? ["reasoning.encrypted_content"] : [],
            prompt_cache_key: input.promptCacheKey,
            text: { verbosity: input.verbosity },
            ...serviceTier,
            ...(input.reasoning ? { reasoning: input.reasoning } : {}),
            client_metadata: {
                [CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY]: "true",
            },
        };
    }
    return {
        model: input.model,
        instructions: sanitizeSurrogates(input.instructions),
        input: [...input.input, { type: "compaction_trigger" }],
        tool_choice: "auto",
        parallel_tool_calls: true,
        store: false,
        stream: true,
        include: input.reasoning ? ["reasoning.encrypted_content"] : [],
        prompt_cache_key: input.promptCacheKey,
        text: { verbosity: input.verbosity },
        ...serviceTier,
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
    };
}

function buildCompactionTools(pi: ExtensionAPI): ResponsesTool[] | undefined {
    const activeToolNames = new Set(pi.getActiveTools());
    const tools = pi
        .getAllTools()
        .filter((tool) => activeToolNames.has(tool.name))
        .map(toolInfoToResponsesTool);
    return tools.length > 0 ? tools : undefined;
}

function toolInfoToResponsesTool(tool: ToolInfo): ResponsesTool {
    return {
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: parseJsonValue(tool.parameters) ?? {},
        strict: null,
    };
}

async function rewriteRemoteCompactionToolOutputsForContextWindow(
    input: readonly ResponsesInputItem[],
    requestParts: RemoteCompactionRequestParts,
    contextWindow: number | null | undefined,
    cache: TokenEstimateCache,
): Promise<RemoteCompactionPreflightResult> {
    const estimatedTokensBefore = await estimateRemoteCompactionRequestTokens(
        buildRemoteCompactionV2Request({ ...requestParts, input }),
        cache,
    );
    const budgetTokens = compactRequestBudget(contextWindow);
    if (budgetTokens === undefined || estimatedTokensBefore <= budgetTokens) {
        return {
            input,
            rewrittenToolOutputs: 0,
            estimatedTokensBefore,
            estimatedTokensAfter: estimatedTokensBefore,
        };
    }

    const rewrittenInput = [...input];
    let rewrittenToolOutputs = 0;
    let estimatedTokensAfter = estimatedTokensBefore;
    for (
        let index = rewrittenInput.length - 1;
        index >= 0 && estimatedTokensAfter > budgetTokens;
        index -= 1
    ) {
        const item = rewrittenInput[index];
        if (!item || !isRewritableToolOutputItem(item)) continue;
        const rewrittenItem = rewriteToolOutputItem(item);
        rewrittenInput[index] = rewrittenItem;
        rewrittenToolOutputs += 1;
        const [beforeTokens, afterTokens] = await Promise.all([
            estimateResponsesInputItemTokens(item, cache),
            estimateResponsesInputItemTokens(rewrittenItem, cache),
        ]);
        estimatedTokensAfter += afterTokens - beforeTokens;
    }

    return {
        input: rewrittenToolOutputs === 0 ? input : rewrittenInput,
        rewrittenToolOutputs,
        estimatedTokensBefore,
        estimatedTokensAfter,
    };
}

async function shrinkRemoteCompactionRequestForContextWindow(
    request: RemoteCompactionV2Request,
    contextWindow: number | null | undefined,
    cache: TokenEstimateCache,
    preflight?: RemoteCompactionPreflightResult,
): Promise<ShrinkRemoteCompactionRequestResult> {
    const budgetTokens = compactRequestBudget(contextWindow);
    const estimatedTokensBefore =
        preflight?.estimatedTokensBefore ??
        (await estimateRemoteCompactionRequestTokens(request, cache));
    let rewrittenToolOutputs = preflight?.rewrittenToolOutputs ?? 0;
    let estimatedTokensAfter = preflight?.estimatedTokensAfter ?? estimatedTokensBefore;
    const promptInput = request.input.filter((item) => item.type !== "compaction_trigger");
    if (budgetTokens === undefined || estimatedTokensAfter <= budgetTokens) {
        return {
            kind: "ok",
            request,
            promptInput,
            rewrittenToolOutputs,
            estimatedTokensBefore,
            estimatedTokensAfter,
            budgetTokens,
        };
    }

    const input = [...request.input];
    for (let index = 0; index < input.length && estimatedTokensAfter > budgetTokens; index += 1) {
        const item = input[index];
        if (!item || !isRewritableToolOutputItem(item)) continue;
        const rewrittenItem = rewriteToolOutputItem(item);
        input[index] = rewrittenItem;
        rewrittenToolOutputs += 1;
        const [beforeTokens, afterTokens] = await Promise.all([
            estimateResponsesInputItemTokens(item, cache),
            estimateResponsesInputItemTokens(rewrittenItem, cache),
        ]);
        estimatedTokensAfter += afterTokens - beforeTokens;
    }

    for (let index = 0; index < input.length && estimatedTokensAfter > budgetTokens; ) {
        const item = input[index];
        if (!item || !isTrimCandidateForCompactionRequest(item)) {
            index += 1;
            continue;
        }
        input.splice(index, 1);
        estimatedTokensAfter -= await estimateResponsesInputItemTokens(item, cache);
    }

    if (estimatedTokensAfter > budgetTokens) {
        return {
            kind: "too_large",
            rewrittenToolOutputs,
            estimatedTokensBefore,
            estimatedTokensAfter,
            budgetTokens,
        };
    }

    const shrunkRequest = { ...request, input };
    return {
        kind: "ok",
        request: shrunkRequest,
        promptInput: shrunkRequest.input.filter((item) => item.type !== "compaction_trigger"),
        rewrittenToolOutputs,
        estimatedTokensBefore,
        estimatedTokensAfter,
        budgetTokens,
    };
}

async function executeRemoteCompactionV2(
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
        return fail(
            new CodexHttpRequestFailed({
                operation: "nativeCompaction",
                provider: "openai-codex",
                status: response.status,
                message: `Codex remote compaction failed with HTTP ${response.status}.`,
            }),
        );
    }
    if (!response.body) return collectRemoteCompactionV2Output(await response.text());
    return collectRemoteCompactionV2OutputFromStream(response.body);
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

type ServerSentEvent = {
    readonly event: string;
    readonly data: readonly string[];
};

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

async function buildRemoteCompactionV2Window(
    promptInput: readonly ResponsesInputItem[],
    compactionOutput: ResponsesInputItem,
    cache: TokenEstimateCache,
): Promise<ResponsesInputItem[]> {
    const retained = promptInput.filter(isRetainedRemoteCompactionMessage);
    const truncated = await truncateRetainedMessages(
        retained,
        RETAINED_MESSAGE_TOKEN_BUDGET,
        cache,
    );
    return [...truncated, compactionOutput];
}

function buildWindowLifecycle(
    latestNativeCompaction: FoundNativeCompactionEntry | undefined,
    runtime: CodexRuntime,
): {
    readonly windowNumber: number;
    readonly windowId: string;
    readonly firstWindowId: string;
    readonly previousWindowId?: string | undefined;
    readonly sourceCompactionEntryId?: string | undefined;
} {
    const previousDetails = latestNativeCompaction?.entry.details;
    const windowId = createWindowId(runtime);
    const previousWindowId = previousDetails?.windowId;
    return {
        windowNumber: (previousDetails?.windowNumber ?? 0) + 1,
        windowId,
        firstWindowId: previousDetails?.firstWindowId ?? windowId,
        previousWindowId,
        sourceCompactionEntryId: latestNativeCompaction?.entry.id,
    };
}

function buildFreshReplacementInput(
    details: NativeCompactionDetails,
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    runtime: CodexRuntime,
): ResponsesInputItem[] {
    const worldState = captureNativeCompactionWorldState(
        ctx,
        pi,
        runtime,
        undefined,
        details.worldState,
    );
    return [...details.compactedWindow, ...buildWorldStateInput(worldState, details)];
}

function captureNativeCompactionWorldState(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    runtime: CodexRuntime,
    event?: SessionBeforeCompactEvent,
    previous?: NativeCompactionWorldState,
): NativeCompactionWorldState {
    return {
        cwd: ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
        activeToolNames: pi.getActiveTools(),
        readFiles: event ? [...event.preparation.fileOps.read] : (previous?.readFiles ?? []),
        modifiedFiles: event
            ? [
                  ...new Set([
                      ...event.preparation.fileOps.written,
                      ...event.preparation.fileOps.edited,
                  ]),
              ]
            : (previous?.modifiedFiles ?? []),
        capturedAt: runtime.clock.nowDate().toISOString(),
    };
}

function buildWorldStateInput(
    worldState: NativeCompactionWorldState,
    details?: NativeCompactionDetails,
): ResponsesInputItem[] {
    const lines = [
        `<${CODEX_CORE_WORLD_STATE_TAG}>`,
        "Fresh Pi context after Codex native compaction.",
        `Current date: ${worldState.capturedAt.slice(0, 10)}`,
        `cwd: ${worldState.cwd}`,
        `model: ${worldState.model}`,
        `active tools: ${worldState.activeToolNames.length > 0 ? worldState.activeToolNames.join(", ") : "none"}`,
        ...(details
            ? [
                  `window: ${details.windowNumber}`,
                  `window id: ${details.windowId}`,
                  `first window id: ${details.firstWindowId}`,
                  ...(details.previousWindowId
                      ? [`previous window id: ${details.previousWindowId}`]
                      : []),
              ]
            : []),
        ...(worldState.readFiles.length > 0
            ? [`read files: ${worldState.readFiles.join(", ")}`]
            : []),
        ...(worldState.modifiedFiles.length > 0
            ? [`modified files: ${worldState.modifiedFiles.join(", ")}`]
            : []),
        `</${CODEX_CORE_WORLD_STATE_TAG}>`,
    ];
    return [{ role: "user", content: [{ type: "input_text", text: lines.join("\n") }] }];
}

function createWindowId(runtime: CodexRuntime): string {
    return `pi_codex_window_${runtime.idGenerator.randomUUID()}`;
}

function rewriteResponsesPayloadWithNativeReplay(input: {
    readonly payload: ResponsesPayload;
    readonly model: ExtensionContext["model"];
    readonly branchEntries: readonly SessionEntry[];
    readonly compactionEntry: NativeCompactionEntry;
    readonly replacementInput: readonly ResponsesInputItem[];
}): NativeReplayResult {
    const boundaryIndex = input.branchEntries.findIndex(
        (entry) => entry.id === input.compactionEntry.id,
    );
    if (boundaryIndex < 0) return { ok: false, reason: "compaction-boundary-not-found" };

    const firstKeptEntryIndex = input.branchEntries.findIndex(
        (entry, index) =>
            index < boundaryIndex && entry.id === input.compactionEntry.firstKeptEntryId,
    );
    if (firstKeptEntryIndex < 0) return { ok: false, reason: "first-kept-entry-not-found" };

    const inputItems = input.payload.input;

    const preambleCount = countLeadingInstructionItems(inputItems);
    const shimIndex = inputItems.findIndex(
        (item, index) => index >= preambleCount && itemContainsShimSummary(item),
    );
    if (shimIndex < 0) return { ok: false, reason: "compaction-shim-not-found" };

    const preCompactionKeptInput = serializeEntriesToResponsesInput(
        input.model,
        input.branchEntries.slice(firstKeptEntryIndex, boundaryIndex),
    );
    const afterShimIndex = shimIndex + 1;
    let keptReplayIndex = afterShimIndex;
    let afterKeptReplayIndex = afterShimIndex;
    if (preCompactionKeptInput.length > 0) {
        const matchedReplayIndex = findInputSliceIndex(
            inputItems,
            preCompactionKeptInput,
            afterShimIndex,
        );
        if (matchedReplayIndex < 0) {
            return { ok: false, reason: "expected-pi-replay-mismatch" };
        }
        keptReplayIndex = matchedReplayIndex;
        afterKeptReplayIndex = matchedReplayIndex + preCompactionKeptInput.length;
    }

    return {
        ok: true,
        payload: {
            ...input.payload,
            input: [
                ...inputItems.slice(0, shimIndex),
                ...input.replacementInput,
                ...inputItems.slice(afterShimIndex, keptReplayIndex),
                ...inputItems.slice(afterKeptReplayIndex),
            ],
        },
    };
}

function buildLenientNativeReplayPayload(
    payload: ResponsesPayload,
    replacementInput: readonly ResponsesInputItem[],
): ResponsesPayload {
    const input = payload.input;
    const withoutShim = input.filter((item) => !itemContainsShimSummary(item));
    let insertAt = 0;
    while (insertAt < withoutShim.length && isInstructionItem(withoutShim[insertAt])) insertAt += 1;
    return {
        ...payload,
        input: [
            ...withoutShim.slice(0, insertAt),
            ...replacementInput,
            ...withoutShim.slice(insertAt),
        ],
    };
}

function notifyNativeReplayFallbackOnce(
    ctx: ExtensionContext,
    compactionEntryId: string,
    reason: string,
): void {
    if (reason === "expected-pi-replay-mismatch") return;
    if (!ctx.hasUI) return;
    const key = `${ctx.sessionManager.getSessionId()}:${compactionEntryId}:${reason}`;
    if (nativeReplayWarningKeys.has(key)) return;
    nativeReplayWarningKeys.add(key);
    ctx.ui.notify(
        `Codex native compaction replay fell back to lenient rewrite (${reason}).`,
        "warning",
    );
}

function notifyCompactionFallback(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    runtime: CodexRuntime,
    branchEntries: readonly SessionEntry[],
    match: NativeCompactionMatch,
    message: string,
): void {
    const stashed = stashLatestNativeWindowForPiCompactionFallback(
        ctx,
        pi,
        runtime,
        branchEntries,
        match,
    );
    if (ctx.hasUI) {
        ctx.ui.notify(
            `${message}; Pi compaction will run.${stashed ? " Previous native compacted window will be included in Pi compaction fallback." : ""}`,
            "warning",
        );
    }
}

function stashLatestNativeWindowForPiCompactionFallback(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    runtime: CodexRuntime,
    branchEntries: readonly SessionEntry[],
    match: NativeCompactionMatch,
): boolean {
    const sessionId = ctx.sessionManager.getSessionId();
    pendingPiCompactionNativeWindows.delete(sessionId);
    const latestNativeCompaction = findLatestNativeCompactionEntry(branchEntries, match);
    if (!latestNativeCompaction) return false;
    const replacementInput = buildFreshReplacementInput(
        latestNativeCompaction.entry.details,
        ctx,
        pi,
        runtime,
    );
    if (replacementInput.length === 0) return false;
    pendingPiCompactionNativeWindows.set(sessionId, {
        ...match,
        sessionId,
        replacementInput,
        createdAtMs: runtime.clock.nowMs(),
    });
    return true;
}

function injectPendingNativeWindowIntoPiCompactionRequest(
    payload: ResponsesPayload,
    ctx: ExtensionContext,
    match: NativeCompactionMatch,
    runtime: CodexRuntime,
): ResponsesPayload | undefined {
    const sessionId = ctx.sessionManager.getSessionId();
    const pending = getPendingNativeWindow(sessionId, match, runtime);
    if (!pending) return undefined;
    if (!isPiCompactionSummarizationPayload(payload)) return undefined;

    const input = payload.input;
    let insertAt = 0;
    while (insertAt < input.length && isInstructionItem(input[insertAt])) insertAt += 1;
    pendingPiCompactionNativeWindows.delete(sessionId);
    return {
        ...payload,
        input: [...input.slice(0, insertAt), ...pending.replacementInput, ...input.slice(insertAt)],
    };
}

function getPendingNativeWindow(
    sessionId: string,
    match: NativeCompactionMatch,
    runtime: CodexRuntime,
): PendingPiCompactionNativeWindow | undefined {
    const pending = pendingPiCompactionNativeWindows.get(sessionId);
    if (!pending) return undefined;
    if (runtime.clock.nowMs() - pending.createdAtMs > PENDING_NATIVE_WINDOW_MAX_AGE_MS) {
        pendingPiCompactionNativeWindows.delete(sessionId);
        return undefined;
    }
    if (!nativeCompactionMatches(pending, match)) {
        pendingPiCompactionNativeWindows.delete(sessionId);
        return undefined;
    }
    return pending;
}

function isPiCompactionSummarizationPayload(payload: ResponsesPayload): boolean {
    const instructions = typeof payload.instructions === "string" ? payload.instructions : "";
    if (/compact|summar/i.test(instructions)) return true;
    return payload.input.some((item) => {
        if (!isJsonObject(item)) return false;
        const role = item.role;
        const text = textFromResponsesContent(item.content);
        if ((role === "system" || role === "developer") && /compact|summar/i.test(text))
            return true;
        return role === "user" && /<conversation>|previous compaction summary|summary/i.test(text);
    });
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

function isRetainedRemoteCompactionMessage(item: ResponsesInputItem): boolean {
    if (item.role !== "user") return false;
    const text = textFromResponsesContent(item.content).trim();
    if (text.includes(NATIVE_COMPACTION_SHIM_SUMMARY)) return false;
    if (/^<environment_context>[\s\S]*<\/environment_context>$/i.test(text)) return false;
    if (/^Previous compaction summary:/i.test(text)) return false;
    return text.length > 0 || inputImageCount(item) > 0;
}

async function truncateRetainedMessages(
    items: readonly ResponsesInputItem[],
    maxTokens: number,
    cache: TokenEstimateCache,
): Promise<ResponsesInputItem[]> {
    let remaining = maxTokens;
    const retainedReversed: ResponsesInputItem[] = [];
    for (const item of [...items].reverse()) {
        if (remaining <= 0) continue;
        const tokenCount = Math.max(1, await messageTextTokenCount(item, cache));
        if (tokenCount <= remaining) {
            retainedReversed.push(omitRetainedInputImages(item));
            remaining -= tokenCount;
        } else {
            const truncated = await truncateMessageTextToTokenBudget(item, remaining, cache);
            if (truncated) retainedReversed.push(truncated);
            remaining = 0;
        }
    }
    return retainedReversed.reverse();
}

function omitRetainedInputImages(item: ResponsesInputItem): ResponsesInputItem {
    const content = item.content;
    if (!isJsonArray(content)) return item;
    let changed = false;
    const nextContent = content.map((part): JsonValue => {
        if (!isInputImagePart(part)) return part;
        changed = true;
        return { type: "input_text", text: RETAINED_IMAGE_OMITTED_TEXT };
    });
    return changed ? { ...item, content: nextContent } : item;
}

async function messageTextTokenCount(
    item: ResponsesInputItem,
    cache: TokenEstimateCache,
): Promise<number> {
    const content = item.content;
    if (!isJsonArray(content))
        return typeof content === "string" ? estimateTextTokens(content, cache) : 0;
    const parts = content;
    let tokenCount = 0;
    for (const part of parts) tokenCount += await retainedContentPartTokenCount(part, cache);
    return tokenCount;
}

async function retainedContentPartTokenCount(
    part: JsonValue,
    cache: TokenEstimateCache,
): Promise<number> {
    if (isResponsesTextPart(part)) return estimateTextTokens(part.text, cache);
    if (isInputImagePart(part)) return inputImageRetainedTokenCount(part, cache);
    return estimateTokenCount(part, cache);
}

async function inputImageRetainedTokenCount(
    part: ResponsesInputItem,
    cache: TokenEstimateCache,
): Promise<number> {
    const imageUrlTokens =
        typeof part.image_url === "string" ? await estimateTextTokens(part.image_url, cache) : 0;
    return Math.max(RETAINED_INPUT_IMAGE_MIN_TOKEN_COST, imageUrlTokens);
}

function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
    return Array.isArray(value);
}

function isResponsesTextPart(
    part: JsonValue,
): part is ResponsesInputItem & { readonly text: string } {
    return isJsonObject(part) && typeof part.text === "string";
}

function isInputImagePart(part: JsonValue): part is ResponsesInputItem {
    return isJsonObject(part) && part.type === "input_image";
}

async function truncateMessageTextToTokenBudget(
    item: ResponsesInputItem,
    maxTokens: number,
    cache: TokenEstimateCache,
): Promise<ResponsesInputItem | undefined> {
    if (maxTokens <= 0) return undefined;
    const cloned = structuredClone(item);
    const content = cloned.content;
    if (typeof content === "string") {
        const text = await truncateTextToTokenBudget(content, maxTokens);
        return text.length > 0 ? { ...cloned, content: text } : undefined;
    }
    if (!isJsonArray(content)) return cloned;

    let remaining = maxTokens;
    const nextContent: JsonValue[] = [];
    for (const part of content) {
        if (remaining <= 0) continue;
        if (isResponsesTextPart(part)) {
            const tokenCount = await estimateTextTokens(part.text, cache);
            const text =
                tokenCount <= remaining
                    ? part.text
                    : await truncateTextToTokenBudget(part.text, remaining);
            remaining -= Math.min(tokenCount, remaining);
            if (text.length > 0) nextContent.push({ ...part, text });
            continue;
        }
        if (isInputImagePart(part)) {
            const tokenCount = await inputImageRetainedTokenCount(part, cache);
            if (tokenCount <= remaining) {
                nextContent.push({ type: "input_text", text: RETAINED_IMAGE_OMITTED_TEXT });
                remaining -= tokenCount;
                continue;
            }
            const placeholderTokens = await estimateTextTokens(RETAINED_IMAGE_OMITTED_TEXT, cache);
            if (placeholderTokens <= remaining) {
                nextContent.push({ type: "input_text", text: RETAINED_IMAGE_OMITTED_TEXT });
                remaining -= placeholderTokens;
            }
            continue;
        }
        const tokenCount = await estimateTokenCount(part, cache);
        if (tokenCount <= remaining) {
            nextContent.push(part);
            remaining -= tokenCount;
        }
    }
    if (nextContent.length === 0) return undefined;
    return { ...cloned, content: nextContent };
}

function hasCompactionOutputItem(compactedWindow: readonly ResponsesInputItem[]): boolean {
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

function buildReasoning(
    config: CodexCoreConfig,
    modelId: string,
): {
    readonly reasoning?: RemoteCompactionReasoning;
} {
    const profile = codexModelRequestProfile(modelId);
    const configuredEffort = config.openai.compactionReasoning;
    const effort =
        configuredEffort === "current"
            ? profile?.defaultReasoningEffort
            : codexReasoningEffortForRequest(configuredEffort);
    if (!effort) return {};
    return profile?.useResponsesLite
        ? { reasoning: { effort, context: "all_turns" } }
        : { reasoning: { effort, summary: "auto" } };
}

function resolveCompactionTargetModel(
    ctx: ExtensionContext,
    modelId: string,
): ExtensionContext["model"] | undefined {
    if (ctx.model?.provider === "openai-codex" && ctx.model.id === modelId) return ctx.model;
    return ctx.modelRegistry.find?.("openai-codex", modelId);
}

function stripResponsesLiteImageDetails(item: ResponsesInputItem): ResponsesInputItem {
    return stripResponsesLiteJsonObject(item);
}

function stripResponsesLiteJsonObject(value: JsonObject): JsonObject {
    const rewritten: Record<string, JsonValue | undefined> = {};
    for (const [key, item] of Object.entries(value)) {
        if (value.type === "input_image" && key === "detail") continue;
        rewritten[key] = stripResponsesLiteJsonValue(item);
    }
    return rewritten;
}

function stripResponsesLiteJsonValue(value: JsonValue | undefined): JsonValue | undefined {
    if (isJsonArray(value)) return value.map((item) => stripResponsesLiteJsonValue(item) ?? null);
    if (isJsonObject(value)) return stripResponsesLiteJsonObject(value);
    return value;
}

function findLatestNativeCompactionEntry(
    branch: readonly SessionEntry[],
    match?: NativeCompactionMatch,
): FoundNativeCompactionEntry | undefined {
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (!entry || entry.type !== "compaction") continue;
        const details = parseNativeCompactionDetails(entry.details);
        if (!details) continue;
        if (match && !nativeCompactionMatches(details, match)) continue;
        return { entry: { ...entry, details }, index };
    }
    return undefined;
}

function nativeCompactionMatches(
    details: Pick<NativeCompactionDetails, "provider" | "api" | "baseUrl">,
    match: NativeCompactionMatch,
): boolean {
    return (
        details.provider === match.provider &&
        details.api === match.api &&
        details.baseUrl === match.baseUrl
    );
}

function asResponsesPayload(value: unknown): ResponsesPayload | undefined {
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

function parseResponsesInputItems(value: unknown): ResponsesInputItem[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items: ResponsesInputItem[] = [];
    for (const item of value) {
        const inputItem = parseJsonObject(item);
        if (!inputItem) return undefined;
        items.push(inputItem);
    }
    return items;
}

function isInstructionItem(item: ResponsesInputItem | undefined): boolean {
    return isJsonObject(item) && (item.role === "system" || item.role === "developer");
}

function itemContainsShimSummary(item: ResponsesInputItem): boolean {
    if (!isJsonObject(item)) return false;
    return textFromResponsesContent(item.content).includes(NATIVE_COMPACTION_SHIM_SUMMARY);
}

function textFromResponsesContent(content: JsonValue | undefined): string {
    if (typeof content === "string") return content;
    if (!isJsonArray(content)) return "";
    return content
        .flatMap((item) => (isJsonObject(item) && typeof item.text === "string" ? [item.text] : []))
        .join("\n");
}

function inputImageCount(item: ResponsesInputItem): number {
    const content = item.content;
    if (!isJsonArray(content)) return 0;
    return content.filter((part) => isJsonObject(part) && part.type === "input_image").length;
}

function normalizeCreatedAt(value: unknown, runtime: CodexRuntime): string {
    if (typeof value === "number" && Number.isFinite(value))
        return new Date(value > 1_000_000_000_000 ? value : value * 1000).toISOString();
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
    }
    return runtime.clock.nowDate().toISOString();
}

function safePromptCacheKey(value: string): string {
    return Array.from(value).slice(0, 64).join("");
}

function countLeadingInstructionItems(input: readonly ResponsesInputItem[]): number {
    let count = 0;
    while (count < input.length && isInstructionItem(input[count])) count += 1;
    return count;
}

function findInputSliceIndex(
    input: readonly ResponsesInputItem[],
    expected: readonly ResponsesInputItem[],
    fromIndex: number,
): number {
    if (expected.length === 0) return fromIndex;
    const expectedKeys = expected.map(stableFingerprint);
    const prefixTable = buildPrefixTable(expectedKeys);
    let matched = 0;
    for (let index = Math.max(0, fromIndex); index < input.length; index += 1) {
        const inputKey = stableFingerprint(input[index]);
        while (matched > 0 && inputKey !== expectedKeys[matched]) {
            matched = prefixTable[matched - 1] ?? 0;
        }
        if (inputKey !== expectedKeys[matched]) continue;
        matched += 1;
        if (matched === expectedKeys.length) return index - expectedKeys.length + 1;
    }
    return -1;
}

function buildPrefixTable(values: readonly string[]): number[] {
    const table = Array.from({ length: values.length }, () => 0);
    let prefixLength = 0;
    for (let index = 1; index < values.length; index += 1) {
        while (prefixLength > 0 && values[index] !== values[prefixLength]) {
            prefixLength = table[prefixLength - 1] ?? 0;
        }
        if (values[index] === values[prefixLength]) prefixLength += 1;
        table[index] = prefixLength;
    }
    return table;
}

function stableFingerprint(value: unknown): string {
    const hash = createHash("sha256");
    const stats = { chars: 0, nodes: 0 };
    updateStableFingerprint(hash, value, stats, new WeakSet<object>());
    return `${stats.chars}:${stats.nodes}:${hash.digest("base64url")}`;
}

function updateStableFingerprint(
    hash: ReturnType<typeof createHash>,
    value: unknown,
    stats: { chars: number; nodes: number },
    seen: WeakSet<object>,
): void {
    stats.nodes += 1;
    if (value === null) {
        hash.update("null;");
        return;
    }
    if (typeof value === "string") {
        stats.chars += value.length;
        hash.update(`string:${value.length}:`);
        hash.update(value);
        hash.update(";");
        return;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        hash.update(`${typeof value}:${String(value)};`);
        return;
    }
    if (typeof value === "undefined" || typeof value === "symbol" || typeof value === "function") {
        hash.update(`${typeof value};`);
        return;
    }
    if (seen.has(value)) {
        hash.update("circular;");
        return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        hash.update(`array:${value.length}[`);
        for (const item of value) updateStableFingerprint(hash, item, stats, seen);
        hash.update("];");
        seen.delete(value);
        return;
    }

    hash.update("object{");
    // SAFETY: Fingerprinting treats arbitrary object properties as unknown and never trusts them.
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right),
    );
    for (const [key, nested] of entries) {
        updateStableFingerprint(hash, key, stats, seen);
        updateStableFingerprint(hash, nested, stats, seen);
    }
    hash.update("};");
    seen.delete(value);
}

function compactRequestBudget(contextWindow: number | null | undefined): number | undefined {
    if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0)
        return undefined;
    return Math.floor(contextWindow * COMPACTION_REQUEST_BUDGET_RATIO);
}

function isRewritableToolOutputItem(item: ResponsesInputItem): boolean {
    return item.type === "function_call_output" && item.output !== TRUNCATED_TOOL_OUTPUT_MESSAGE;
}

function rewriteToolOutputItem(item: ResponsesInputItem): ResponsesInputItem {
    return { ...item, output: TRUNCATED_TOOL_OUTPUT_MESSAGE };
}

function isTrimCandidateForCompactionRequest(item: ResponsesInputItem): boolean {
    return (
        !isNativeCompactionAnchor(item) &&
        item.type !== "compaction_trigger" &&
        item.type !== "function_call" &&
        item.type !== "function_call_output" &&
        !isInstructionItem(item)
    );
}

function isNativeCompactionAnchor(item: ResponsesInputItem): boolean {
    return (
        item.type === "compaction" ||
        item.type === "compaction_summary" ||
        item.type === "context_compaction"
    );
}

function createTokenEstimateCache(): TokenEstimateCache {
    return { objectTokens: new WeakMap(), textTokens: new Map() };
}

function estimateTokenCount(value: unknown, cache?: TokenEstimateCache): Promise<number> {
    if (cache && typeof value === "object" && value !== null) {
        return cachedObjectTokenCount(value, cache, () => {
            const serialized = JSON.stringify(sanitizeForTokenEstimate(value)) ?? "";
            return estimateTextTokens(serialized, cache);
        });
    }
    const serialized =
        typeof value === "string" ? value : (JSON.stringify(sanitizeForTokenEstimate(value)) ?? "");
    return estimateTextTokens(serialized, cache);
}

async function estimateRemoteCompactionRequestTokens(
    request: RemoteCompactionV2Request,
    cache: TokenEstimateCache,
): Promise<number> {
    let total = await estimateTextTokens(JSON.stringify({ ...request, input: [] }) ?? "", cache);
    for (const item of request.input) total += await estimateResponsesInputItemTokens(item, cache);
    return total;
}

async function estimateResponsesInputItemTokens(
    item: ResponsesInputItem,
    cache: TokenEstimateCache,
): Promise<number> {
    return cachedObjectTokenCount(item, cache, () =>
        estimateTokenParts(responsesInputItemTokenParts(item), cache),
    );
}

function* responsesInputItemTokenParts(item: ResponsesInputItem): Generator<string> {
    if (item.type === "function_call_output" && typeof item.output === "string") {
        yield JSON.stringify(sanitizeForTokenEstimate({ ...item, output: "" })) ?? "";
        yield item.output;
        return;
    }
    yield JSON.stringify(sanitizeForTokenEstimate(item)) ?? "";
}

function sanitizeForTokenEstimate(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sanitizeForTokenEstimate);
    if (typeof value !== "object" || value === null) return value;

    const next: Record<string, unknown> = {};
    // SAFETY: Token estimation only projects enumerable data into a JSON-like clone.
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        next[key] =
            key === "image_url" && typeof nested === "string" && nested.startsWith("data:")
                ? INLINE_IMAGE_TOKEN_ESTIMATE_TEXT
                : sanitizeForTokenEstimate(nested);
    }
    return next;
}

async function estimateTokenParts(
    parts: Iterable<string>,
    cache: TokenEstimateCache,
): Promise<number> {
    let total = 0;
    let chunk = "";
    for (const part of parts) {
        if (part.length >= TOKEN_ESTIMATE_CHUNK_CHARS) {
            if (chunk.length > 0) {
                total += await estimateTextTokens(chunk, cache);
                chunk = "";
            }
            total += await estimateTextTokens(part, cache);
            continue;
        }
        if (chunk.length + part.length > TOKEN_ESTIMATE_CHUNK_CHARS) {
            total += await estimateTextTokens(chunk, cache);
            chunk = "";
        }
        chunk += part;
    }
    return chunk.length > 0 ? total + (await estimateTextTokens(chunk, cache)) : total;
}

async function cachedObjectTokenCount(
    value: object,
    cache: TokenEstimateCache,
    compute: () => Promise<number>,
): Promise<number> {
    const cached = cache.objectTokens.get(value);
    if (cached !== undefined) return cached;
    const count = await compute();
    cache.objectTokens.set(value, count);
    return count;
}

async function estimateTextTokens(text: string, cache?: TokenEstimateCache): Promise<number> {
    if (!cache || text.length > TOKEN_ESTIMATE_CACHE_TEXT_MAX_CHARS) {
        return countCodexTextTokens(text);
    }
    const cached = cache.textTokens.get(text);
    if (cached !== undefined) return cached;
    const count = await countCodexTextTokens(text);
    cache.textTokens.set(text, count);
    return count;
}

function truncateTextToTokenBudget(text: string, maxTokens: number): Promise<string> {
    return truncateCodexTextToTokenBudget(text, maxTokens);
}

function sanitizeSurrogates(text: string): string {
    return text.replace(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
        "",
    );
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

function parseJsonValue(value: unknown): JsonValue | undefined {
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

function parseJsonObject(value: unknown): JsonObject | undefined {
    const record = parseWithSchema(JsonObjectValidator, value);
    if (!record) return undefined;
    const object: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(record)) {
        const parsed = parseJsonValue(nested);
        if (parsed !== undefined) object[key] = parsed;
    }
    return object;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return parseWithSchema(JsonObjectValidator, value) !== undefined;
}
