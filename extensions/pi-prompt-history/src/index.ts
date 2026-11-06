import {
    getAgentDir,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { dirname, join, resolve } from "node:path";
import { applyPromptHistoryEditor } from "./editor.ts";
import { HistoryPicker } from "./picker.ts";
import { HistorySource } from "./source.ts";
import { loadPromptHistorySettings } from "./settings.ts";

export default function (pi: ExtensionAPI) {
    let settings: ReturnType<typeof loadPromptHistorySettings> | undefined;
    let enhancer: ReturnType<typeof applyPromptHistoryEditor> | undefined;
    let picker: HistoryPicker | undefined;
    let opening = false;
    let generation = 0;

    function reset() {
        generation++;
        picker?.cancel();
        picker = undefined;
        enhancer?.dispose();
        enhancer = undefined;
        settings = undefined;
        opening = false;
    }

    function getSettings(ctx: ExtensionContext) {
        if (!settings) {
            settings = loadPromptHistorySettings(ctx);
            if (ctx.hasUI)
                for (const diagnostic of settings.diagnostics)
                    ctx.ui.notify(diagnostic.message, diagnostic.severity);
        }

        return settings.settings;
    }

    async function open(ctx: ExtensionContext) {
        if (!ctx.hasUI || opening) return;

        const configured = getSettings(ctx);
        if (!configured.enabled) return;

        opening = true;

        const current = generation;
        const manager = ctx.sessionManager;
        const directory = resolve(manager.getSessionDir());

        // Public manager gives the effective session directory, not the storage root.
        // Default Pi storage has one project directory below the configured agent's sessions root.
        let root = directory;
        const profileRoot = resolve(join(getAgentDir(), "sessions"));
        if (dirname(directory) === profileRoot) root = profileRoot;

        const source = new HistorySource({
            root,
            session: manager.getSessionId(),
            cwd: ctx.cwd,
            sessionCwd: manager.getHeader()?.cwd ?? manager.getCwd(),
            live: () => manager.getEntries(),
        });

        let requestRender: (() => void) | undefined;

        try {
            const text = await ctx.ui.custom<string | undefined>(
                (tui, _theme, _keys, done) => {
                    requestRender = () => tui.requestRender();
                    picker = new HistoryPicker(
                        configured.defaultScope,
                        source,
                        () => tui.requestRender(),
                        done,
                        () => tui.terminal.rows,
                    );

                    return picker;
                },
                { overlay: true, overlayOptions: { width: "95%", maxHeight: "95%" } },
            );
            if (current === generation && text !== undefined) {
                ctx.ui.setEditorText(text);
                requestRender?.();
            }
        } finally {
            source.cancel();

            if (current === generation) {
                picker = undefined;
                opening = false;
            }
        }
    }

    pi.registerShortcut("ctrl+r", {
        description: "Search user prompts by session, project or global scope",
        handler: open,
    });
    pi.registerCommand("prompt-history", {
        description: "Search user prompts (copies text; never submits)",
        handler: async (_args, ctx) => open(ctx),
    });
    pi.on("session_start", (_event, ctx) => {
        reset();
        enhancer = applyPromptHistoryEditor(ctx);
    });
    pi.on("session_shutdown", reset);
    pi.on("message_end", () => {
        picker?.refreshLive();
    });

    pi.on("session_tree", () => {
        picker?.refreshLive();
    });
}
