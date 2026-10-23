import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
    SettingsSelectorComponent,
    type ExtensionAPI,
    type ExtensionContext,
    type ExtensionUIContext,
    type SettingsCallbacks,
    type SettingsConfig,
    type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
    getCapabilities,
    truncateToWidth,
    visibleWidth,
    type Component,
    type TerminalColorScheme,
} from "@earendil-works/pi-tui";

import { type JsonObject, type JsonValue } from "./json-value.ts";
import { savePiProjectSetting, type PiProjectSettingsSnapshot } from "./pi-project-settings.ts";

const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];

const SCROLL_COUNTER_PATTERN = /\(\d+\/\d+\)/u;

type PiSettingsScope = "global" | "project";
type PiSettingsUi = Pick<ExtensionUIContext, "getAllThemes" | "notify" | "setTheme">;

type PiSettingsRuntime = {
    readonly mode: "regular" | "fullscreen";
    readonly setClearOnShrink: (enabled: boolean) => void;
    readonly setShowHardwareCursor: (enabled: boolean) => void;
};

type PiSettingEntry = {
    readonly id: string;
    readonly label: string;
    readonly description: string;
};

const PI_SETTINGS_ENTRIES: readonly PiSettingEntry[] = [
    {
        id: "autocompact",
        label: "Auto-compact",
        description: "Automatically compact context when it gets too large",
    },
    {
        id: "show-images",
        label: "Show images",
        description: "Render images inline in terminal",
    },
    {
        id: "image-width-cells",
        label: "Image width",
        description: "Preferred inline image width in terminal cells",
    },
    {
        id: "auto-resize-images",
        label: "Auto-resize images",
        description: "Resize large images to 2000x2000 max for better model compatibility",
    },
    {
        id: "block-images",
        label: "Block images",
        description: "Prevent images from being sent to LLM providers",
    },
    {
        id: "skill-commands",
        label: "Skill commands",
        description: "Register skills as /skill:name commands",
    },
    {
        id: "show-hardware-cursor",
        label: "Show hardware cursor",
        description: "Use the terminal cursor instead of Pi's drawn cursor",
    },
    {
        id: "editor-padding",
        label: "Editor padding",
        description: "Horizontal padding for input editor (0-3)",
    },
    {
        id: "output-padding",
        label: "Output padding",
        description: "Horizontal padding for messages, tool output, and command output",
    },
    {
        id: "autocomplete-max-visible",
        label: "Autocomplete max items",
        description: "Max visible items in autocomplete dropdown (3-20)",
    },
    {
        id: "clear-on-shrink",
        label: "Clear on shrink",
        description: "Clear empty rows when content shrinks (may cause flicker)",
    },
    {
        id: "terminal-progress",
        label: "Terminal progress",
        description: "Show OSC 9;4 progress indicators in the terminal tab bar",
    },
    {
        id: "steering-mode",
        label: "Steering mode",
        description:
            "Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
    },
    {
        id: "follow-up-mode",
        label: "Follow-up mode",
        description:
            "Queue follow-up messages until the agent stops. Deliver one at a time or all at once.",
    },
    {
        id: "transport",
        label: "Transport",
        description: "Preferred transport for providers that support multiple transports",
    },
    {
        id: "share-destination",
        label: "Session share destination",
        description:
            "Where to upload sessions with /share (auto prefers Radius when authenticated, otherwise GitHub Gist)",
    },
    {
        id: "http-idle-timeout",
        label: "HTTP idle timeout",
        description:
            "Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
    },
    {
        id: "cache-warming-mode",
        label: "Cache warming",
        description:
            "off; streaming while the agent runs; idle also between runs while continuation stays profitable",
    },
    {
        id: "hide-thinking",
        label: "Hide thinking",
        description: "Hide thinking blocks in assistant responses",
    },
    {
        id: "mermaid-rendering",
        label: "Mermaid diagrams",
        description: "Render Mermaid code blocks as Unicode diagrams",
    },
    {
        id: "cache-miss-notices",
        label: "Cache miss notices",
        description: "Show transcript notices for cache costs and provider recovery diagnostics",
    },
    {
        id: "collapse-changelog",
        label: "Collapse changelog",
        description: "Show condensed changelog after updates",
    },
    {
        id: "quiet-startup",
        label: "Quiet startup",
        description: "Disable verbose printing at startup (header: keep only the startup header)",
    },
    {
        id: "install-telemetry",
        label: "Install telemetry",
        description: "Send an anonymous version/update ping after changelog-detected updates",
    },
    {
        id: "default-project-trust",
        label: "Default project trust",
        description:
            "Fallback behavior when no extension or saved trust decision decides project trust",
    },
    {
        id: "double-escape-action",
        label: "Double-escape action",
        description: "Action when pressing Escape twice with empty editor",
    },
    {
        id: "tree-filter-mode",
        label: "Tree filter mode",
        description: "Default filter when opening /tree",
    },
    {
        id: "warnings",
        label: "Warnings",
        description: "Enable or disable individual warnings",
    },
    {
        id: "model-thinking",
        label: "Default thinking level per model",
        description: "Override the default thinking level for specific models.",
    },
    {
        id: "tui-mode",
        label: "TUI mode",
        description: "Interface layout; regular mode uses the terminal's normal scrollback",
    },
    {
        id: "fullscreen-exit-output",
        label: "Fullscreen exit output",
        description:
            "Print the transcript or only a session resume hint when exiting fullscreen mode",
    },
    {
        id: "fullscreen-scrollbar",
        label: "Fullscreen scrollbar",
        description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
    },
    {
        id: "fullscreen-copy-on-select",
        label: "Fullscreen copy on select",
        description:
            "Automatically copy selected text in fullscreen mode; disable to copy selections with Ctrl+X",
    },
    {
        id: "fullscreen-wheel-scroll-lines",
        label: "Fullscreen wheel scrolling",
        description:
            "Lines per mouse-wheel event in fullscreen mode; 'auto' speeds up fast wheel spins where the terminal does not",
    },
    {
        id: "theme",
        label: "Theme",
        description: "Color theme for the interface",
    },
];

