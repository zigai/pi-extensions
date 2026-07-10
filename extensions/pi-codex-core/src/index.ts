import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { syncCodexCoreTools } from "./activation.ts";
import { applyCodexModelMetadataCompatibility, codexModelRequestProfile } from "./codex/models.ts";
import {
    CODEX_RESPONSES_LITE_HEADER,
    omitReasoningSummary,
    rewriteCodexResponsesPayload,
} from "./codex/responses-compat.ts";
import { registerNativeCompactionDisplay } from "./compaction/display.ts";
import { shutdownCodexTokenizer, warmCodexTokenizer } from "./compaction/tokenizer.ts";
import { readCodexCoreConfig, type CodexCoreConfig } from "./config/config.ts";
import { rewriteProviderImageDetails } from "./images/detail.ts";
import { buildCodexCoreSystemPrompt } from "./prompt/system-prompt.ts";
import { registerCodexCommand } from "./settings/command.ts";
import { registerApplyPatchTool } from "./tools/apply-patch/tool.ts";
import { registerImagegenTool } from "./tools/imagegen.ts";
import { registerViewImageTool } from "./tools/view-image/tool.ts";
import { registerWebRunTool } from "./tools/web-run/tool.ts";

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
    activatedApis.add(pi);

    let config: CodexCoreConfig = readCodexCoreConfig();

    const getConfig = (): CodexCoreConfig => config;
    const applyConfig = (
        nextConfig: CodexCoreConfig,
        ctx: Parameters<typeof syncCodexCoreTools>[1],
    ): void => {
        config = nextConfig;
        if (config.compaction.enabled) {
            warmCodexTokenizer();
        }
        syncCodexCoreTools(pi, ctx, config);
    };

    registerWebRunTool(pi, { getConfig });
    registerImagegenTool(pi, { getConfig });
    registerViewImageTool(pi, { getConfig });
    registerApplyPatchTool(pi);
    registerNativeCompactionDisplay(pi);
    registerCodexCommand(pi, { getConfig, applyConfig });

    pi.on("session_start", async (_event, ctx) => {
        config = ctx.isProjectTrusted()
            ? readCodexCoreConfig({ cwd: ctx.cwd })
            : readCodexCoreConfig();
        if (config.compaction.enabled) {
            warmCodexTokenizer();
        }
        applyCodexModelMetadataCompatibility(ctx.model);
        syncCodexCoreTools(pi, ctx, config);
        if (config.openai.fast && ctx.hasUI) {
            ctx.ui.notify(FAST_MODE_STARTUP_WARNING, "warning");
        }
    });

    pi.on("model_select", async (_event, ctx) => {
        applyCodexModelMetadataCompatibility(ctx.model);
        syncCodexCoreTools(pi, ctx, config);
    });

    pi.on("before_agent_start", async (event, ctx) => {
        return {
            systemPrompt: buildCodexCoreSystemPrompt(
                event.systemPrompt,
                config,
                event.systemPromptOptions,
                { modelId: ctx.model?.id },
            ),
        };
    });

    pi.on("before_provider_headers", (event, ctx) => {
        if (
            isActiveCodexResponsesModel(ctx) &&
            codexModelRequestProfile(ctx.model?.id)?.useResponsesLite
        ) {
            event.headers[CODEX_RESPONSES_LITE_HEADER] = "true";
        }
    });

    pi.on("session_before_compact", async (event, ctx) => {
        if (!config.compaction.enabled) {
            return undefined;
        }
        const { handleCodexNativeCompaction } = await loadCompactionModule();
        return handleCodexNativeCompaction(event, ctx, config, pi);
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

    pi.on("before_provider_request", async (event, ctx) => {
        const imageDetailPayload = rewriteProviderImageDetails(event.payload);
        const payload = imageDetailPayload ?? event.payload;
        const responsesPayload = isActiveCodexResponsesModel(ctx)
            ? rewriteCodexResponsesPayload(payload, ctx.model?.id)
            : undefined;
        const compatiblePayload = responsesPayload ?? payload;
        const reasoningTracePayload =
            !config.openai.showReasoningTraces && isActiveGptResponsesModel(ctx)
                ? omitReasoningSummary(compatiblePayload, ctx.model?.id)
                : undefined;
        const requestPayload = reasoningTracePayload ?? compatiblePayload;
        if (!config.compaction.enabled) {
            return reasoningTracePayload ?? responsesPayload ?? imageDetailPayload;
        }
        const { rewriteProviderRequestWithNativeCompaction } = await loadCompactionModule();
        const compactionPayload = await rewriteProviderRequestWithNativeCompaction(
            requestPayload,
            ctx,
            config,
            pi,
        );
        return compactionPayload ?? reasoningTracePayload ?? responsesPayload ?? imageDetailPayload;
    });

    pi.on("session_shutdown", async (event, ctx) => {
        if (compactionModulePromise !== undefined) {
            const { cancelScheduledCodexAutoCompaction, clearCodexCompactionSessionState } =
                await compactionModulePromise;
            if (event.reason === "quit" || event.reason === "reload") {
                cancelScheduledCodexAutoCompaction();
            } else {
                clearCodexCompactionSessionState(ctx.sessionManager.getSessionId());
            }
        }
        await shutdownCodexTokenizer();
    });
}

function isActiveCodexResponsesModel(ctx: Parameters<typeof syncCodexCoreTools>[1]): boolean {
    return (
        ctx.model?.provider.trim().toLowerCase() === "openai-codex" &&
        String(ctx.model.api).toLowerCase().includes("responses")
    );
}

function isActiveGptResponsesModel(ctx: Parameters<typeof syncCodexCoreTools>[1]): boolean {
    return (
        ctx.model?.id.trim().toLowerCase().startsWith("gpt-") === true &&
        String(ctx.model.api).toLowerCase().includes("responses")
    );
}

export { formatCodexUsage, parseCodexUsagePayload } from "./codex/usage.ts";
export {
    parseCodexCoreConfig,
    readCodexCoreConfig,
    writeCodexCoreConfig,
} from "./config/config.ts";
