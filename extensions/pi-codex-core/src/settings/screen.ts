import {
    getSettingsListTheme,
    type ExtensionContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth, type SettingItem } from "@earendil-works/pi-tui";
import { Result, type Result as ResultType } from "better-result";

import type { CodexFailure } from "../codex/failures.ts";

import {
    CODEX_APPLY_PATCH_MODES,
    CODEX_COMPACTION_REASONING_LEVELS,
    CODEX_CURRENT_MODEL_SELECTION,
    CODEX_PERSONALITIES,
    CODEX_WEB_SEARCH_MODES,
    type CodexCoreConfig,
} from "../config/config.ts";
import { CODEX_TEXT_MODEL_CHOICES } from "../codex/models.ts";
import { supportsCodexPromptPersonality } from "../prompt/personality.ts";
import {
    consumeCodexRateLimitResetCredit,
    createCodexRateLimitResetRedeemRequestId,
    fetchCodexUsage,
    formatCodexUsage,
    formatResetConsumeResult,
    type CodexRateLimitResetConsumeResult,
    type CodexUsageSnapshot,
} from "../codex/usage.ts";

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
        options?: { readonly signal?: AbortSignal | undefined },
    ) => Promise<ResultType<CodexRateLimitResetConsumeResult, CodexFailure>>;
};

const TAB_ORDER: readonly CodexSettingsTab[] = ["general", "tools", "openai", "usage"];
type DescribedSettingItem = SettingItem & { readonly description: string };