export type PiSettingsPane = Component & {
    readonly activeScope: PiSettingsScope;
    readonly flush: () => Promise<void>;

    /** Select an exact native ID, clearing any native filter or submenu. Unknown IDs are a no-op. */
    readonly focusSetting: (id: string) => boolean;

    /** Searchable native controls, without current values or model/theme submenu choices. */
    readonly settingsEntries: () => readonly PiSettingEntry[];
    readonly handleInput: (data: string) => void;
    readonly leave: () => void;
    readonly scopeAvailable: (scope: PiSettingsScope) => boolean;
    readonly scopeMessage: (scope: PiSettingsScope) => string;
    readonly selectScope: (scope: PiSettingsScope) => boolean;
};

export type PiSettingsTabOptions = {
    readonly globalSettings: SettingsManager;
    readonly projectSettings: SettingsManager;
    readonly projectSnapshot: PiProjectSettingsSnapshot;
    readonly pi: Pick<ExtensionAPI, "getThinkingLevel" | "setThinkingLevel">;
    readonly ui: PiSettingsUi;
    readonly runtime: PiSettingsRuntime;
    readonly model: ExtensionContext["model"];
    readonly availableDefaultModels: SettingsConfig["availableDefaultModels"];
    readonly terminalTheme: TerminalColorScheme;
    readonly onCancel: () => void;
    readonly requestRender: () => void;
};

function activeThemeName(setting: string, terminalTheme: TerminalColorScheme): string {
    const separator = setting.indexOf("/");
    if (separator === -1 || setting.includes("/", separator + 1)) return setting;

    const lightTheme = setting.slice(0, separator).trim();
    const darkTheme = setting.slice(separator + 1).trim();
    if (lightTheme === "" || darkTheme === "") return setting;
    return terminalTheme === "light" ? lightTheme : darkTheme;
}

function rightAlignedLine(left: string, right: string, width: number): string {
    const rightWidth = visibleWidth(right);
    if (rightWidth >= width) return truncateToWidth(right, width, "");

    const leftLimit = Math.max(0, width - rightWidth - 1);
    const baseLine = truncateToWidth(left.replace(/ +$/u, ""), leftLimit, "");
    const gap = Math.max(1, width - visibleWidth(baseLine) - rightWidth);
    return `${baseLine}${" ".repeat(gap)}${right}`;
}

function warningSettingsValue(warnings: SettingsConfig["warnings"]): JsonObject {
    return warnings.anthropicExtraUsage === undefined
        ? {}
        : { anthropicExtraUsage: warnings.anthropicExtraUsage };
}

