import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { restoreTreeHeaderText } from "./patch-tree-header.ts";
import { patchTreeSelector } from "./patch-tree-selector.ts";
import {
    flushSettingsWrites,
    getPersistedMode,
    loadTreeSettings,
    setSettingsContext,
} from "./settings.ts";

export default function treeTimestampsExtension(pi: Pick<ExtensionAPI, "on">): void {
    pi.on("session_start", async (_event, ctx) => {
        setSettingsContext(ctx);

        const loaded = loadTreeSettings();
        if (ctx.hasUI) {
            for (const diagnostic of loaded.diagnostics) {
                ctx.ui.notify(diagnostic.message, diagnostic.severity);
            }
        }

        if (!ctx.hasUI) return;

        getPersistedMode();

        await patchTreeSelector({ theme: () => ctx.ui.theme });
    });

    pi.on("session_shutdown", async () => {
        await flushSettingsWrites();
        restoreTreeHeaderText();
    });
}
