import type {
    ExtensionAPI,
    ExtensionContext,
    SessionShutdownEvent,
    SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
    registerExtensionDiagnostics,
    reportExtensionDiagnostic,
} from "@zigai/pi-extension-internals";

import { installAutocompletePositionPatch } from "./autocomplete-position.ts";
import { installAutocompleteScrollInfoPatch } from "./autocomplete-scroll-info.ts";
import { installAnchorInputToBottomPatch } from "./anchor-input-to-bottom.ts";
import { installBashExecSpacingEditor } from "./bash-exec-spacing.ts";
import { installNeutralBorderColorPatch } from "./border-color.ts";
import { installInputBorderPatch } from "./input-border.ts";
import { installInputPromptPrefixPatch } from "./input-prompt-prefix.ts";
import { installModelSelectorHintPatch } from "./model-selector-hint.ts";
import { installModelSelectorProviderBadgePatch } from "./model-selector-provider-badge.ts";
import { installModelStatusPatch } from "./model-status.ts";
import { installMainScreenSynchronizedOutputPatch } from "./main-screen-synchronized-output.ts";
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

type UiTweaksHandle = {
    update(config: UiTweaksConfig): void;
    dispose(): void;
};

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

function reportConfigErrors(
    ctx: UiTweaksLifecycleContext,
    loaded: LoadedUiTweaksConfig,
    reportedConfigErrors: Set<string>,
): void {
    for (const error of loaded.errors) {
        if (reportedConfigErrors.has(error)) continue;
        reportedConfigErrors.add(error);

        reportExtensionDiagnostic(`[pi-ui-tweaks] ${error}`, "error", ctx);
    }
}

async function installUiTweaks(
    ctx: UiTweaksLifecycleContext,
    config: UiTweaksConfig,
): Promise<UiTweaksHandle[]> {
    const installed: UiTweaksHandle[] = [];
    const collect = (handle: UiTweaksHandle): void => {
        installed.push(handle);
    };

    try {
        collect(installMainScreenSynchronizedOutputPatch(config));
        collect(installAutocompletePositionPatch(config));
        collect(installAutocompleteScrollInfoPatch(config));
        collect(installAnchorInputToBottomPatch(config));
        collect(installBashExecSpacingEditor(ctx, config));
        collect(installInputBorderPatch(config));
        collect(installInputPromptPrefixPatch(config));
        collect(installModelSelectorHintPatch(config));
        collect(installModelStatusPatch(config));
        collect(installPasteCollapsePatch(config));
        collect(installPasteCollapseEditor(ctx, config));
        collect(installPreserveCompactionHistoryPatch(config));
        collect(installSelectedOptionPrefixSelectListPatch(config));
        collect(installSlashCommandSourcePatch(config));

        const results = await Promise.allSettled([
            installNeutralBorderColorPatch(config).then(collect),
            installModelSelectorProviderBadgePatch(config, undefined, () => ctx.ui.theme).then(
                collect,
            ),
            installSelectedOptionPrefixThemePatch(config).then(collect),
        ]);
        for (const result of results) {
            if (result.status === "rejected") throw result.reason;
        }

        const hyperlinks = installTerminalHyperlinkRefresh(ctx, config.refreshTmuxHyperlinks);

        collect({
            update: (next) => hyperlinks.update(next.refreshTmuxHyperlinks),
            dispose: () => hyperlinks.dispose(),
        });

        return installed;
    } catch (cause) {
        for (const handle of installed.reverse()) handle.dispose();

        throw cause;
    }
}

export function registerUiTweaksLifecycle(pi: UiTweaksExtensionApi): void {
    const reportedConfigErrors = new Set<string>();
    let handles: UiTweaksHandle[] = [];
    let generation = 0;
    let inFlight: Promise<void> = Promise.resolve();
    const reset = (): void => {
        generation += 1;

        for (const handle of handles.reverse()) handle.dispose();
        handles = [];
        reportedConfigErrors.clear();
    };

    pi.onSessionStart(async (_event, ctx) => {
        reset();

        const current = generation;

        inFlight = inFlight
            .catch(() => {})
            .then(async () => {
                if (current !== generation) return;

                const loaded = loadUiTweaksSettings(ctx.cwd, ctx.isProjectTrusted());
                reportConfigErrors(ctx, loaded, reportedConfigErrors);

                const installed = await installUiTweaks(ctx, loaded.config);
                if (current !== generation) {
                    for (const handle of installed.reverse()) handle.dispose();

                    return;
                }

                handles = installed;
            });

        return inFlight;
    });
    pi.onSessionShutdown(async () => {
        reset();
        await inFlight;
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

    registerExtensionDiagnostics(pi);
}
