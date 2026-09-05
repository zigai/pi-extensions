import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { codexCoreActivationDecisions, syncCodexCoreTools } from "./activation.ts";
import { isModelWithStringApi } from "./codex/auth.ts";
import { codexModelRequestProfile } from "./codex/models.ts";
import {
    CODEX_RESPONSES_LITE_HEADER,
    omitReasoningSummary,
    rewriteCodexResponsesPayload,
} from "./codex/responses-compat.ts";
import { ResponsesLiteRequestPolicy } from "./codex/responses-lite-policy.ts";
import { registerNativeCompactionDisplay } from "./compaction/display.ts";
import {
    captureProviderRequestTemplate,
    clearProviderRequestTemplate,
} from "./compaction/provider-request-template.ts";
import { CodexTokenizer } from "./compaction/tokenizer.ts";
import { readCodexCoreStartupConfig, type CodexCoreConfig } from "./config/config.ts";
import { rewriteProviderImageDetails } from "./images/detail.ts";
import { buildCodexCoreSystemPromptResult } from "./prompt/system-prompt.ts";
import { CodexRecoveryCoordinator, supportsInteractiveRecovery } from "./recovery/coordinator.ts";
import { registerCodexCommand } from "./settings/command.ts";
import { registerCodexSettingsHost } from "./settings/integration.ts";
import { registerApplyPatchTool } from "./tools/apply-patch/tool.ts";
import { registerImagegenTool } from "./tools/imagegen.ts";
import { registerViewImageTool } from "./tools/view-image/tool.ts";
import { registerWebRunTool } from "./tools/web-run/tool.ts";
import { OptionalTogglesActivation } from "./toggles-activation.ts";

/** Package display name used in user-visible extension messages. */
export const extensionName = "Pi Codex Core";

/** Generated npm package name. */
export const packageName = "pi-codex-core";

const FAST_MODE_STARTUP_WARNING =
    "Fast mode is enabled: supported Codex calls can deliver up to 1.5x faster token velocity, with higher credit usage that varies by model and pricing.";

type CompactionModule = typeof import("./compaction/service.ts");

let compactionModulePromise: Promise<CompactionModule> | undefined;
const activatedApis = new WeakSet<ExtensionAPI>();

function loadCompactionModule(): Promise<CompactionModule> {
    compactionModulePromise ??= import("./compaction/service.ts");
    return compactionModulePromise;
}