function moveCounterToSearchLine(lines: readonly string[], width: number): string[] {
    const rendered = [...lines];
    const counterIndex = rendered.findIndex((line) => {
        const counter = SCROLL_COUNTER_PATTERN.exec(line)?.[0];
        return counter !== undefined && visibleWidth(line) <= counter.length + 4;
    });
    if (counterIndex === -1) return rendered;

    const counterLine = rendered[counterIndex];
    const counter =
        counterLine === undefined ? undefined : SCROLL_COUNTER_PATTERN.exec(counterLine)?.[0];
    const searchIndex = rendered.findIndex(
        (line, index) => index < counterIndex && (line.includes(">") || line.includes("❯")),
    );
    if (counter === undefined || searchIndex === -1 || rendered[searchIndex] === undefined) {
        return rendered;
    }

    rendered.splice(counterIndex, 1);
    rendered[searchIndex] = rightAlignedLine(rendered[searchIndex], counter, width);
    return rendered;
}

/** Pi's public settings selector with global and trusted-project persistence. */
export class PiSettingsTab implements PiSettingsPane {
    private selector: SettingsSelectorComponent;
    private writeTail: Promise<void> = Promise.resolve();
    private activeScopeValue: PiSettingsScope = "global";
    private projectSnapshot: PiProjectSettingsSnapshot;
    private readonly savedThemes: Record<PiSettingsScope, string>;
    private previewActive = false;

    constructor(private readonly options: PiSettingsTabOptions) {
        this.projectSnapshot = options.projectSnapshot;
        this.savedThemes = {
            global: options.globalSettings.getThemeSetting() ?? "system",
            project: options.projectSettings.getThemeSetting() ?? "system",
        };
        this.reportSettingsErrors();
        this.selector = this.createSelector();
    }

    get activeScope(): PiSettingsScope {
        return this.activeScopeValue;
    }

    settingsEntries(): readonly PiSettingEntry[] {
        const supportsImages = getCapabilities().images !== null;

        return PI_SETTINGS_ENTRIES.filter(
            ({ id }) => supportsImages || !["show-images", "image-width-cells"].includes(id),
        );
    }

    focusSetting(id: string): boolean {
        if (!this.settingsEntries().some((entry) => entry.id === id)) return false;

        this.leave();
        this.selector = this.createSelector();
        this.selector.getSettingsList().selectItem(id);
        this.options.requestRender();

        return true;
    }

    handleInput(data: string): void {
        this.selector.getSettingsList().handleInput(data);
        this.options.requestRender();
    }

    render(width: number): string[] {
        return moveCounterToSearchLine(this.selector.render(width), width);
    }

    invalidate(): void {
        this.selector.invalidate();
    }

    leave(): void {
        if (!this.previewActive) return;

        this.previewActive = false;
        this.switchTheme(this.savedThemes[this.activeScopeValue]);
    }

    scopeAvailable(scope: PiSettingsScope): boolean {
        return scope === "global" || this.projectSnapshot._tag === "ReadyProjectSettings";
    }

    scopeMessage(scope: PiSettingsScope): string {
        if (scope === "global") return "Global Pi settings are available.";
        return this.projectSnapshot._tag === "ReadyProjectSettings"
            ? this.projectSnapshot.path
            : this.projectSnapshot.message;
    }

    selectScope(scope: PiSettingsScope): boolean {
        if (!this.scopeAvailable(scope)) return false;

        this.leave();
        this.activeScopeValue = scope;
        this.selector = this.createSelector();
        this.options.requestRender();

        return true;
    }

    async flush(): Promise<void> {
        await this.writeTail;
        await this.flushGlobalSettings();
    }

    private currentSettings(): SettingsManager {
        return this.activeScopeValue === "global"
            ? this.options.globalSettings
            : this.options.projectSettings;
    }

    private createSelector(): SettingsSelectorComponent {
        return new SettingsSelectorComponent(this.createConfig(), this.createCallbacks());
    }