export async function openCodexSettingsScreen(
    ctx: ExtensionContext,
    options: CodexSettingsScreenOptions,
): Promise<void> {
    const tasks = new SettingsScreenTaskOwner();
    let draft = options.initialConfig;
    let activeTab: CodexSettingsTab = options.initialTab ?? "general";
    let usageState = options.initialUsage;
    let usageLoading = false;
    let resetLoading = false;
    let pendingResetConfirm = false;
    let resetMessage: { readonly kind: "info" | "error"; readonly text: string } | undefined;
    const personalitySupported = supportsCodexPromptPersonality(ctx.model?.id);

    try {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
            const loadUsage = (): void => {
                if (usageLoading || tasks.signal.aborted) return;
                usageLoading = true;
                resetMessage = undefined;
                tui.requestRender();
                tasks.start(async (signal) => {
                    try {
                        signal.throwIfAborted();
                        const usage = await fetchCodexUsage(ctx, { signal });
                        signal.throwIfAborted();
                        if (signal.aborted) return;
                        usageState = Result.isOk(usage)
                            ? usage.value
                            : { error: usage.error.message };
                    } catch (cause: unknown) {
                        if (signal.aborted) return;
                        usageState = {
                            error: cause instanceof Error ? cause.message : String(cause),
                        };
                    } finally {
                        if (!signal.aborted) {
                            usageLoading = false;
                            settingsList = createSettingsList();
                            tui.requestRender();
                        }
                    }
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
                tasks.start(async (signal) => {
                    try {
                        const result = await (
                            options.onConsumeResetCredit ??
                            (async (id, consumeOptions) => {
                                consumeOptions?.signal?.throwIfAborted();
                                const result = await consumeCodexRateLimitResetCredit(ctx, id, {
                                    signal: consumeOptions?.signal,
                                });
                                consumeOptions?.signal?.throwIfAborted();
                                return result;
                            })
                        )(redeemRequestId, { signal });
                        if (signal.aborted) return;
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
                    } catch (cause: unknown) {
                        if (signal.aborted) return;
                        resetMessage = {
                            kind: "error",
                            text: cause instanceof Error ? cause.message : String(cause),
                        };
                    } finally {
                        if (!signal.aborted) {
                            resetLoading = false;
                            loadUsage();
                        }
                    }
                });
            };

            const createSettingsList = (): SettingsList =>
                new SettingsList(
                    buildItems(
                        activeTab,
                        draft,
                        usageState,
                        usageLoading,
                        resetLoading,
                        personalitySupported,
                    ),
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
                        for (const item of buildItems(
                            activeTab,
                            draft,
                            usageState,
                            usageLoading,
                            resetLoading,
                            personalitySupported,
                        )) {
                            settingsList.updateValue(item.id, item.currentValue);
                        }
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
                        ...formatHeaderLines(activeTab, draft, theme, personalitySupported),
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
    } finally {
        await tasks.dispose();
    }
}

class SettingsScreenTaskOwner {
    readonly #controller = new AbortController();
    readonly #tasks = new Set<Promise<void>>();

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    start(task: (signal: AbortSignal) => Promise<void>): void {
        if (this.signal.aborted) return;
        const ownedTask = (async () => {
            try {
                await task(this.signal);
            } catch {
                // Each task handles its own expected rejection before returning to this owner.
            }
        })();
        this.#tasks.add(ownedTask);
    }

    async dispose(): Promise<void> {
        this.#controller.abort();
        await Promise.allSettled(this.#tasks);
        this.#tasks.clear();
    }
}

function buildItems(
    tab: CodexSettingsTab,
    config: CodexCoreConfig,
    usageState: CodexUsageSnapshot | { readonly error: string } | undefined,
    usageLoading: boolean,
    resetLoading: boolean,
    personalitySupported: boolean,
): DescribedSettingItem[] {
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
                description: "Use Pi's prompt or the active GPT model's bundled Codex prompt.",
                currentValue: config.prompt.mode,
                values: ["pi", "codex"],
            },
            ...(personalitySupported
                ? [
                      {
                          id: "personality",
                          label: "Personality",
                          description:
                              "Set the Codex communication style; none disables personality instructions.",
                          currentValue: config.prompt.personality,
                          values: [...CODEX_PERSONALITIES],
                      },
                  ]
                : []),
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
            {
                id: "webSearchMode",
                label: "Web search mode",
                description:
                    "Use cached, indexed, or live results for standalone web_run searches.",
                currentValue: config.tools.webSearchMode,
                values: [...CODEX_WEB_SEARCH_MODES],
            },
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
                "Up to 1.5× faster token velocity; credit usage is higher and varies by model and pricing.",
                config.openai.fast,
            ),
            toggleItem(
                "reasoningTraces",
                "GPT reasoning traces",
                "Show streamed reasoning summaries for GPT Responses models.",
                config.openai.showReasoningTraces,
            ),
            {
                id: "verbosity",
                label: "Verbosity",
                description: "Text verbosity for Codex-native calls that support it.",
                currentValue: config.openai.verbosity,
                values: ["low", "medium", "high"],
            },
            selectItem(
                "webSearchModel",
                "Web search model",
                "Model used by web_run; current follows the active Codex model.",
                config.openai.webSearchModel,
                [CODEX_CURRENT_MODEL_SELECTION, ...CODEX_TEXT_MODEL_CHOICES],
            ),
            selectItem(
                "imageModel",
                "Image model",
                "OpenAI image model used by imagegen generation and editing.",
                config.openai.imageModel,
                ["gpt-image-2", "gpt-image-1.5"],
            ),
            selectItem(
                "imageDescriptionModel",
                "Image description model",
                "Model used for optional image descriptions; current follows the active Codex model.",
                config.openai.imageDescriptionModel,
                [CODEX_CURRENT_MODEL_SELECTION, ...CODEX_TEXT_MODEL_CHOICES],
            ),
            selectItem(
                "compactionModel",
                "Compaction model",
                "Model used for native Codex compaction; current follows the active Codex model.",
                config.openai.compactionModel,
                [CODEX_CURRENT_MODEL_SELECTION, ...CODEX_TEXT_MODEL_CHOICES],
            ),
            {
                id: "compactionReasoning",
                label: "Compaction reasoning",
                description: "Reasoning effort for native compaction calls.",
                currentValue: config.openai.compactionReasoning,
                values: [...CODEX_COMPACTION_REASONING_LEVELS],
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
        return {
            ...config,
            prompt: { ...config.prompt, mode: value === "codex" ? "codex" : "pi" },
        };
    if (id === "personality") {
        const personality = CODEX_PERSONALITIES.find((item) => item === value);
        if (!personality) return config;
        return {
            ...config,
            prompt: {
                ...config.prompt,
                personality,
            },
        };
    }
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
    if (id === "webSearchMode") {
        const webSearchMode = CODEX_WEB_SEARCH_MODES.find((mode) => mode === value);
        return webSearchMode ? { ...config, tools: { ...config.tools, webSearchMode } } : config;
    }
    if (id === "imageGeneration")
        return { ...config, tools: { ...config.tools, imageGeneration: value === "on" } };
    if (id === "viewImage")
        return { ...config, tools: { ...config.tools, viewImage: value === "on" } };
    if (id === "imageDescriptions")
        return { ...config, tools: { ...config.tools, viewImageDescriptions: value === "on" } };
    if (id === "applyPatch" && (value === "off" || value === "openai" || value === "all"))
        return { ...config, tools: { ...config.tools, applyPatch: value } };
    if (id === "fast") return { ...config, openai: { ...config.openai, fast: value === "on" } };
    if (id === "reasoningTraces") {
        return {
            ...config,
            openai: { ...config.openai, showReasoningTraces: value === "on" },
        };
    }
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
    if (id === "compactionReasoning" && value.trim().length > 0) {
        return { ...config, openai: { ...config.openai, compactionReasoning: value } };
    }
    return config;
}

function toggleItem(
    id: string,
    label: string,
    description: string,
    enabled: boolean,
): DescribedSettingItem {
    return { id, label, description, currentValue: enabled ? "on" : "off", values: ["off", "on"] };
}

function selectItem(
    id: string,
    label: string,
    description: string,
    currentValue: string,
    values: readonly string[],
): DescribedSettingItem {
    return {
        id,
        label,
        description,
        currentValue,
        values: values.includes(currentValue) ? [...values] : [currentValue, ...values],
    };
}

function formatHeaderLines(
    tab: CodexSettingsTab,
    config: CodexCoreConfig,
    theme: Theme,
    personalitySupported: boolean,
): string[] {
    if (tab !== "general") return [""];
    const personality = personalitySupported ? `, personality ${config.prompt.personality}` : "";
    return [
        `  ${theme.bold("Pi Codex Core")}: tools ${config.scope.tools}, prompt ${config.prompt.mode}${personality}, compaction ${config.compaction.enabled ? "on" : "off"}`,
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
