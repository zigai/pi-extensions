import {
    getSettingsListTheme,
    type ExtensionContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth, type SettingItem } from "@earendil-works/pi-tui";
import { Result, type Result as ResultType } from "better-result";

import type { CodexFailure } from "./failures.ts";

import {
    CODEX_APPLY_PATCH_MODES,
    CODEX_CURRENT_MODEL_SELECTION,
    type CodexCoreConfig,
} from "./config.ts";
import {
    consumeCodexRateLimitResetCredit,
    createCodexRateLimitResetRedeemRequestId,
    fetchCodexUsage,
    formatCodexUsage,
    formatResetConsumeResult,
    type CodexRateLimitResetConsumeResult,
    type CodexUsageSnapshot,
} from "./usage.ts";

export type CodexSettingsTab = "general" | "tools" | "openai" | "usage";

export type CodexSettingsSaveResult =
    | { readonly ok: true; readonly effectiveConfig: CodexCoreConfig }
    | { readonly ok: false };

export type CodexSettingsScreenOptions = {
    readonly initialConfig: CodexCoreConfig;
    readonly initialTab?: CodexSettingsTab | undefined;
    readonly initialUsage?: CodexUsageSnapshot | { readonly error: string } | undefined;
    readonly onChange: (config: CodexCoreConfig) => CodexSettingsSaveResult;
    readonly onConsumeResetCredit?: (
        redeemRequestId: string,
    ) => Promise<ResultType<CodexRateLimitResetConsumeResult, CodexFailure>>;
};

const TAB_ORDER: readonly CodexSettingsTab[] = ["general", "tools", "openai", "usage"];

export async function openCodexSettingsScreen(
    ctx: ExtensionContext,
    options: CodexSettingsScreenOptions,
): Promise<void> {
    let draft = options.initialConfig;
    let activeTab: CodexSettingsTab = options.initialTab ?? "general";
    let usageState = options.initialUsage;
    let usageLoading = false;
    let resetLoading = false;
    let pendingResetConfirm = false;
    let resetMessage: { readonly kind: "info" | "error"; readonly text: string } | undefined;

    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const loadUsage = (): void => {
            if (usageLoading) return;
            usageLoading = true;
            resetMessage = undefined;
            tui.requestRender();
            fetchCodexUsage(ctx)
                .then((usage) => {
                    usageState = Result.isOk(usage) ? usage.value : { error: usage.error.message };
                })
                .catch((cause: unknown) => {
                    usageState = { error: cause instanceof Error ? cause.message : String(cause) };
                })
                .finally(() => {
                    usageLoading = false;
                    settingsList = createSettingsList();
                    tui.requestRender();
                });
        };

        const consumeResetCredit = (): void => {
            if (resetLoading) return;
            if (!canConsumeResetCredit(usageState)) {
                resetMessage = { kind: "info", text: "No banked Codex resets are available." };
                pendingResetConfirm = false;
                tui.requestRender();
                return;
            }
            resetLoading = true;
            pendingResetConfirm = false;
            resetMessage = undefined;
            usageState = undefined;
            tui.requestRender();
            const redeemRequestId = createCodexRateLimitResetRedeemRequestId();
            (options.onConsumeResetCredit ?? ((id) => consumeCodexRateLimitResetCredit(ctx, id)))(
                redeemRequestId,
            )
                .then((result) => {
                    if (Result.isError(result)) {
                        resetMessage = { kind: "error", text: result.error.message };
                        return;
                    }
                    resetMessage = {
                        kind:
                            result.value.outcome === "reset" ||
                            result.value.outcome === "already_redeemed"
                                ? "info"
                                : "error",
                        text: formatResetConsumeResult(result.value),
                    };
                })
                .catch((cause: unknown) => {
                    resetMessage = {
                        kind: "error",
                        text: cause instanceof Error ? cause.message : String(cause),
                    };
                })
                .finally(() => {
                    resetLoading = false;
                    loadUsage();
                });
        };

        const createSettingsList = (): SettingsList =>
            new SettingsList(
                buildItems(activeTab, draft, usageState, usageLoading, resetLoading),
                10,
                getSettingsListTheme(),
                (id, value) => {
                    if (id === "refreshUsage") {
                        loadUsage();
                        return;
                    }
                    if (id === "useReset") {
                        if (!canConsumeResetCredit(usageState)) {
                            resetMessage = {
                                kind: "info",
                                text: "No banked Codex resets are available.",
                            };
                        } else {
                            pendingResetConfirm = true;
                            resetMessage = undefined;
                        }
                        tui.requestRender();
                        return;
                    }
                    const nextDraft = applySettingChange(id, value, draft);
                    if (nextDraft === draft) return;
                    const saveResult = options.onChange(nextDraft);
                    if (saveResult.ok) draft = saveResult.effectiveConfig;
                    settingsList = createSettingsList();
                    tui.requestRender();
                },
                () => done(undefined),
            );

        let settingsList = createSettingsList();
        if (activeTab === "usage" && !usageState) loadUsage();

        const switchTab = (): void => {
            const currentIndex = TAB_ORDER.indexOf(activeTab);
            activeTab = TAB_ORDER[(currentIndex + 1) % TAB_ORDER.length] ?? "general";
            pendingResetConfirm = false;
            settingsList = createSettingsList();
            if (activeTab === "usage" && !usageState) loadUsage();
            tui.requestRender();
        };

        return {
            render(width: number): string[] {
                const body = [
                    rule(width, theme, "accent"),
                    formatTabs(activeTab, theme),
                    rule(width, theme, "borderMuted"),
                    ...formatHeaderLines(activeTab, draft, theme),
                    ...(activeTab === "usage"
                        ? formatUsageLines(
                              theme,
                              usageState,
                              usageLoading,
                              resetLoading,
                              pendingResetConfirm,
                              resetMessage,
                          )
                        : []),
                    ...settingsList.render(width),
                    rule(width, theme, "accent"),
                ];
                return body.map((line) => truncateToWidth(line, width, ""));
            },
            invalidate(): void {
                settingsList.invalidate();
            },
            handleInput(data: string): void {
                if (pendingResetConfirm) {
                    const lowered = data.toLowerCase();
                    if (lowered === "y") {
                        consumeResetCredit();
                        return;
                    }
                    if (lowered === "n" || data === "\x1b") {
                        pendingResetConfirm = false;
                        resetMessage = { kind: "info", text: "Codex reset cancelled." };
                        tui.requestRender();
                        return;
                    }
                }
                if (data === "\t") {
                    switchTab();
                    return;
                }
                settingsList.handleInput(data);
                tui.requestRender();
            },
        };
    });
}

