import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    registerEditorEnhancer,
    type EditorEnhancerHandle,
    type EditorFactory,
} from "@zigai/pi-extension-internals";

const BASH_EXEC_SPACING_ENHANCER = Symbol.for("zigai.pi-ui-tweaks.bash-exec-spacing-enhancer");
const BASH_EXEC_SPACING_KEY = Symbol.for("zigai.pi-ui-tweaks.bash-exec-spacing");

export type BashExecSpacingConfig = { readonly bashExecPromptSpacing: boolean };

export type BashExecSpacingHandle = {
    update(config: BashExecSpacingConfig): void;
    dispose(): void;
};

export type BashExecSpacingEditorContext = Pick<ExtensionContext, "hasUI"> & {
    ui: Pick<ExtensionContext["ui"], "getEditorComponent" | "setEditorComponent">;
};

export type BashExecSpacingEditor = {
    getCursor(): { line: number; col: number };
    getText(): string;
    handleInput(data: string): void;
    insertTextAtCursor?: (text: string) => void;
    onExtensionShortcut?: (data: string) => boolean;
    requestRenderNow?: () => void;
    setText(text: string): void;
};

type EditorArgs = Parameters<NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>>;
type Editor = ReturnType<NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>>;
type EditorLike = Editor & BashExecSpacingEditor;

type BashExecSpacingRecord = {
    readonly original: EditorFactory<EditorArgs, Editor> | undefined;
    readonly enhancer: EditorEnhancerHandle<EditorArgs, Editor>;
    readonly handle: BashExecSpacingHandle;
};

type MarkedUi = BashExecSpacingEditorContext["ui"] & {
    [BASH_EXEC_SPACING_ENHANCER]?: BashExecSpacingRecord;
};

type EditorMethodView = {
    readonly getCursor?: unknown;
    readonly getText?: unknown;
    readonly handleInput?: unknown;
    readonly setText?: unknown;
};

function isEditorLike(value: Editor): value is EditorLike {
    // SAFETY: Pi's editor factory return type omits extension methods; this view reads only
    // optional members and the predicate verifies every method required by EditorLike.
    const view = value as EditorMethodView;
    return (
        typeof view.getCursor === "function" &&
        typeof view.getText === "function" &&
        typeof view.handleInput === "function" &&
        typeof view.setText === "function"
    );
}

export function applyBashExecPromptSpacing(
    editor: BashExecSpacingEditor,
    data: string,
    config: BashExecSpacingConfig,
): boolean {
    if (!config.bashExecPromptSpacing || data !== "!") return false;

    const cursor = editor.getCursor();
    if (cursor.line !== 0) return false;

    const text = editor.getText();
    if (text.length === 0 && cursor.col === 0) {
        if (typeof editor.insertTextAtCursor === "function") editor.insertTextAtCursor("! ");
        else editor.setText("! ");

        editor.requestRenderNow?.();

        return true;
    }

    if (text === "!" && cursor.col === 1) {
        editor.setText("!! ");
        editor.requestRenderNow?.();
        return true;
    }

    if (text === "! " && (cursor.col === 1 || cursor.col === 2)) {
        editor.setText("!! ");
        editor.requestRenderNow?.();
        return true;
    }

    return false;
}

/** Installs or updates the shared bash-spacing editor enhancer. */
export function installBashExecSpacingEditor(
    ctx: BashExecSpacingEditorContext,
    config: BashExecSpacingConfig,
): BashExecSpacingHandle {
    const ui: MarkedUi = ctx.ui;
    const installed = ui[BASH_EXEC_SPACING_ENHANCER];
    if (installed !== undefined) {
        installed.handle.update(config);
        return installed.handle;
    }

    let current = config;
    const original = ctx.ui.getEditorComponent();
    const enhancer = registerEditorEnhancer(
        ctx,
        BASH_EXEC_SPACING_KEY,
        (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings),
        (editor, tui) => {
            if (!isEditorLike(editor)) return editor;

            editor.requestRenderNow ??= () => tui.requestRender();

            const predecessor = editor.handleInput.bind(editor);

            editor.handleInput = (data: string): void => {
                if (data === "!" && editor.onExtensionShortcut?.(data) === true) return;
                if (!applyBashExecPromptSpacing(editor, data, current)) predecessor(data);
            };

            return editor;
        },
    );
    let disposed = false;
    const handle: BashExecSpacingHandle = {
        update(next): void {
            if (!disposed) current = next;
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            enhancer.dispose();

            if (ui[BASH_EXEC_SPACING_ENHANCER]?.handle === handle)
                delete ui[BASH_EXEC_SPACING_ENHANCER];
        },
    };

    ui[BASH_EXEC_SPACING_ENHANCER] = { original, enhancer, handle };
    return handle;
}
