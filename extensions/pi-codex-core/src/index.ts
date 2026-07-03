import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { syncCodexCoreTools } from "./activation.ts";
import { registerCodexCommand } from "./codex-command.ts";
import { readCodexCoreConfig, type CodexCoreConfig } from "./config.ts";
import {
    cancelScheduledCodexAutoCompaction,
    handleCodexNativeCompaction,
    registerNativeCompactionDisplay,
    rewriteProviderRequestWithNativeCompaction,
    scheduleCodexAutoCompaction,
} from "./compaction.ts";
import { buildCodexCoreSystemPrompt } from "./prompt.ts";
import { registerImagegenTool } from "./tools/imagegen.ts";
import { registerViewImageTool } from "./tools/view-image.ts";
import { registerWebRunTool } from "./tools/web-run.ts";

/** Package display name used in user-visible extension messages. */
export const extensionName = "Pi Codex Core";

/** Generated npm package name. */
export const packageName = "pi-codex-core";

/** Register the Pi Codex Core Pi extension. */
export default function extension(pi: ExtensionAPI): void {
    let config: CodexCoreConfig = readCodexCoreConfig();

    const getConfig = (): CodexCoreConfig => config;
    const applyConfig = (
        nextConfig: CodexCoreConfig,
        ctx: Parameters<typeof syncCodexCoreTools>[1],
    ): void => {
        config = nextConfig;
        syncCodexCoreTools(pi, ctx, config);
    };

    registerWebRunTool(pi, { getConfig });
    registerImagegenTool(pi, { getConfig });
    registerViewImageTool(pi, { getConfig });
    registerNativeCompactionDisplay(pi);
    registerCodexCommand(pi, { getConfig, applyConfig });

    pi.on("session_start", async (_event, ctx) => {
        config = readCodexCoreConfig({ cwd: ctx.cwd });
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
        return handleCodexNativeCompaction(event, ctx, config, pi);
    });

    pi.on("agent_end", async (_event, ctx) => {
        scheduleCodexAutoCompaction(ctx, config);
    });

    pi.on("before_provider_request", async (event, ctx) => {
        return rewriteProviderRequestWithNativeCompaction(event.payload, ctx, config, pi);
    });

    pi.on("session_shutdown", async () => {
        cancelScheduledCodexAutoCompaction();
    });
}

export { parseCodexCoreConfig, readCodexCoreConfig, writeCodexCoreConfig } from "./config.ts";
export { parseCodexUsagePayload, formatCodexUsage } from "./usage.ts";
