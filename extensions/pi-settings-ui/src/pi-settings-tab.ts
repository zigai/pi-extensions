import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
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
    truncateToWidth,
    visibleWidth,
    type Component,
    type TerminalColorScheme,
} from "@earendil-works/pi-tui";

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

export type PiSettingsPane = Component & {
    readonly activeScope: PiSettingsScope;
    readonly flush: () => Promise<void>;
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
    readonly terminalTheme: TerminalColorScheme;
    readonly onCancel: () => void;
    readonly requestRender: () => void;
};

function activeThemeName(setting: string, terminalTheme: TerminalColorScheme): string {
    const separator = setting.indexOf("/");
    if (separator === -1 || setting.indexOf("/", separator + 1) !== -1) return setting;
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
            global: options.globalSettings.getThemeSetting() ?? "dark",
            project: options.projectSettings.getThemeSetting() ?? "dark",
        };
        this.reportSettingsErrors();
        this.selector = this.createSelector();
    }

    get activeScope(): PiSettingsScope {
        return this.activeScopeValue;
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
        const { pi, ui, model, terminalTheme } = this.options;
        const settings = this.currentSettings();
        const availableThinkingLevels = model
            ? getSupportedThinkingLevels(model)
            : [...ALL_THINKING_LEVELS];
        const thinkingLevel =
            this.activeScopeValue === "global"
                ? pi.getThinkingLevel()
                : (settings.getDefaultThinkingLevel() ?? pi.getThinkingLevel());
        return {
            autoCompact: settings.getCompactionEnabled(),
            showImages: settings.getShowImages(),
            imageWidthCells: settings.getImageWidthCells(),
            autoResizeImages: settings.getImageAutoResize(),
            blockImages: settings.getBlockImages(),
            enableSkillCommands: settings.getEnableSkillCommands(),
            steeringMode: settings.getSteeringMode(),
            followUpMode: settings.getFollowUpMode(),
            transport: settings.getTransport(),
            httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
            thinkingLevel,
            availableThinkingLevels,
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
            fullscreenScrollbar: settings.getFullscreenScrollbar(),
            warnings: settings.getWarnings(),
        };
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
            onHttpIdleTimeoutMsChange: (timeoutMs) =>
                this.persist(["httpIdleTimeoutMs"], timeoutMs, () =>
                    settings.setHttpIdleTimeoutMs(timeoutMs),
                ),
            onThinkingLevelChange: (level) => {
                if (this.activeScopeValue === "global") pi.setThinkingLevel(level);
                else this.persistProject(["defaultThinkingLevel"], level);
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
                this.persist(["warnings"], warnings, () => settings.setWarnings(warnings)),
            onCancel,
        };
    }

    private persist(path: readonly string[], value: unknown, globalChange: () => void): void {
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
        this.writeTail = this.writeTail.then(() => this.flushGlobalSettings());
    }

    private persistProject(path: readonly string[], value: unknown): void {
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
