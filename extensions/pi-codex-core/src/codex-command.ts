import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Result } from "better-result";

import {
    formatCodexModelSelection,
    readCodexCoreConfig,
    type CodexCoreConfig,
    writeCodexCoreConfig,
} from "./config.ts";
import { openCodexSettingsScreen, type CodexSettingsSaveResult } from "./codex-settings-ui.ts";
import { consumeCodexRateLimitResetCredit, fetchCodexUsage, formatCodexUsage } from "./usage.ts";

type CodexCommandOptions = {
    readonly getConfig: () => CodexCoreConfig;
    readonly applyConfig: (config: CodexCoreConfig, ctx: ExtensionContext) => void;
};

const CODEX_COMMAND_COMPLETIONS = [
    "status",
    "usage",
    "web",
    "imagegen",
    "view",
    "descriptions",
    "tools",
    "prompt",
    "compact",
    "autocompact",
    "fast",
    "verbosity",
] as const;

export function registerCodexCommand(pi: ExtensionAPI, options: CodexCommandOptions): void {
    pi.registerCommand("codex", {
        description: "Configure Pi Codex Core tools, prompt, compaction, usage, and resets",
        getArgumentCompletions: (prefix) =>
            CODEX_COMMAND_COMPLETIONS.filter((item) =>
                item.startsWith(prefix.trim().toLowerCase()),
            ).map((value) => ({ label: value, value })),
        handler: async (args, ctx) => {
            const command = args.trim().toLowerCase();
            if (!command) {
                await openCodexMenu(ctx, options);
                return;
            }

            if (command === "status") {
                notify(ctx, formatConfig(options.getConfig()), "info");
                return;
            }
            if (command === "usage") {
                await openUsage(ctx, options);
                return;
            }
            const nextConfig = applyCommand(command, options.getConfig());
            if (!nextConfig) {
                notify(
                    ctx,
                    "Usage: /codex, /codex status|usage|web|imagegen|view|descriptions|tools|prompt|compact|autocompact|fast|verbosity",
                    "warning",
                );
                return;
            }
            saveAndApply(nextConfig, ctx, options);
        },
    });
}

async function openCodexMenu(ctx: ExtensionContext, options: CodexCommandOptions): Promise<void> {
    if (!ctx.hasUI) {
        notify(ctx, formatConfig(options.getConfig()), "info");
        return;
    }

    await openCodexSettingsScreen(ctx, {
        initialConfig: options.getConfig(),
        onChange: (config) => saveAndApply(config, ctx, options),
        onConsumeResetCredit: (redeemRequestId) =>
            consumeCodexRateLimitResetCredit(ctx, redeemRequestId),
    });
}

function applyCommand(command: string, config: CodexCoreConfig): CodexCoreConfig | undefined {
    if (command === "web")
        return { ...config, tools: { ...config.tools, webSearch: !config.tools.webSearch } };
    if (command === "imagegen")
        return {
            ...config,
            tools: { ...config.tools, imageGeneration: !config.tools.imageGeneration },
        };
    if (command === "view")
        return { ...config, tools: { ...config.tools, viewImage: !config.tools.viewImage } };
    if (command === "descriptions") {
        return {
            ...config,
            tools: { ...config.tools, viewImageDescriptions: !config.tools.viewImageDescriptions },
        };
    }
    if (command === "tools")
        return { ...config, scope: { tools: config.scope.tools === "codex" ? "all" : "codex" } };
    if (command === "prompt")
        return { ...config, prompt: { mode: config.prompt.mode === "pi" ? "codex" : "pi" } };
    if (command === "compact") {
        return {
            ...config,
            compaction: { ...config.compaction, enabled: !config.compaction.enabled },
        };
    }
    if (command === "autocompact") {
        return { ...config, compaction: { ...config.compaction, auto: !config.compaction.auto } };
    }
    if (command === "fast")
        return { ...config, openai: { ...config.openai, fast: !config.openai.fast } };
    if (command === "verbosity")
        return {
            ...config,
            openai: { ...config.openai, verbosity: nextVerbosity(config.openai.verbosity) },
        };
    return undefined;
}

async function openUsage(ctx: ExtensionContext, options: CodexCommandOptions): Promise<void> {
    if (!ctx.hasUI) {
        await showUsage(ctx);
        return;
    }

    const initialUsageResult = await fetchCodexUsage(ctx);
    const initialUsage = Result.isOk(initialUsageResult)
        ? initialUsageResult.value
        : { error: initialUsageResult.error.message };

    await openCodexSettingsScreen(ctx, {
        initialConfig: options.getConfig(),
        initialTab: "usage",
        initialUsage,
        onChange: (config) => saveAndApply(config, ctx, options),
        onConsumeResetCredit: (redeemRequestId) =>
            consumeCodexRateLimitResetCredit(ctx, redeemRequestId),
    });
}

async function showUsage(ctx: ExtensionContext): Promise<void> {
    const result = await fetchCodexUsage(ctx);
    if (Result.isOk(result)) {
        notify(ctx, formatCodexUsage(result.value), "info");
        return;
    }
    notify(ctx, result.error.message, "error");
}

function saveAndApply(
    config: CodexCoreConfig,
    ctx: ExtensionContext,
    options: CodexCommandOptions,
): CodexSettingsSaveResult {
    const globalConfig = readCodexCoreConfig();
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
    notify(ctx, formatConfig(effectiveConfig), "info");
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
        },
        prompt: {
            mode: changedValue(
                globalConfig.prompt.mode,
                previousEffectiveConfig.prompt.mode,
                nextEffectiveConfig.prompt.mode,
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

function formatConfig(config: CodexCoreConfig): string {
    return [
        "Pi Codex Core:",
        `- web_run: ${onOff(config.tools.webSearch)} (model ${formatCodexModelSelection(config.openai.webSearchModel)})`,
        `- imagegen: ${onOff(config.tools.imageGeneration)}`,
        `- view_image: ${onOff(config.tools.viewImage)}${config.tools.viewImageDescriptions ? " + descriptions" : ""}`,
        `- tool scope: ${config.scope.tools}`,
        `- prompt mode: ${config.prompt.mode}`,
        `- native compaction: ${onOff(config.compaction.enabled)} (model ${formatCodexModelSelection(config.openai.compactionModel)}, reasoning ${config.openai.compactionReasoning}, auto ${onOff(config.compaction.auto)} at ${config.compaction.thresholdPercent}%)`,
        `- fast: ${onOff(config.openai.fast)}, verbosity: ${config.openai.verbosity}`,
    ].join("\n");
}

function nextVerbosity(
    value: CodexCoreConfig["openai"]["verbosity"],
): CodexCoreConfig["openai"]["verbosity"] {
    if (value === "low") return "medium";
    if (value === "medium") return "high";
    return "low";
}

function onOff(value: boolean): "on" | "off" {
    return value ? "on" : "off";
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
