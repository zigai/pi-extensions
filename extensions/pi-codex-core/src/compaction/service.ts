import type {
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import {
    resolveActiveCodexResponsesProvider,
    resolveCodexApiProviderBaseUrl,
} from "../codex/auth.ts";
import { isAbortCause as isCodexAbortCause, safeCauseMessage } from "../codex/failures.ts";
import { codexModelRequestProfile } from "../codex/models.ts";
import { CODEX_RESPONSES_LITE_HEADER } from "../codex/responses-compat.ts";
import { resolveCodexRequestModel, type CodexCoreConfig } from "../config/config.ts";
import { defaultCodexRuntime, type CodexRuntime } from "../runtime.ts";
import { cancelAutoCompactionState, clearAutoCompactionSessionState } from "./auto-compaction.ts";
import { NATIVE_COMPACTION_SHIM_SUMMARY, NATIVE_COMPACTION_STRATEGY } from "./messages.ts";
import { executeRemoteCompactionV2 } from "./remote-client.ts";
import {
    buildCompactionInstructions,
    buildCompactionTools,
    buildReasoning,
    buildRemoteCompactionV2Request,
    buildRemoteCompactionV2Window,
    createTokenEstimateCache,
    hasCompactionOutputItem,
    resolveCompactionTargetModel,
    rewriteRemoteCompactionToolOutputsForContextWindow,
    shrinkRemoteCompactionRequestForContextWindow,
} from "./request-budget.ts";
import { asResponsesPayload, buildRemoteCompactionPromptInput } from "./responses-input.ts";
import {
    buildLenientNativeReplayPayload,
    buildWindowLifecycle,
    clearReplayWindowSessionState,
    clearReplayWindowState,
    findLatestNativeCompactionEntry,
    notifyNativeReplayFallbackOnce,
    rewriteResponsesPayloadWithNativeReplay,
} from "./replay-window.ts";
import { shutdownCodexTokenizer } from "./tokenizer.ts";
import {
    applyRemoteCompactionTransportHeaders,
    buildRemoteCompactionTransportMetadata,
} from "./transport-metadata.ts";
import type {
    NativeCompactionDetails,
    NativeCompactionMatch,
    NativeCompactionWorldState,
    ResponsesInputItem,
} from "./types.ts";

const CODEX_CORE_WORLD_STATE_TAG = "codex_core_world_state";

export { maybeTriggerCodexAutoCompaction, scheduleCodexAutoCompaction } from "./auto-compaction.ts";
export {
    NATIVE_COMPACTION_MESSAGE_TYPE,
    NATIVE_COMPACTION_SHIM_SUMMARY,
    NATIVE_COMPACTION_STRATEGY,
} from "./messages.ts";
export { findLatestNativeCompactionDetails, isNativeCompactionDetails } from "./replay-window.ts";

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
    if (!event.branchEntries.some((entry) => entry.id === event.preparation.firstKeptEntryId)) {
        if (ctx.hasUI) {
            ctx.ui.notify(
                "Compaction was cancelled because Pi provided an invalid retained-context boundary.",
                "warning",
            );
        }
        return { cancel: true };
    }
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
    const sessionId = ctx.sessionManager.getSessionId();
    const previousWindowId = latestNativeCompaction?.entry.details.windowId;
    const transportMetadata = buildRemoteCompactionTransportMetadata({
        sessionId,
        turnId: runtimeServices.idGenerator.randomUUID(),
        windowId: isUuid(previousWindowId)
            ? previousWindowId
            : runtimeServices.idGenerator.randomUUID(),
        reason: event.reason,
        startedAtMs: runtimeServices.clock.nowMs(),
    });
    let promptInput = buildRemoteCompactionPromptInput(event, targetModel, latestNativeCompaction);
    if (promptInput.input.length === 0) return undefined;
    const instructions = buildCompactionInstructions(
        ctx.getSystemPrompt(),
        event.customInstructions,
    );
    const tools = buildCompactionTools(pi);
    const promptCacheKey = safePromptCacheKey(sessionId);
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
            clientMetadata: transportMetadata.clientMetadata,
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
        clientMetadata: transportMetadata.clientMetadata,
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
        applyRemoteCompactionTransportHeaders(headers, transportMetadata);
        const responseResult = await executeRemoteCompactionV2(
            { responsesUrl: runtime.value.responsesUrl, headers },
            shrink.request,
            event.signal,
            runtimeServices,
        );
        if (responseResult.isErr()) {
            notifyCompactionFallback(ctx, responseResult.error.message);
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
                "Codex remote compaction v2 returned no usable compacted context",
            );
            await shutdownCodexTokenizer();
            return undefined;
        }
        const worldState = captureNativeCompactionWorldState(ctx, pi, runtimeServices, event);
        const lifecycle = buildWindowLifecycle(latestNativeCompaction, runtimeServices);
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
        notifyCompactionFallback(ctx, `Codex remote compaction v2 failed: ${message}`);
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

    const branchEntries = ctx.sessionManager.getBranch();
    const latestNativeCompaction = findLatestNativeCompactionEntry(branchEntries, match);
    if (!latestNativeCompaction) return undefined;

    const responsesPayload = asResponsesPayload(payload);
    if (!responsesPayload) return undefined;

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

export function cancelScheduledCodexAutoCompaction(): void {
    cancelAutoCompactionState();
    clearReplayWindowState();
}

export function clearCodexCompactionSessionState(sessionId: string): void {
    clearAutoCompactionSessionState(sessionId);
    clearReplayWindowSessionState(sessionId);
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

function notifyCompactionFallback(ctx: ExtensionContext, message: string): void {
    if (ctx.hasUI) {
        ctx.ui.notify(`${message}; Pi compaction will run.`, "warning");
    }
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

function isUuid(value: string | undefined): value is string {
    return (
        value !== undefined &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    );
}
