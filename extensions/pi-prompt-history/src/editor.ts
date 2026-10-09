import {
    CustomEditor,
    type ExtensionContext,
    type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { registerEditorEnhancer, type EditorEnhancerHandle } from "@zigai/pi-extension-internals";

import { collectUserPromptsFromEntries } from "./prompt-history.ts";

const PROMPT_HISTORY_EDITOR_ENHANCER = Symbol.for("zigai.pi-prompt-history.editor-enhancer");

type EditorArgs = [tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager];
type EditorLike = EditorComponent;

export type PromptHistoryEditorContext = Pick<ExtensionContext, "hasUI"> & {
    sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
    ui: Pick<ExtensionContext["ui"], "getEditorComponent" | "setEditorComponent">;
};

function enhanceEditor(editor: EditorLike, history: string[]): EditorLike {
    for (const prompt of history) {
        editor.addToHistory?.(prompt);
    }

    return editor;
}

function createDefaultEditor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
): EditorLike {
    return new CustomEditor(tui, theme, keybindings);
}

/** Installs an editor preloaded with prompts from the current session branch. */
export function applyPromptHistoryEditor(
    ctx: PromptHistoryEditorContext,
): EditorEnhancerHandle<EditorArgs, EditorLike> {
    if (!ctx.hasUI) {
        return registerEditorEnhancer(
            ctx,
            PROMPT_HISTORY_EDITOR_ENHANCER,
            createDefaultEditor,
            (editor) => editor,
        );
    }

    const currentEntries = ctx.sessionManager.getBranch();
    const currentPrompts = collectUserPromptsFromEntries(currentEntries);

    return registerEditorEnhancer(
        ctx,
        PROMPT_HISTORY_EDITOR_ENHANCER,
        createDefaultEditor,
        (editor) => enhanceEditor(editor, currentPrompts),
    );
}