    private createConfig(): SettingsConfig {
        const { ui, model, terminalTheme } = this.options;
        const settings = this.currentSettings();
        const defaultProvider = settings.getDefaultProvider();
        const defaultModelId = settings.getDefaultModel();

        const config: SettingsConfig = {
            autoCompact: settings.getCompactionEnabled(),
            defaultModel:
                defaultProvider && defaultModelId
                    ? `${defaultProvider}/${defaultModelId}`
                    : "not set",
            availableDefaultModels: this.options.availableDefaultModels,
            showImages: settings.getShowImages(),
            imageWidthCells: settings.getImageWidthCells(),
            autoResizeImages: settings.getImageAutoResize(),
            blockImages: settings.getBlockImages(),
            enableSkillCommands: settings.getEnableSkillCommands(),
            steeringMode: settings.getSteeringMode(),
            followUpMode: settings.getFollowUpMode(),
            transport: settings.getTransport(),
            sessionShareDestination: settings.getSessionShareDestination(),
            httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
            cacheWarmingMode: this.options.globalSettings.getCacheWarmingMode(),
            thinkingLevel: settings.getDefaultThinkingLevel() ?? "medium",
            availableThinkingLevels: [...ALL_THINKING_LEVELS],
            modelThinkingLevels: settings.getAllModelThinkingLevels(),
            currentTheme: this.savedThemes[this.activeScopeValue],
            terminalTheme,
            availableThemes: ui.getAllThemes().map(({ name }) => name),
            hideThinkingBlock: settings.getHideThinkingBlock(),
            mermaidRenderingMode: settings.getMermaidRenderingMode(),
            showCacheMissNotices: settings.getShowCacheMissNotices(),
            collapseChangelog: settings.getCollapseChangelog(),
            enableInstallTelemetry: settings.getEnableInstallTelemetry(),
            doubleEscapeAction: settings.getDoubleEscapeAction(),
            treeFilterMode: settings.getTreeFilterMode(),
            showHardwareCursor: settings.getShowHardwareCursor(),
            editorPaddingX: settings.getEditorPaddingX(),
            outputPad: settings.getOutputPad(),
            autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
            quietStartup: settings.getQuietStartup(),
            defaultProjectTrust: settings.getDefaultProjectTrust(),
            clearOnShrink: settings.getClearOnShrink(),
            showTerminalProgress: settings.getShowTerminalProgress(),
            tuiMode:
                this.activeScopeValue === "global"
                    ? this.options.runtime.mode
                    : settings.getTuiMode(),
            fullscreenExitOutput: settings.getFullscreenExitOutput(),
            fullscreenScrollbar: settings.getFullscreenScrollbar(),
            fullscreenCopyOnSelect: settings.getFullscreenCopyOnSelect(),
            fullscreenWheelScrollLines: settings.getFullscreenWheelScrollLines(),
            warnings: settings.getWarnings(),
        };
        if (model !== undefined) config.currentModel = model;

        return config;
    }

