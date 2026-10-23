import { registerExtensionDiagnostics } from "@zigai/pi-extension-internals";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { installCodexRequestTierWrapper } from "./codex/request-tier.ts";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

import { codexCoreActivationDecisions, syncCodexCoreTools } from "./activation.ts";
import { isModelWithStringApi } from "./codex/auth.ts";
import { codexModelRequestProfile } from "./codex/models.ts";
import {
    CODEX_RESPONSES_LITE_HEADER,
    applyFastMode,
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
import {
    DEFAULT_CODEX_CORE_CONFIG,
    readCodexCoreStartupConfig,
    type CodexCoreConfig,
} from "./config/config.ts";
import { rewriteProviderImageDetails } from "./images/detail.ts";
import { buildCodexCoreSystemPromptResult } from "./prompt/system-prompt.ts";
import { CodexRecoveryCoordinator, supportsInteractiveRecovery } from "./recovery/coordinator.ts";
import { registerCodexCommand } from "./settings/command.ts";
import { registerCodexSettingsHost } from "./settings/integration.ts";
import { registerApplyPatchTool } from "./tools/apply-patch/tool.ts";
import { registerImagegenTool } from "./tools/imagegen.ts";
import { registerViewImageTool } from "./tools/view-image/tool.ts";
import { registerWebRunTool } from "./tools/web-run/tool.ts";
import {
    OptionalTogglesActivation,
    prepareTogglesPrompt,
    resolveTogglesModelRole,
} from "./toggles-activation.ts";
import { registerCompactionHandler } from "@zigai/pi-extension-internals/compaction-handlers";
import { prepareSystemPromptOptions } from "@zigai/pi-extension-internals/prompt-preparation";

/** Package display name used in user-visible extension messages. */
export const extensionName = "Pi Codex Core";

/** Generated npm package name. */
export const packageName = "pi-codex-core";

const FAST_MODE_STARTUP_WARNING =
    "Fast mode is enabled: supported Codex calls prioritize speed, with higher credit usage that varies by model and pricing.";

type CompactionModule = typeof import("./compaction/service.ts");

let compactionModulePromise: Promise<CompactionModule> | undefined;
const activatedApis = new WeakSet<ExtensionAPI>();
const thinkingLevelValidator = Compile(
    Type.Enum({
        off: "off",
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
    } satisfies { [Level in ModelThinkingLevel]: Level }),
);

async function loadCompactionModule(): Promise<CompactionModule> {
    compactionModulePromise ??= import("./compaction/service.ts");
    return compactionModulePromise;
}

/** Register the Pi Codex Core Pi extension. */
export default function extension(pi: ExtensionAPI): void {
    if (activatedApis.has(pi)) return;

    let config: CodexCoreConfig = DEFAULT_CODEX_CORE_CONFIG;
    let sessionGeneration = 0;
    let requestTierWrapper: ReturnType<typeof installCodexRequestTierWrapper>;
    const syncRequestTierWrapper = (ctx: Parameters<typeof syncCodexCoreTools>[1]): void => {
        requestTierWrapper?.dispose();
        requestTierWrapper = undefined;

        const provider = ctx.modelRegistry.getProvider("openai-codex");
        if (provider !== undefined) requestTierWrapper = installCodexRequestTierWrapper(provider);
    };

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
        sessionGeneration += 1;

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
        syncRequestTierWrapper(ctx);
        syncToolActivation(ctx);

        if (config.openai.fast && ctx.hasUI) {
            ctx.ui.notify(FAST_MODE_STARTUP_WARNING, "warning");
        }
    });

    pi.on("model_select", async (_event, ctx) => {
        syncRequestTierWrapper(ctx);
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
        const generation = sessionGeneration;
        try {
            await prepareSystemPromptOptions(pi.events, event.systemPromptOptions);
        } catch (cause: unknown) {
            if (generation === sessionGeneration) ctx.abort();
            throw cause;
        }

        if (generation !== sessionGeneration) return undefined;

        let prompt: string | undefined;
        if (event.messageType === "user") prompt = event.prompt;

        const composer = await prepareTogglesPrompt(pi.events, {
            getPrompt: () => event.systemPrompt,
            prompt,
            options: event.systemPromptOptions,
        });

        if (generation !== sessionGeneration) return undefined;

        const result = buildCodexCoreSystemPromptResult(
            composer?.basePrompt ?? event.systemPrompt,
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

        const systemPrompt = await (composer?.compose(result.prompt) ?? result.prompt);

        if (generation !== sessionGeneration) return undefined;

        return { systemPrompt };
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

    const compactionHandler = registerCompactionHandler(pi, "codex-native", {
        available: (ctx) => config.compaction.enabled && isActiveCodexResponsesModel(ctx),
        defaultPriority: 100,
        async compact(event, ctx) {
            const operationConfig = structuredClone(config);
            const role = resolveTogglesModelRole(pi.events, "compaction");
            if (
                role?.status === "invalid" ||
                (role?.status === "resolved" && role.model.provider !== ctx.model?.provider)
            ) {
                if (ctx.hasUI)
                    ctx.ui.notify(
                        "The preset compaction model role is invalid for Codex native compaction.",
                        "warning",
                    );

                return { cancel: true };
            }

            if (role?.status === "resolved") {
                operationConfig.openai.compactionModel = role.model.modelId;

                const thinkingLevel = role.model.thinkingLevel;
                if (thinkingLevel !== undefined) {
                    let targetModel = ctx.model;
                    if (targetModel?.id !== role.model.modelId)
                        targetModel = ctx.modelRegistry.find(
                            role.model.provider,
                            role.model.modelId,
                        );

                    if (!targetModel || !thinkingLevelValidator.Check(thinkingLevel))
                        return { cancel: true };

                    const level = clampThinkingLevel(targetModel, thinkingLevel);
                    let fallbackEffort: string = level;
                    if (level === "off") fallbackEffort = "none";

                    operationConfig.openai.compactionReasoning =
                        targetModel.thinkingLevelMap?.[level] ?? fallbackEffort;
                }
            }

            try {
                const { handleCodexNativeCompaction } = await loadCompactionModule();
                return await handleCodexNativeCompaction(event, ctx, operationConfig, pi, {
                    tokenizer,
                });
            } catch {
                if (event.signal.aborted) return { cancel: true };

                if (ctx.hasUI)
                    ctx.ui.notify(
                        "Codex native compaction failed before completing its request; Pi compaction will run.",
                        "warning",
                    );

                return undefined;
            }
        },
    });
    const selectionEvent = Compile(
        Type.Object(
            {
                version: Type.Literal(1),
                sessionId: Type.String(),
                name: Type.Literal("pi"),
            },
            { additionalProperties: false },
        ),
    );
    const unsubscribeCompactionSelection = pi.events.on("pi:compaction-selected", (value) => {
        if (!selectionEvent.Check(value)) return;

        const selection = selectionEvent.Parse(value);
        responsesLitePolicy.beginPiCompactionFallback(selection.sessionId);
    });

    pi.on("session_compact", async (_event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        responsesLitePolicy.finishCompaction(sessionId);
    });

    pi.on("session_compact_failed", (_event, ctx) => {
        responsesLitePolicy.finishCompaction(ctx.sessionManager.getSessionId());
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
        const reasoningPayload = reasoningTracePayload ?? compatiblePayload;
        let requestPayload = reasoningPayload;
        if (config.openai.fast && isActiveGptResponsesModel(ctx)) {
            requestPayload = applyFastMode(reasoningPayload, ctx.model?.id) ?? reasoningPayload;
        }

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
        sessionGeneration += 1;
        unregisterCodexSettingsHost();

        if (event.reason === "quit" || event.reason === "reload") {
            compactionHandler.dispose();
            unsubscribeCompactionSelection();
            togglesActivation.dispose();
        } else {
            togglesActivation.resetSession();
        }

        recovery.stop();
        requestTierWrapper?.dispose();
        requestTierWrapper = undefined;

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
    registerExtensionDiagnostics(pi);
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

export { codexModelRequestProfile } from "./codex/models.ts";
export { formatCodexUsage, parseCodexUsagePayload } from "./codex/usage.ts";
export {
    parseCodexCoreConfig,
    readCodexCoreConfig,
    writeCodexCoreConfig,
} from "./config/config.ts";
