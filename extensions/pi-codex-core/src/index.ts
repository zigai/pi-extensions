import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { syncCodexCoreTools } from "./activation.ts";
import { registerCodexCommand } from "./codex-command.ts";
import { readCodexCoreConfig, type CodexCoreConfig } from "./config.ts";
import { registerNativeCompactionDisplay } from "./compaction-display.ts";
import { buildCodexCoreSystemPrompt } from "./prompt.ts";
import { registerApplyPatchTool } from "./tools/apply-patch.ts";
import { registerImagegenTool } from "./tools/imagegen.ts";
import { registerViewImageTool } from "./tools/view-image.ts";
import { registerWebRunTool } from "./tools/web-run.ts";
import { shutdownCodexTokenizer, warmCodexTokenizer } from "./tokenizer.ts";

/** Package display name used in user-visible extension messages. */
export const extensionName = "Pi Codex Core";

/** Generated npm package name. */
export const packageName = "pi-codex-core";

type CompactionModule = typeof import("./compaction.ts");

let compactionModulePromise: Promise<CompactionModule> | undefined;

function loadCompactionModule(): Promise<CompactionModule> {
    compactionModulePromise ??= import("./compaction.ts");
    return compactionModulePromise;
}

/** Register the Pi Codex Core Pi extension. */
export default function extension(pi: ExtensionAPI): void {
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
        syncCodexCoreTools(pi, ctx, config);
    });

    pi.on("model_select", async (_event, ctx) => {
        syncCodexCoreTools(pi, ctx, config);
    });

    pi.on("before_agent_start", async (event) => {
        return {
            systemPrompt: buildCodexCoreSystemPrompt(
                event.systemPrompt,
                config,
                event.systemPromptOptions,
            ),
        };
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
        if (!config.compaction.enabled) {
            return undefined;
        }
        const { rewriteProviderRequestWithNativeCompaction } = await loadCompactionModule();
        return rewriteProviderRequestWithNativeCompaction(event.payload, ctx, config, pi);
    });

    pi.on("session_shutdown", async () => {
        if (compactionModulePromise !== undefined) {
            const { cancelScheduledCodexAutoCompaction } = await compactionModulePromise;
            cancelScheduledCodexAutoCompaction();
        }
        await shutdownCodexTokenizer();
    });
}

export { parseCodexCoreConfig, readCodexCoreConfig, writeCodexCoreConfig } from "./config.ts";
export { parseCodexUsagePayload, formatCodexUsage } from "./usage.ts";