    private createCallbacks(): SettingsCallbacks {
        const { globalSettings: settings, pi, runtime, onCancel } = this.options;

        return {
            onAutoCompactChange: (enabled) =>
                this.persist(["compaction", "enabled"], enabled, () =>
                    settings.setCompactionEnabled(enabled),
                ),
            onShowImagesChange: (enabled) =>
                this.persist(["terminal", "showImages"], enabled, () =>
                    settings.setShowImages(enabled),
                ),
            onImageWidthCellsChange: (width) =>
                this.persist(["terminal", "imageWidthCells"], width, () =>
                    settings.setImageWidthCells(width),
                ),
            onAutoResizeImagesChange: (enabled) =>
                this.persist(["images", "autoResize"], enabled, () =>
                    settings.setImageAutoResize(enabled),
                ),
            onBlockImagesChange: (blocked) =>
                this.persist(["images", "blockImages"], blocked, () =>
                    settings.setBlockImages(blocked),
                ),
            onEnableSkillCommandsChange: (enabled) =>
                this.persist(["enableSkillCommands"], enabled, () =>
                    settings.setEnableSkillCommands(enabled),
                ),
            onSteeringModeChange: (mode) =>
                this.persist(["steeringMode"], mode, () => settings.setSteeringMode(mode)),
            onFollowUpModeChange: (mode) =>
                this.persist(["followUpMode"], mode, () => settings.setFollowUpMode(mode)),
            onTransportChange: (transport) =>
                this.persist(["transport"], transport, () => settings.setTransport(transport)),
            onSessionShareDestinationChange: (destination) =>
                this.persist(["sessionShareDestination"], destination, () =>
                    settings.setSessionShareDestination(destination),
                ),
            onHttpIdleTimeoutMsChange: (timeoutMs) =>
                this.persist(["httpIdleTimeoutMs"], timeoutMs, () =>
                    settings.setHttpIdleTimeoutMs(timeoutMs),
                ),
            onCacheWarmingModeChange: (mode) => {
                if (this.activeScopeValue === "project") {
                    this.selector
                        .getSettingsList()
                        .updateValue("cache-warming-mode", settings.getCacheWarmingMode());
                    this.options.ui.notify(
                        "Cache warming can only be changed in global Pi settings.",
                        "info",
                    );

                    return;
                }

                this.persist(["cacheWarming"], mode, () => settings.setCacheWarmingMode(mode));
            },
            onModelThinkingLevelChange: (provider, modelId, level) => {
                this.persist(["modelThinkingLevels", `${provider}/${modelId}`], level, () =>
                    settings.setModelThinkingLevel(provider, modelId, level),
                );

                const current = this.options.model;
                if (
                    this.activeScopeValue === "global" &&
                    current?.provider === provider &&
                    current.id === modelId
                ) {
                    pi.setThinkingLevel(level);
                }
            },
            onModelThinkingLevelRemove: (provider, modelId) => {
                this.persist(["modelThinkingLevels", `${provider}/${modelId}`], undefined, () =>
                    settings.removeModelThinkingLevel(provider, modelId),
                );

                const current = this.options.model;
                if (
                    this.activeScopeValue === "global" &&
                    current?.provider === provider &&
                    current.id === modelId
                ) {
                    pi.setThinkingLevel(settings.getDefaultThinkingLevel() ?? "medium");
                }
            },
            onThemeChange: (setting) => {
                this.savedThemes[this.activeScopeValue] = setting;
                this.previewActive = false;
                this.persist(["theme"], setting, () => settings.setTheme(setting));
                this.switchTheme(setting);
            },
            onThemePreview: (setting) => {
                this.previewActive = setting !== this.savedThemes[this.activeScopeValue];
                this.switchTheme(setting);
            },
            onHideThinkingBlockChange: (hidden) =>
                this.persist(["hideThinkingBlock"], hidden, () =>
                    settings.setHideThinkingBlock(hidden),
                ),
            onMermaidRenderingModeChange: (mode) =>
                this.persist(["markdown", "mermaid"], mode, () =>
                    settings.setMermaidRenderingMode(mode),
                ),
            onShowCacheMissNoticesChange: (shown) =>
                this.persist(["showCacheMissNotices"], shown, () =>
                    settings.setShowCacheMissNotices(shown),
                ),
            onCollapseChangelogChange: (collapsed) =>
                this.persist(["collapseChangelog"], collapsed, () =>
                    settings.setCollapseChangelog(collapsed),
                ),
            onEnableInstallTelemetryChange: (enabled) =>
                this.persist(["enableInstallTelemetry"], enabled, () =>
                    settings.setEnableInstallTelemetry(enabled),
                ),
            onDoubleEscapeActionChange: (action) =>
                this.persist(["doubleEscapeAction"], action, () =>
                    settings.setDoubleEscapeAction(action),
                ),
            onTreeFilterModeChange: (mode) =>
                this.persist(["treeFilterMode"], mode, () => settings.setTreeFilterMode(mode)),
            onShowHardwareCursorChange: (enabled) => {
                runtime.setShowHardwareCursor(enabled);
                this.persist(["showHardwareCursor"], enabled, () =>
                    settings.setShowHardwareCursor(enabled),
                );
            },
            onEditorPaddingXChange: (padding) =>
                this.persist(["editorPaddingX"], padding, () =>
                    settings.setEditorPaddingX(padding),
                ),
            onOutputPadChange: (padding) =>
                this.persist(["outputPad"], padding, () => settings.setOutputPad(padding)),
            onAutocompleteMaxVisibleChange: (maxVisible) =>
                this.persist(["autocompleteMaxVisible"], maxVisible, () =>
                    settings.setAutocompleteMaxVisible(maxVisible),
                ),
            onQuietStartupChange: (enabled) =>
                this.persist(["quietStartup"], enabled, () => settings.setQuietStartup(enabled)),
            onDefaultProjectTrustChange: (projectTrust) =>
                this.persist(["defaultProjectTrust"], projectTrust, () =>
                    settings.setDefaultProjectTrust(projectTrust),
                ),
            onClearOnShrinkChange: (enabled) => {
                runtime.setClearOnShrink(enabled);
                this.persist(["terminal", "clearOnShrink"], enabled, () =>
                    settings.setClearOnShrink(enabled),
                );
            },
            onShowTerminalProgressChange: (enabled) =>
                this.persist(["terminal", "showTerminalProgress"], enabled, () =>
                    settings.setShowTerminalProgress(enabled),
                ),
            onTuiModeChange: (mode) => {
                this.persist(["tuiMode"], mode, () => settings.setTuiMode(mode));

                if (mode !== runtime.mode) {
                    this.options.ui.notify(
                        `TUI mode will change to ${mode} in the next Pi session.`,
                        "info",
                    );
                }
            },
            onFullscreenExitOutputChange: (output) =>
                this.persist(["fullscreenExitOutput"], output, () =>
                    settings.setFullscreenExitOutput(output),
                ),
            onFullscreenCopyOnSelectChange: (enabled) => {
                this.persist(["fullscreenCopyOnSelect"], enabled, () =>
                    settings.setFullscreenCopyOnSelect(enabled),
                );

                this.options.ui.notify(
                    "Fullscreen copy on select changes apply in the next Pi session.",
                    "info",
                );
            },
            onFullscreenWheelScrollLinesChange: (lines) => {
                this.persist(["fullscreenWheelScrollLines"], lines, () =>
                    settings.setFullscreenWheelScrollLines(lines),
                );

                this.options.ui.notify(
                    "Fullscreen wheel scrolling changes apply in the next Pi session.",
                    "info",
                );
            },
            onFullscreenScrollbarChange: (mode) => {
                this.persist(["fullscreenScrollbar"], mode, () =>
                    settings.setFullscreenScrollbar(mode),
                );

                this.options.ui.notify(
                    "Fullscreen scrollbar changes apply in the next Pi session.",
                    "info",
                );
            },
            onWarningsChange: (warnings) =>
                this.persist(["warnings"], warningSettingsValue(warnings), () =>
                    settings.setWarnings(warnings),
                ),
            onCancel,
        };
    }

