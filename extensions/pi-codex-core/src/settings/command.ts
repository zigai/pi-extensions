import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    readCodexCoreConfig,
    readCodexCoreConfigWithDiagnostics,
    type CodexCoreConfig,
    writeCodexCoreConfig,
} from "../config/config.ts";
import { openCodexSettingsScreen, type CodexSettingsSaveResult } from "./screen.ts";
import { consumeCodexRateLimitResetCredit } from "../codex/usage.ts";
import { getCodexCommandContributions, getCodexSettingsTabs } from "./integration.ts";

type CodexCommandOptions = {
    readonly getConfig: () => CodexCoreConfig;
    readonly applyConfig: (config: CodexCoreConfig, ctx: ExtensionContext) => void;
};

export function registerCodexCommand(pi: ExtensionAPI, options: CodexCommandOptions): void {
    pi.registerCommand("codex", {
        description: "Configure Pi Codex Core and installed Codex integrations",
        handler: async (args, ctx) => {
            const action = args.trim().toLowerCase();
            const tabs = getCodexSettingsTabs();
            if (action.length === 0) {
                await openCodexMenu(ctx, options, tabs);
                return;
            }
            const requestedTab = tabs.find(
                (tab) => tab.id === action || tab.aliases?.includes(action) === true,
            );
            if (requestedTab !== undefined) {
                await openCodexMenu(ctx, options, tabs, requestedTab.id);
                return;
            }
            const command = getCodexCommandContributions().find((contribution) =>
                contribution.commands.includes(action),
            );
            if (command !== undefined) {
                await command.handle(action, ctx);
                return;
            }
            const actions = [
                ...tabs.flatMap((tab) => tab.aliases ?? [tab.id]),
                ...getCodexCommandContributions().flatMap((contribution) => contribution.commands),
            ];
            notify(
                ctx,
                actions.length === 0
                    ? "Usage: /codex"
                    : `Usage: /codex [${[...new Set(actions)].join("|")}]`,
                "warning",
            );
        },
    });
}

async function openCodexMenu(
    ctx: ExtensionCommandContext,
    options: CodexCommandOptions,
    additionalTabs: ReturnType<typeof getCodexSettingsTabs>,
    initialTab?: string,
): Promise<void> {
    if (!ctx.hasUI) {
        notify(ctx, "/codex requires an interactive UI.", "warning");
        return;
    }

    const initialSettings = { initialConfig: options.getConfig(), additionalTabs };
    const onChange = (config: CodexCoreConfig) => saveAndApply(config, ctx, options);
    const onConsumeResetCredit = (redeemRequestId: string) =>
        consumeCodexRateLimitResetCredit(ctx, redeemRequestId);
    await openCodexSettingsScreen(
        ctx,
        initialTab === undefined
            ? { ...initialSettings, onChange, onConsumeResetCredit }
            : { ...initialSettings, initialTab, onChange, onConsumeResetCredit },
    );
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
            webSearchMode: changedValue(
                globalConfig.tools.webSearchMode,
                previousEffectiveConfig.tools.webSearchMode,
                nextEffectiveConfig.tools.webSearchMode,
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
        recovery: {
            enabled: changedValue(
                globalConfig.recovery.enabled,
                previousEffectiveConfig.recovery.enabled,
                nextEffectiveConfig.recovery.enabled,
            ),
            batchFollowUps: changedValue(
                globalConfig.recovery.batchFollowUps,
                previousEffectiveConfig.recovery.batchFollowUps,
                nextEffectiveConfig.recovery.batchFollowUps,
            ),
            maxAttempts: changedValue(
                globalConfig.recovery.maxAttempts,
                previousEffectiveConfig.recovery.maxAttempts,
                nextEffectiveConfig.recovery.maxAttempts,
            ),
            baseDelayMs: changedValue(
                globalConfig.recovery.baseDelayMs,
                previousEffectiveConfig.recovery.baseDelayMs,
                nextEffectiveConfig.recovery.baseDelayMs,
            ),
            maxDelayMs: changedValue(
                globalConfig.recovery.maxDelayMs,
                previousEffectiveConfig.recovery.maxDelayMs,
                nextEffectiveConfig.recovery.maxDelayMs,
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
