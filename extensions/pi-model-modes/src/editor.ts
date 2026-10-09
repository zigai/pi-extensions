import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { registerEditorEnhancer } from "@zigai/pi-extension-internals";

import type { ModeController } from "./mode-controller.ts";

const MODE_EDITOR_ENHANCER = Symbol.for("zigai.pi-model-modes.editor-enhancer");

type EditorLike = EditorComponent & {
    borderColor: (text: string) => string;
    getText(): string;
};

function isEditorLike(value: EditorComponent): value is EditorLike {
    return (
        "borderColor" in value &&
        typeof value.borderColor === "function" &&
        "getText" in value &&
        typeof value.getText === "function"
    );
}

export function applyModeEditor(
    controller: ModeController,
    ctx: ExtensionContext,
): { dispose(): void } | undefined {
    if (!ctx.hasUI) return undefined;
    return registerEditorEnhancer(
        ctx,
        MODE_EDITOR_ENHANCER,
        (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings),
        (editor, tui) => {
            if (!isEditorLike(editor)) return editor;

            const defaultBorderColor = editor.borderColor;
            const borderColor = (text: string): string => {
                if (editor.getText().trimStart().startsWith("!")) {
                    return ctx.ui.theme.getBashModeBorderColor()(text);
                }

                return controller.getModeBorderColor(
                    ctx,
                    controller.currentMode,
                    defaultBorderColor,
                )(text);
            };

            Object.defineProperty(editor, "borderColor", {
                get: () => borderColor,
                set: () => {},
                configurable: true,
                enumerable: true,
            });

            controller.setEditorRenderRequest(() => tui.requestRender());

            return editor;
        },
    );
}
