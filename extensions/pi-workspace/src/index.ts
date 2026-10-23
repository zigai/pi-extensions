import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Workspace } from "./workspace.ts";
import { loadWorkspaceSettings, type WorkspaceSettings } from "./settings.ts";
import { selectEditorBackend } from "./editor.ts";
import { selectTranscriptBackend } from "./transcript.ts";
import { selectLayoutBackend } from "./layout.ts";
import { showStoredHistory } from "./history-browser.ts";

export { StoredHistory, type StoredEntry, type HistoryScope } from "./stored-history.ts";
export { showStoredHistory } from "./history-browser.ts";

export default function workspaceExtension(pi: ExtensionAPI): void {
    let active: Workspace | undefined;
    let settings: WorkspaceSettings | undefined;
    const reset = (): void => {
        active?.dispose();
        active = undefined;
        settings = undefined;
    };

    const load = (ctx: ExtensionContext): WorkspaceSettings => {
        if (settings !== undefined) return settings;

        const loaded = loadWorkspaceSettings(ctx);
        for (const diagnostic of loaded.diagnostics)
            if (ctx.hasUI) ctx.ui.notify(diagnostic.message, diagnostic.severity);

        settings = loaded.settings;
        return settings;
    };

    const enable = (ctx: ExtensionContext, rebuild = true): void => {
        if (!ctx.hasUI || active !== undefined) return;
        if (!ctx.isIdle()) throw new Error("Workspace activation requires an idle session");

        const current = load(ctx);

        Workspace.assertAvailable();
        selectEditorBackend(current.editor);
        selectTranscriptBackend(current.transcript);
        selectLayoutBackend(current.layout);
        active = new Workspace(ctx, current);
        if (rebuild) active.rebuild();
    };

    pi.on("session_start", (event, ctx) => {
        reset();

        if (!load(ctx).enabled) return;
        try {
            enable(ctx, event.reason === "reload");
        } catch {
            ctx.ui.notify(
                "Workspace could not activate with this host or configured backends.",
                "warning",
            );
        }
    });
    pi.on("session_shutdown", () => reset());
    pi.on("tool_execution_start", (event) => active?.recordToolStart(event.toolCallId));
    pi.on("tool_execution_end", (event) => active?.recordToolEnd(event.toolCallId));
    pi.registerCommand("workspace-on", {
        description: "Enable the replaceable workspace for this session",
        handler: async (_args, ctx) => {
            try {
                enable(ctx);
            } catch {
                ctx.ui.notify(
                    "Workspace activation rejected; wait until idle and check the host or draft-state boundary.",
                    "error",
                );
            }
        },
    });
    pi.registerCommand("workspace-off", {
        description: "Restore the preceding workspace surface",
        handler: async () => {
            active?.dispose();
            active = undefined;
        },
    });
    pi.registerCommand("workspace-editor", {
        description: "Select a complete editor backend",
        handler: async (name, ctx) => {
            try {
                enable(ctx);
                selectEditorBackend(name.trim());
            } catch {
                ctx.ui.notify(
                    "Editor replacement rejected; the current draft was retained.",
                    "error",
                );
            }
        },
    });
    pi.registerCommand("workspace-transcript", {
        description: "Select a transcript backend",
        handler: async (name, ctx) => {
            try {
                enable(ctx);
                selectTranscriptBackend(name.trim());
            } catch {
                ctx.ui.notify("Transcript replacement rejected.", "error");
            }
        },
    });
    pi.registerCommand("workspace-layout", {
        description: "Select a workspace layout backend",
        handler: async (name, ctx) => {
            try {
                enable(ctx);
                selectLayoutBackend(name.trim());
            } catch {
                ctx.ui.notify("Layout replacement rejected.", "error");
            }
        },
    });
    pi.registerCommand("workspace-sidebar", {
        description: "Place the persistent sidebar left, right, or off",
        handler: async (side, ctx) => {
            if (side !== "left" && side !== "right" && side !== "off") {
                ctx.ui.notify("Choose left, right, or off.", "error");
                return;
            }

            enable(ctx);
            settings = { ...load(ctx), sidebarSide: side };
            selectLayoutBackend("sidebar");
            active?.update(settings);
        },
    });
    pi.registerCommand("history-search", {
        description: "Search all stored content without changing the active leaf",
        handler: async (query, ctx) => showStoredHistory(ctx, query),
    });
    pi.registerCommand("workspace-metadata", {
        description: "Open a stored entry by identity without branch navigation",
        handler: async (id, ctx) => showStoredHistory(ctx, "", id.trim()),
    });
}