    private persist(
        path: readonly string[],
        value: JsonValue | undefined,
        globalChange: () => void,
    ): void {
        if (this.activeScopeValue === "project") {
            this.persistProject(path, value);
            return;
        }

        try {
            globalChange();
        } catch (error) {
            this.options.ui.notify(
                `Pi settings could not be updated: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );

            return;
        }

        this.writeTail = this.writeTail.then(async () => this.flushGlobalSettings());
    }

    private persistProject(path: readonly string[], value: JsonValue | undefined): void {
        this.writeTail = this.writeTail.then(async () => {
            const outcome = await savePiProjectSetting(this.projectSnapshot, path, value);
            if (outcome._tag === "ProjectSettingSaveFailed") {
                this.options.ui.notify(outcome.message, "error");

                if (this.activeScopeValue === "project") {
                    this.selector = this.createSelector();
                    this.options.requestRender();
                }

                return;
            }

            this.projectSnapshot = outcome.snapshot;

            try {
                await this.options.projectSettings.reload();
            } catch (error) {
                this.options.ui.notify(
                    `Project Pi settings could not be reloaded: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
            }
        });
    }

    private async flushGlobalSettings(): Promise<void> {
        try {
            await this.options.globalSettings.flush();
        } catch (error) {
            this.options.ui.notify(
                `Pi settings could not be saved: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );
        }

        this.reportSettingsErrors();
    }

    private reportSettingsErrors(): void {
        const seen = new Set<string>();
        for (const manager of [this.options.globalSettings, this.options.projectSettings]) {
            for (const { scope, error } of manager.drainErrors()) {
                const message = `${scope === "global" ? "Global" : "Project"} Pi settings: ${error.message}`;
                if (seen.has(message)) continue;
                seen.add(message);
                this.options.ui.notify(message, "error");
            }
        }
    }

    private switchTheme(setting: string): void {
        const result = this.options.ui.setTheme(
            activeThemeName(setting, this.options.terminalTheme),
        );
        if (!result.success) {
            this.options.ui.notify(result.error ?? `Theme ${setting} could not be loaded`, "error");
        }
    }
}
