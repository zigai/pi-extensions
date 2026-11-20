import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installCancelUndo, type CancelUndoHandle } from "./cancel-undo.ts";
import { applyKeymapEditor } from "./editor-keymap.ts";
import { installListContinuation, type ListContinuationHandle } from "./list-continuation.ts";
import { loadKeymapTweaksSettings, type LoadedKeymapTweaksConfig } from "./settings.ts";
import { applySubmitModeKeymap } from "./submit-mode-patch.ts";

let editorHandle: { dispose(): void } | undefined;
let submitModeHandle: { dispose(): void } | undefined;
let listContinuationHandle: ListContinuationHandle | undefined;
let cancelUndoHandle: CancelUndoHandle | undefined;
let sessionSettings: LoadedKeymapTweaksConfig | undefined;

export default function piKeymap(pi: ExtensionAPI): void {
    submitModeHandle?.dispose();
    submitModeHandle = applySubmitModeKeymap();

    pi.on("session_start", async (_event, ctx) => {
        sessionSettings = loadKeymapTweaksSettings(ctx.cwd, ctx.isProjectTrusted());
        if (ctx.hasUI && sessionSettings.errors.length > 0) {
            for (const error of sessionSettings.errors) {
                ctx.ui.notify(error, "error");
            }
        }

        const { config } = sessionSettings;
        listContinuationHandle?.dispose();
        listContinuationHandle = installListContinuation(config.continueLists);
        cancelUndoHandle?.dispose();
        cancelUndoHandle = installCancelUndo(config.undoEarlyCancel);

        editorHandle?.dispose();
        editorHandle = applyKeymapEditor(ctx, {
            notify: (message, type) => ctx.ui.notify(message, type),
            getSettings: () => {
                if (sessionSettings !== undefined) {
                    return sessionSettings.config;
                }

                return loadKeymapTweaksSettings(ctx.cwd, ctx.isProjectTrusted()).config;
            },
            getModel: () => ctx.model,
            getThinkingLevel: () => pi.getThinkingLevel(),
            setThinkingLevel: (level) => pi.setThinkingLevel(level),
        });
    });

    pi.on("session_shutdown", () => {
        editorHandle?.dispose();
        editorHandle = undefined;
        cancelUndoHandle?.dispose();
        cancelUndoHandle = undefined;
        listContinuationHandle?.dispose();
        listContinuationHandle = undefined;
        submitModeHandle?.dispose();
        submitModeHandle = undefined;
        sessionSettings = undefined;
    });
}
