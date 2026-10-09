import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    installLiveFooter,
    patchFooterReset,
    rememberFooterForTransition,
} from "./footer-transition.ts";
import { DEFAULT_FOOTER_CONFIG, loadFooterSettings, type LoadedFooterConfig } from "./settings.ts";
import { installFooterShrinkPaddingPatch } from "./tui-footer-shrink-padding.ts";
import { createLiveFooterContext } from "./footer-session-status.ts";

const reportedConfigErrors = new Set<string>();

function reportConfigErrors(ctx: ExtensionContext, loaded: LoadedFooterConfig): void {
    for (const error of loaded.errors) {
        if (reportedConfigErrors.has(error)) {
            continue;
        }

        reportedConfigErrors.add(error);
        ctx.ui.notify(`[pi-footer] ${error}`, "error");
    }
}

function loadAndReportFooterSettings(ctx: ExtensionContext): LoadedFooterConfig {
    const loaded = loadFooterSettings(ctx.cwd, ctx.isProjectTrusted());
    reportConfigErrors(ctx, loaded);
    return loaded;
}

export default function uiEnhancements(pi: ExtensionAPI) {
    patchFooterReset();

    const shrinkPaddingHandle = installFooterShrinkPaddingPatch();
    const getThinkingLevel = () => pi.getThinkingLevel();
    let activeFooterConfig = DEFAULT_FOOTER_CONFIG;

    const installFooter = (ctx: ExtensionContext) => {
        const loaded = loadAndReportFooterSettings(ctx);
        activeFooterConfig = loaded.config;
        installLiveFooter(createLiveFooterContext(ctx, pi), getThinkingLevel, activeFooterConfig);
    };

    pi.on("session_start", async (_event, ctx) => {
        installFooter(ctx);
    });

    pi.on("session_shutdown", async (event, ctx) => {
        rememberFooterForTransition(
            createLiveFooterContext(ctx, pi),
            event.reason,
            getThinkingLevel(),
            activeFooterConfig,
        );

        shrinkPaddingHandle?.dispose();
    });
}