function buildItems(
    tab: CodexSettingsTab,
    config: CodexCoreConfig,
    usageState: CodexUsageSnapshot | { readonly error: string } | undefined,
    usageLoading: boolean,
    resetLoading: boolean,
): SettingItem[] {
    if (tab === "general") {
        return [
            {
                id: "toolScope",
                label: "Tool scope",
                description: "Expose Codex extras only on Codex-like models, or on all models.",
                currentValue: config.scope.tools,
                values: ["codex", "all"],
            },
            {
                id: "promptMode",
                label: "Prompt mode",
                description: "Use Pi's normal prompt or the bundled Codex-style base prompt.",
                currentValue: config.prompt.mode,
                values: ["pi", "codex"],
            },
            {
                id: "nativeCompaction",
                label: "Native compaction",
                description: "Use OpenAI Codex responses compaction checkpoints when available.",
                currentValue: config.compaction.enabled ? "on" : "off",
                values: ["off", "on"],
            },
            {
                id: "autoCompaction",
                label: "Native auto compaction",
                description: "Automatically run native Codex compaction between turns.",
                currentValue: config.compaction.auto ? "on" : "off",
                values: ["off", "on"],
            },
            {
                id: "autoThreshold",
                label: "Auto compaction threshold",
                description: "Context usage percentage that triggers native auto-compaction.",
                currentValue: String(config.compaction.thresholdPercent),
                values: ["80", "85", "90", "95"],
            },
        ];
    }

    if (tab === "tools") {
        return [
            toggleItem(
                "webSearch",
                "Web search",
                "Codex web.run / web_run search tool.",
                config.tools.webSearch,
            ),
            toggleItem(
                "imageGeneration",
                "Image generation",
                "Generate or edit images through Codex image APIs.",
                config.tools.imageGeneration,
            ),
            toggleItem(
                "viewImage",
                "View image",
                "Return local images to image-capable models.",
                config.tools.viewImage,
            ),
            toggleItem(
                "imageDescriptions",
                "Image descriptions",
                "Fallback image descriptions for text-only models.",
                config.tools.viewImageDescriptions,
            ),
            {
                id: "applyPatch",
                label: "Apply patch",
                description:
                    "Use apply_patch instead of edit: off, OpenAI/Codex-like models, or all models.",
                currentValue: config.tools.applyPatch,
                values: [...CODEX_APPLY_PATCH_MODES],
            },
        ];
    }

    if (tab === "openai") {
        return [
            toggleItem(
                "fast",
                "Fast mode",
                "Request priority service tier for supported Codex calls.",
                config.openai.fast,
            ),
            {
                id: "verbosity",
                label: "Verbosity",
                description: "Text verbosity for Codex-native calls that support it.",
                currentValue: config.openai.verbosity,
                values: ["low", "medium", "high"],
            },
            selectItem("webSearchModel", "Web search model", config.openai.webSearchModel, [
                CODEX_CURRENT_MODEL_SELECTION,
                "gpt-5.5",
                "gpt-5.4",
                "gpt-5.4-mini",
            ]),
            selectItem("imageModel", "Image model", config.openai.imageModel, [
                "gpt-image-2",
                "gpt-image-1.5",
            ]),
            selectItem(
                "imageDescriptionModel",
                "Image description model",
                config.openai.imageDescriptionModel,
                [CODEX_CURRENT_MODEL_SELECTION, "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
            ),
            selectItem("compactionModel", "Compaction model", config.openai.compactionModel, [
                CODEX_CURRENT_MODEL_SELECTION,
                "gpt-5.5",
                "gpt-5.4",
                "gpt-5.4-mini",
            ]),
            {
                id: "compactionReasoning",
                label: "Compaction reasoning",
                description: "Reasoning effort for native compaction calls.",
                currentValue: config.openai.compactionReasoning,
                values: ["current", "minimal", "low", "medium", "high", "xhigh"],
            },
        ];
    }

    if (tab === "usage") {
        const canReset = canConsumeResetCredit(usageState);
        return [
            {
                id: "refreshUsage",
                label: "Refresh usage",
                description: "Fetch current Codex usage and banked reset credits.",
                currentValue: usageLoading ? "loading" : "refresh",
                values: [usageLoading ? "loading" : "refresh"],
            },
            {
                id: "useReset",
                label: "Use reset credit",
                description: "Spend one banked reset credit after an in-screen confirmation.",
                currentValue: resetLoading ? "resetting" : canReset ? "confirm..." : "unavailable",
                values: [resetLoading ? "resetting" : canReset ? "confirm..." : "unavailable"],
            },
        ];
    }

    return [];
}

function applySettingChange(id: string, value: string, config: CodexCoreConfig): CodexCoreConfig {
    if (id === "toolScope")
        return { ...config, scope: { tools: value === "all" ? "all" : "codex" } };
    if (id === "promptMode")
        return { ...config, prompt: { mode: value === "codex" ? "codex" : "pi" } };
    if (id === "nativeCompaction") {
        return { ...config, compaction: { ...config.compaction, enabled: value === "on" } };
    }
    if (id === "autoCompaction") {
        return { ...config, compaction: { ...config.compaction, auto: value === "on" } };
    }
    if (id === "autoThreshold") {
        const thresholdPercent = Number.parseInt(value, 10);
        return Number.isFinite(thresholdPercent)
            ? { ...config, compaction: { ...config.compaction, thresholdPercent } }
            : config;
    }
    if (id === "webSearch")
        return { ...config, tools: { ...config.tools, webSearch: value === "on" } };
    if (id === "imageGeneration")
        return { ...config, tools: { ...config.tools, imageGeneration: value === "on" } };
    if (id === "viewImage")
        return { ...config, tools: { ...config.tools, viewImage: value === "on" } };
    if (id === "imageDescriptions")
        return { ...config, tools: { ...config.tools, viewImageDescriptions: value === "on" } };
    if (id === "applyPatch" && (value === "off" || value === "openai" || value === "all"))
        return { ...config, tools: { ...config.tools, applyPatch: value } };
    if (id === "fast") return { ...config, openai: { ...config.openai, fast: value === "on" } };
    if (id === "verbosity" && (value === "low" || value === "medium" || value === "high")) {
        return { ...config, openai: { ...config.openai, verbosity: value } };
    }
    if (id === "webSearchModel")
        return { ...config, openai: { ...config.openai, webSearchModel: value } };
    if (id === "imageModel") return { ...config, openai: { ...config.openai, imageModel: value } };
    if (id === "imageDescriptionModel") {
        return { ...config, openai: { ...config.openai, imageDescriptionModel: value } };
    }
    if (id === "compactionModel")
        return { ...config, openai: { ...config.openai, compactionModel: value } };
    if (
        id === "compactionReasoning" &&
        (value === "current" ||
            value === "minimal" ||
            value === "low" ||
            value === "medium" ||
            value === "high" ||
            value === "xhigh")
    ) {
        return { ...config, openai: { ...config.openai, compactionReasoning: value } };
    }
    return config;
}

function toggleItem(id: string, label: string, description: string, enabled: boolean): SettingItem {
    return { id, label, description, currentValue: enabled ? "on" : "off", values: ["off", "on"] };
}

function selectItem(
    id: string,
    label: string,
    currentValue: string,
    values: readonly string[],
): SettingItem {
    return {
        id,
        label,
        currentValue,
        values: values.includes(currentValue) ? [...values] : [currentValue, ...values],
    };
}

function formatHeaderLines(tab: CodexSettingsTab, config: CodexCoreConfig, theme: Theme): string[] {
    if (tab !== "general") return [""];
    return [
        `  ${theme.bold("Pi Codex Core")}: tools ${config.scope.tools}, prompt ${config.prompt.mode}, compaction ${config.compaction.enabled ? "on" : "off"}`,
        "",
    ];
}

function formatUsageLines(
    theme: Theme,
    usageState: CodexUsageSnapshot | { readonly error: string } | undefined,
    usageLoading: boolean,
    resetLoading: boolean,
    pendingResetConfirm: boolean,
    resetMessage: { readonly kind: "info" | "error"; readonly text: string } | undefined,
): string[] {
    const lines: string[] = [];
    if (usageLoading && !usageState) lines.push(theme.fg("dim", "  Loading Codex usage..."));
    else if (!usageState) lines.push(theme.fg("dim", "  Usage has not been loaded yet."));
    else if ("error" in usageState) lines.push(theme.fg("error", `  ${usageState.error}`));
    else
        lines.push(
            ...formatCodexUsage(usageState)
                .split("\n")
                .map((line) => `  ${line}`),
        );

    if (pendingResetConfirm) {
        lines.push("");
        lines.push(
            theme.fg(
                "warning",
                "  Confirm reset spending: press Y to use one banked reset, or N/Esc to cancel.",
            ),
        );
    }
    if (resetLoading) lines.push(theme.fg("dim", "  Applying reset..."));
    if (resetMessage) {
        lines.push(
            resetMessage.kind === "error"
                ? theme.fg("error", `  ${resetMessage.text}`)
                : theme.fg("dim", `  ${resetMessage.text}`),
        );
    }
    lines.push("");
    return lines;
}

function canConsumeResetCredit(
    usageState: CodexUsageSnapshot | { readonly error: string } | undefined,
): boolean {
    return Boolean(
        usageState &&
        !("error" in usageState) &&
        (usageState.resetCredits?.availableCount ?? 0) > 0,
    );
}

function formatTabs(activeTab: CodexSettingsTab, theme: Theme): string {
    const renderTab = (tab: CodexSettingsTab, label: string): string =>
        activeTab === tab ? theme.bold(label) : theme.fg("dim", label);
    return `  ${renderTab("general", "General")}  ${theme.fg("dim", "/")}  ${renderTab("tools", "Tools")}  ${theme.fg("dim", "/")}  ${renderTab("openai", "OpenAI")}  ${theme.fg("dim", "/")}  ${renderTab("usage", "Usage")}`;
}

function rule(width: number, theme: Theme, color: "accent" | "borderMuted"): string {
    return theme.fg(color, "─".repeat(Math.max(0, width)));
}
