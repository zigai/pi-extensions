import type {
    ExtensionAPI,
    ExtensionContext,
    SessionShutdownEvent,
    SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { installAutocompletePositionPatch } from "./autocomplete-position.ts";
import { installAutocompleteScrollInfoPatch } from "./autocomplete-scroll-info.ts";
import { installAnchorInputToBottomPatch } from "./anchor-input-to-bottom.ts";
import { installBashExecSpacingEditor } from "./bash-exec-spacing.ts";
import { installNeutralBorderColorPatch } from "./border-color.ts";
import { installInputPromptPrefixPatch } from "./input-prompt-prefix.ts";
import { installModelSelectorHintPatch } from "./model-selector-hint.ts";
import { installModelSelectorProviderBadgePatch } from "./model-selector-provider-badge.ts";
import { installModelStatusPatch } from "./model-status.ts";
import { installPasteCollapseEditor, installPasteCollapsePatch } from "./paste-collapse.ts";
import { installPreserveCompactionHistoryPatch } from "./preserve-compaction-history.ts";
import {
    installSelectedOptionPrefixSelectListPatch,
    installSelectedOptionPrefixThemePatch,
} from "./selected-option-prefix.ts";
import {
    loadUiTweaksSettings,
    type LoadedUiTweaksConfig,
    type UiTweaksConfig,
} from "./settings.ts";
import { installSlashCommandSourcePatch } from "./slash-command-source.ts";
import { installTerminalHyperlinkRefresh } from "./terminal-hyperlinks.ts";

const reportedConfigErrors = new Set<string>();

type UiTweaksHandle = {
    update(config: UiTweaksConfig): void;
    dispose(): void;
};

let handles: UiTweaksHandle[] = [];

export type UiTweaksLifecycleContext = Pick<
    ExtensionContext,
    "cwd" | "hasUI" | "isProjectTrusted"
> & {
    readonly ui: Pick<
        ExtensionContext["ui"],
        "getEditorComponent" | "notify" | "setEditorComponent" | "setWidget"
    > & {
        readonly theme?: ExtensionContext["ui"]["theme"];
    };
};

export type UiTweaksLifecycleEvent = SessionStartEvent | SessionShutdownEvent;

export type UiTweaksExtensionApi = {
    onSessionStart(
        handler: (
            event: UiTweaksLifecycleEvent,
            ctx: UiTweaksLifecycleContext,
        ) => void | Promise<void>,
    ): void;

    onSessionShutdown(
        handler: (
            event: UiTweaksLifecycleEvent,
            ctx: UiTweaksLifecycleContext,
        ) => void | Promise<void>,
    ): void;
};

function reportConfigErrors(ctx: UiTweaksLifecycleContext, loaded: LoadedUiTweaksConfig): void {
    for (const error of loaded.errors) {
        if (reportedConfigErrors.has(error)) continue;
        reportedConfigErrors.add(error);
        ctx.ui.notify(`[pi-ui-tweaks] ${error}`, "error");
    }
}

async function installUiTweaks(
    ctx: UiTweaksLifecycleContext,
    config: UiTweaksConfig,
): Promise<UiTweaksHandle[]> {
    const autocompletePosition = installAutocompletePositionPatch(config);
    const autocompleteScroll = installAutocompleteScrollInfoPatch(config);
    const anchor = installAnchorInputToBottomPatch(config);
    const bash = installBashExecSpacingEditor(ctx, config);
    const inputPrefix = installInputPromptPrefixPatch(config);
    const modelHint = installModelSelectorHintPatch(config);
    const modelStatus = installModelStatusPatch(config);
    const pastePatch = installPasteCollapsePatch(config);
    const pasteEditor = installPasteCollapseEditor(ctx, config);
    const compaction = installPreserveCompactionHistoryPatch(config);
    const selectList = installSelectedOptionPrefixSelectListPatch(config);
    const slashSource = installSlashCommandSourcePatch(config);
    const [border, providerBadge, selectedTheme] = await Promise.all([
        installNeutralBorderColorPatch(config),
        installModelSelectorProviderBadgePatch(config, undefined, () => ctx.ui.theme),
        installSelectedOptionPrefixThemePatch(config),
    ]);
    const terminalHyperlinks = installTerminalHyperlinkRefresh(ctx, config.refreshTmuxHyperlinks);

    return [
        {
            update: (next) => autocompletePosition.update(next),
            dispose: () => autocompletePosition.dispose(),
        },
        {
            update: (next) => autocompleteScroll.update(next),
            dispose: () => autocompleteScroll.dispose(),
        },
        { update: (next) => anchor.update(next), dispose: () => anchor.dispose() },
        { update: (next) => bash.update(next), dispose: () => bash.dispose() },
        { update: (next) => inputPrefix.update(next), dispose: () => inputPrefix.dispose() },
        { update: (next) => modelHint.update(next), dispose: () => modelHint.dispose() },
        { update: (next) => modelStatus.update(next), dispose: () => modelStatus.dispose() },
        { update: (next) => pastePatch.update(next), dispose: () => pastePatch.dispose() },
        { update: (next) => pasteEditor.update(next), dispose: () => pasteEditor.dispose() },
        { update: (next) => compaction.update(next), dispose: () => compaction.dispose() },
        { update: (next) => selectList.update(next), dispose: () => selectList.dispose() },
        { update: (next) => slashSource.update(next), dispose: () => slashSource.dispose() },
        {
            update: (next) => terminalHyperlinks.update(next.refreshTmuxHyperlinks),
            dispose: () => terminalHyperlinks.dispose(),
        },
        { update: (next) => border.update(next), dispose: () => border.dispose() },
        { update: (next) => providerBadge.update(next), dispose: () => providerBadge.dispose() },
        { update: (next) => selectedTheme.update(next), dispose: () => selectedTheme.dispose() },
    ];
}

export function registerUiTweaksLifecycle(pi: UiTweaksExtensionApi): void {
    pi.onSessionStart(async (_event, ctx) => {
        const loaded = loadUiTweaksSettings(ctx.cwd, ctx.isProjectTrusted());
        reportConfigErrors(ctx, loaded);

        if (handles.length === 0) {
            handles = await installUiTweaks(ctx, loaded.config);
            return;
        }

        for (const handle of handles) handle.update(loaded.config);
    });
    pi.onSessionShutdown(() => {
        for (let index = handles.length - 1; index >= 0; index -= 1) handles[index]?.dispose();
        handles = [];
    });
}

/** Installs small configurable Pi UI tweaks. */
export default function uiTweaksExtension(pi: ExtensionAPI): void {
    registerUiTweaksLifecycle({
        onSessionStart(handler): void {
            pi.on("session_start", handler);
        },
        onSessionShutdown(handler): void {
            pi.on("session_shutdown", handler);
        },
    });
}
