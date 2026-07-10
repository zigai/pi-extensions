import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    readCodexCoreConfig,
    readCodexCoreConfigWithDiagnostics,
    type CodexCoreConfig,
    writeCodexCoreConfig,
} from "../config/config.ts";
import { openCodexSettingsScreen, type CodexSettingsSaveResult } from "./screen.ts";
import { consumeCodexRateLimitResetCredit } from "../codex/usage.ts";

type CodexCommandOptions = {
    readonly getConfig: () => CodexCoreConfig;
    readonly applyConfig: (config: CodexCoreConfig, ctx: ExtensionContext) => void;
};

export function registerCodexCommand(pi: ExtensionAPI, options: CodexCommandOptions): void {
    pi.registerCommand("codex", {
        description: "Configure Pi Codex Core tools, prompt, compaction, usage, and resets",
        handler: async (args, ctx) => {
            if (args.trim().length > 0) {
                notify(ctx, "Usage: /codex", "warning");
                return;
            }
            await openCodexMenu(ctx, options);
        },
    });
}

async function openCodexMenu(ctx: ExtensionContext, options: CodexCommandOptions): Promise<void> {
    if (!ctx.hasUI) {
        notify(ctx, "/codex requires an interactive UI.", "warning");
        return;
    }

    await openCodexSettingsScreen(ctx, {
        initialConfig: options.getConfig(),
        onChange: (config) => saveAndApply(config, ctx, options),
        onConsumeResetCredit: (redeemRequestId) =>
            consumeCodexRateLimitResetCredit(ctx, redeemRequestId),
    });
}

function saveAndApply(
    config: CodexCoreConfig,
    ctx: ExtensionContext,
    options: CodexCommandOptions,
): CodexSettingsSaveResult {
    const globalRead = readCodexCoreConfigWithDiagnostics();
    const unsafeDiagnostic = globalRead.diagnostics.find(
        (diagnostic) =>
            diagnostic.reason === "malformed-json" || diagnostic.reason === "unreadable",
    );
    if (unsafeDiagnostic) {
        notify(
            ctx,
            `Codex settings were not saved because ${unsafeDiagnostic.path} is ${unsafeDiagnostic.reason === "malformed-json" ? "malformed" : "unreadable"}.`,
            "error",
        );
        return { ok: false };
    }
    const globalConfig = globalRead.config;
    const configToPersist = applyChangedConfigValues(globalConfig, options.getConfig(), config);
    const result = writeCodexCoreConfig(configToPersist);
    if (!result.ok) {
        notify(ctx, `Failed to save Codex settings: ${result.error}`, "error");
        return { ok: false };
    }
    const effectiveConfig = ctx.isProjectTrusted()
        ? readCodexCoreConfig({ cwd: ctx.cwd })
        : readCodexCoreConfig();
    options.applyConfig(effectiveConfig, ctx);
    notify(ctx, "Codex settings saved.", "info");
    return { ok: true, effectiveConfig };
}

function applyChangedConfigValues(
    globalConfig: CodexCoreConfig,
    previousEffectiveConfig: CodexCoreConfig,
    nextEffectiveConfig: CodexCoreConfig,
): CodexCoreConfig {
    return {
        scope: {
            tools: changedValue(
                globalConfig.scope.tools,
                previousEffectiveConfig.scope.tools,
                nextEffectiveConfig.scope.tools,
            ),
        },
        tools: {
            webSearch: changedValue(
                globalConfig.tools.webSearch,
                previousEffectiveConfig.tools.webSearch,
                nextEffectiveConfig.tools.webSearch,
            ),
            imageGeneration: changedValue(
                globalConfig.tools.imageGeneration,
                previousEffectiveConfig.tools.imageGeneration,
                nextEffectiveConfig.tools.imageGeneration,
            ),
            viewImage: changedValue(
                globalConfig.tools.viewImage,
                previousEffectiveConfig.tools.viewImage,
                nextEffectiveConfig.tools.viewImage,
            ),
            viewImageDescriptions: changedValue(
                globalConfig.tools.viewImageDescriptions,
                previousEffectiveConfig.tools.viewImageDescriptions,
                nextEffectiveConfig.tools.viewImageDescriptions,
            ),
            applyPatch: changedValue(
                globalConfig.tools.applyPatch,
                previousEffectiveConfig.tools.applyPatch,
                nextEffectiveConfig.tools.applyPatch,
            ),
        },
        prompt: {
            mode: changedValue(
                globalConfig.prompt.mode,
                previousEffectiveConfig.prompt.mode,
                nextEffectiveConfig.prompt.mode,
            ),
            personality: changedValue(
                globalConfig.prompt.personality,
                previousEffectiveConfig.prompt.personality,
                nextEffectiveConfig.prompt.personality,
            ),
        },
        compaction: {
            enabled: changedValue(
                globalConfig.compaction.enabled,
                previousEffectiveConfig.compaction.enabled,
                nextEffectiveConfig.compaction.enabled,
            ),
            auto: changedValue(
                globalConfig.compaction.auto,
                previousEffectiveConfig.compaction.auto,
                nextEffectiveConfig.compaction.auto,
            ),
            thresholdPercent: changedValue(
                globalConfig.compaction.thresholdPercent,
                previousEffectiveConfig.compaction.thresholdPercent,
                nextEffectiveConfig.compaction.thresholdPercent,
            ),
        },
        openai: {
            webSearchModel: changedValue(
                globalConfig.openai.webSearchModel,
                previousEffectiveConfig.openai.webSearchModel,
                nextEffectiveConfig.openai.webSearchModel,
            ),
            imageModel: changedValue(
                globalConfig.openai.imageModel,
                previousEffectiveConfig.openai.imageModel,
                nextEffectiveConfig.openai.imageModel,
            ),
            imageDescriptionModel: changedValue(
                globalConfig.openai.imageDescriptionModel,
                previousEffectiveConfig.openai.imageDescriptionModel,
                nextEffectiveConfig.openai.imageDescriptionModel,
            ),
            compactionModel: changedValue(
                globalConfig.openai.compactionModel,
                previousEffectiveConfig.openai.compactionModel,
                nextEffectiveConfig.openai.compactionModel,
            ),
            compactionReasoning: changedValue(
                globalConfig.openai.compactionReasoning,
                previousEffectiveConfig.openai.compactionReasoning,
                nextEffectiveConfig.openai.compactionReasoning,
            ),
            verbosity: changedValue(
                globalConfig.openai.verbosity,
                previousEffectiveConfig.openai.verbosity,
                nextEffectiveConfig.openai.verbosity,
            ),
            fast: changedValue(
                globalConfig.openai.fast,
                previousEffectiveConfig.openai.fast,
                nextEffectiveConfig.openai.fast,
            ),
            showReasoningTraces: changedValue(
                globalConfig.openai.showReasoningTraces,
                previousEffectiveConfig.openai.showReasoningTraces,
                nextEffectiveConfig.openai.showReasoningTraces,
            ),
        },
    };
}

function changedValue<TValue>(
    globalValue: TValue,
    previousEffectiveValue: TValue,
    nextEffectiveValue: TValue,
): TValue {
    return Object.is(previousEffectiveValue, nextEffectiveValue) ? globalValue : nextEffectiveValue;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
    if (ctx.hasUI) {
        ctx.ui.notify(message, type);
        return;
    }
    if (type === "error") console.error(message);
    else if (type === "warning") console.warn(message);
    else console.log(message);
}