/** Register the Pi Codex Core Pi extension. */
export default function extension(pi: ExtensionAPI): void {
    if (activatedApis.has(pi)) return;
    let config: CodexCoreConfig = readCodexCoreStartupConfig();
    activatedApis.add(pi);
    const responsesLitePolicy = new ResponsesLiteRequestPolicy();
    const tokenizer = new CodexTokenizer();
    const recovery = new CodexRecoveryCoordinator({ getConfig: () => config });
    const togglesActivation = new OptionalTogglesActivation(pi.events, packageName);
    const warnedPromptConflictSessions = new Set<string>();
    const unregisterCodexSettingsHost = registerCodexSettingsHost(packageName);

    const getConfig = (): CodexCoreConfig => config;
    const syncToolActivation = (ctx: Parameters<typeof syncCodexCoreTools>[1]): void => {
        const activation = togglesActivation.update(
            ctx.sessionManager.getSessionId(),
            codexCoreActivationDecisions(ctx, config),
        );
        syncCodexCoreTools(pi, ctx, config, { activation });
    };
    const applyConfig = (
        nextConfig: CodexCoreConfig,
        ctx: Parameters<typeof syncCodexCoreTools>[1],
    ): void => {
        config = nextConfig;
        recovery.applyConfig(pi);
        clearProviderRequestTemplate(ctx.sessionManager.getSessionId());
        if (config.compaction.enabled) {
            tokenizer.warm();
        }
        syncToolActivation(ctx);
    };

    registerWebRunTool(pi, { getConfig, tokenizer });
    registerImagegenTool(pi, { getConfig });
    registerViewImageTool(pi, { getConfig });
    registerApplyPatchTool(pi);
    registerNativeCompactionDisplay(pi);
    registerCodexCommand(pi, { getConfig, applyConfig });

    pi.on("session_start", async (_event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        responsesLitePolicy.clearSession(sessionId);
        clearProviderRequestTemplate(sessionId);
        warnedPromptConflictSessions.delete(sessionId);
        config = ctx.isProjectTrusted()
            ? readCodexCoreStartupConfig({ cwd: ctx.cwd })
            : readCodexCoreStartupConfig();
        if (config.compaction.enabled) {
            tokenizer.warm();
        }
        recovery.start(pi, ctx);
        syncToolActivation(ctx);
        if (config.openai.fast && ctx.hasUI) {
            ctx.ui.notify(FAST_MODE_STARTUP_WARNING, "warning");
        }
    });

    pi.on("model_select", async (_event, ctx) => {
        clearProviderRequestTemplate(ctx.sessionManager.getSessionId());
        syncToolActivation(ctx);
    });

    pi.on("input", (event, ctx) => {
        if (
            !supportsInteractiveRecovery(ctx) ||
            event.source === "extension" ||
            !config.recovery.enabled ||
            !isActiveCodexResponsesModel(ctx)
        ) {
            return { action: "continue" };
        }
        const hasImages = (event.images?.length ?? 0) > 0;
        if (
            config.recovery.batchFollowUps &&
            event.streamingBehavior === "followUp" &&
            !hasImages
        ) {
            recovery.queueFollowUp(pi, ctx, event.text);
            return { action: "handled" };
        }
        if (event.streamingBehavior === undefined) {
            const text = recovery.mergePendingIntoManualInput(pi, event.text);
            if (text !== undefined) return { action: "transform", text };
        }
        return { action: "continue" };
    });

    pi.on("message_end", (event) => {
        if (event.message.role === "assistant") recovery.observeAssistant(event.message);
    });

    pi.on("before_agent_start", async (event, ctx) => {
        const result = buildCodexCoreSystemPromptResult(
            event.systemPrompt,
            config,
            event.systemPromptOptions,
            { modelId: ctx.model?.id },
        );
        const sessionId = ctx.sessionManager.getSessionId();
        if (
            result.interop === "unrecognized-replacement" &&
            ctx.hasUI &&
            !warnedPromptConflictSessions.has(sessionId)
        ) {
            warnedPromptConflictSessions.add(sessionId);
            ctx.ui.notify(
                "Pi Codex Core could not safely merge a system-prompt replacement from an earlier extension; Codex prompt mode took precedence. Load Pi Codex Core before that extension or use append-style prompt changes.",
                "warning",
            );
        }
        return {
            systemPrompt: result.prompt,
        };
    });

    pi.on("before_provider_headers", (event, ctx) => {
        if (
            isActiveCodexResponsesModel(ctx) &&
            codexModelRequestProfile(ctx.model?.id)?.useResponsesLite &&
            responsesLitePolicy.shouldAttachLiteHeader(ctx.sessionManager.getSessionId())
        ) {
            event.headers[CODEX_RESPONSES_LITE_HEADER] = "true";
        }
    });

    pi.on("session_before_compact", async (event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        if (!config.compaction.enabled) {
            responsesLitePolicy.beginPiCompactionFallback(sessionId);
            return undefined;
        }
        try {
            const { handleCodexNativeCompaction } = await loadCompactionModule();
            const result = await handleCodexNativeCompaction(event, ctx, config, pi, {
                tokenizer,
            });
            if (result === undefined) responsesLitePolicy.beginPiCompactionFallback(sessionId);
            return result;
        } catch {
            if (event.signal.aborted) return { cancel: true };
            responsesLitePolicy.beginPiCompactionFallback(sessionId);
            if (ctx.hasUI) {
                ctx.ui.notify(
                    "Codex native compaction failed before completing its request; Pi compaction will run.",
                    "warning",
                );
            }
            return undefined;
        }
    });

    pi.on("session_compact", async (_event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        responsesLitePolicy.finishCompaction(sessionId);
    });

    pi.on("agent_end", async (event, ctx) => {
        if (!config.compaction.enabled || !config.compaction.auto) {
            return;
        }
        const { scheduleCodexAutoCompaction } = await loadCompactionModule();
        scheduleCodexAutoCompaction(ctx, config, undefined, {
            completedMessages: event.messages,
        });
    });

    pi.on("agent_settled", async (_event, ctx) => {
        if (supportsInteractiveRecovery(ctx) && isActiveCodexResponsesModel(ctx)) {
            recovery.settle(pi, ctx);
        }
        if (!config.compaction.enabled || !config.compaction.auto) return;
        const { scheduleCodexAutoCompaction } = await loadCompactionModule();
        scheduleCodexAutoCompaction(ctx, config);
    });

    pi.on("before_provider_request", async (event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const isPiCompactionFallback = responsesLitePolicy.isPiCompactionFallback(sessionId);
        const imageDetailPayload = rewriteProviderImageDetails(event.payload);
        const payload = imageDetailPayload ?? event.payload;
        const allowLitePayload = responsesLitePolicy.shouldRewriteLitePayload(sessionId);
        const responsesPayload =
            isActiveCodexResponsesModel(ctx) && allowLitePayload
                ? rewriteCodexResponsesPayload(payload, sessionId, ctx.model?.id)
                : undefined;
        const compatiblePayload = responsesPayload ?? payload;
        const reasoningTracePayload =
            !config.openai.showReasoningTraces && isActiveGptResponsesModel(ctx)
                ? omitReasoningSummary(compatiblePayload, ctx.model?.id)
                : undefined;
        const requestPayload = reasoningTracePayload ?? compatiblePayload;
        let finalPayload = requestPayload;
        if (config.compaction.enabled) {
            const { rewriteProviderRequestWithNativeCompaction } = await loadCompactionModule();
            const compactionPayload = await rewriteProviderRequestWithNativeCompaction(
                requestPayload,
                ctx,
                config,
                pi,
            );
            finalPayload = compactionPayload ?? requestPayload;
        }
        if (!isPiCompactionFallback && isActiveCodexResponsesModel(ctx)) {
            captureProviderRequestTemplate(sessionId, finalPayload, {
                activeToolNames: pi.getActiveTools(),
            });
        }
        return finalPayload === event.payload ? undefined : finalPayload;
    });

    pi.on("session_shutdown", async (event, ctx) => {
        unregisterCodexSettingsHost();
        recovery.stop();
        togglesActivation.dispose();
        const sessionId = ctx.sessionManager.getSessionId();
        responsesLitePolicy.clearSession(sessionId);
        clearProviderRequestTemplate(sessionId);
        warnedPromptConflictSessions.delete(sessionId);
        if (compactionModulePromise !== undefined) {
            const { cancelScheduledCodexAutoCompaction, clearCodexCompactionSessionState } =
                await compactionModulePromise;
            if (event.reason === "quit" || event.reason === "reload") {
                cancelScheduledCodexAutoCompaction();
            } else {
                clearCodexCompactionSessionState(ctx.sessionManager.getSessionId());
            }
        }
        await tokenizer.shutdown();
    });
}

function isActiveCodexResponsesModel(ctx: Parameters<typeof syncCodexCoreTools>[1]): boolean {
    const model = ctx.model;
    return (
        isModelWithStringApi(model) &&
        model.provider.trim().toLowerCase() === "openai-codex" &&
        model.api.toLowerCase().includes("responses")
    );
}

function isActiveGptResponsesModel(ctx: Parameters<typeof syncCodexCoreTools>[1]): boolean {
    const model = ctx.model;
    return (
        isModelWithStringApi(model) &&
        model.id.trim().toLowerCase().startsWith("gpt-") &&
        model.api.toLowerCase().includes("responses")
    );
}

export { formatCodexUsage, parseCodexUsagePayload } from "./codex/usage.ts";
export {
    parseCodexCoreConfig,
    readCodexCoreConfig,
    writeCodexCoreConfig,
} from "./config/config.ts";
