import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
    copyToClipboard,
    CustomEditor,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerEditorEnhancer, type EditorEnhancerHandle } from "@zigai/pi-extension-internals";

import type { KeymapTweaksConfig } from "./settings-input.ts";
import { cycleThinkingLevelBackward, isThinkingBackwardKeyMatch } from "./thinking-cycle.ts";

const KEYMAP_EDITOR_ENHANCER = Symbol.for("zigai.pi-keymap-tweaks.editor-enhancer");

export type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type EditorFactoryArgs = Parameters<EditorFactory>;
type EditorComponent = ReturnType<EditorFactory>;

type EditorState = {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
};

type EditorAction = "kill" | "type-word" | "yank" | null;

type EditorInternals = {
    state: EditorState;
    historyIndex?: number;
    lastAction: EditorAction;
    setCursorCol(column: number): void;
    pushUndoSnapshot?: () => void;
    exitHistoryBrowsing?: () => void;
};

type ClipboardWriter = (text: string) => Promise<void>;
type Notifier = (message: string, type?: "info" | "warning" | "error") => void;
type ModelProvider = () => Model<Api> | undefined;
type ThinkingLevelProvider = () => ThinkingLevel | undefined;
type ThinkingLevelSetter = (level: ThinkingLevel) => void;
type SettingsProvider = () => KeymapTweaksConfig;

type KeymapEditorOptions = {
    readonly writeClipboard?: ClipboardWriter;
    readonly notify?: Notifier;
    readonly getSettings?: SettingsProvider;
    readonly getModel?: ModelProvider;
    readonly getThinkingLevel?: ThinkingLevelProvider;
    readonly setThinkingLevel?: ThinkingLevelSetter;
};

type EditorLike = ReturnType<EditorFactory> &
    Pick<
        CustomEditor,
        | "getCursor"
        | "getText"
        | "handleInput"
        | "isShowingAutocomplete"
        | "onChange"
        | "onExtensionShortcut"
    > & {
        handleInput(data: string): void;
        requestRenderNow?: () => void;
    };

export type KeymapEditorContext = Pick<ExtensionContext, "hasUI"> & {
    ui: Pick<ExtensionContext["ui"], "getEditorComponent" | "setEditorComponent">;
};

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function isEditorState(value: unknown): value is EditorState {
    if (typeof value !== "object" || value === null) return false;
    return (
        "lines" in value &&
        Array.isArray(value.lines) &&
        value.lines.every(isString) &&
        "cursorLine" in value &&
        typeof value.cursorLine === "number" &&
        "cursorCol" in value &&
        typeof value.cursorCol === "number"
    );
}

function isEditorAction(value: unknown): value is EditorAction {
    return value === null || value === "kill" || value === "type-word" || value === "yank";
}

function hasEditorInternals(editor: EditorLike): editor is EditorLike & EditorInternals {
    if (
        !("state" in editor) ||
        !isEditorState(editor.state) ||
        !("lastAction" in editor) ||
        !isEditorAction(editor.lastAction) ||
        !("setCursorCol" in editor) ||
        typeof editor.setCursorCol !== "function"
    ) {
        return false;
    }

    if (
        "historyIndex" in editor &&
        editor.historyIndex !== undefined &&
        typeof editor.historyIndex !== "number"
    ) {
        return false;
    }

    if (
        "pushUndoSnapshot" in editor &&
        editor.pushUndoSnapshot !== undefined &&
        typeof editor.pushUndoSnapshot !== "function"
    ) {
        return false;
    }

    return (
        !("exitHistoryBrowsing" in editor) ||
        editor.exitHistoryBrowsing === undefined ||
        typeof editor.exitHistoryBrowsing === "function"
    );
}

function isEditorLike(value: ReturnType<EditorFactory>): value is EditorLike {
    return (
        typeof value.handleInput === "function" &&
        typeof value.getText === "function" &&
        "getCursor" in value &&
        typeof value.getCursor === "function" &&
        "isShowingAutocomplete" in value &&
        typeof value.isShowingAutocomplete === "function" &&
        (value.onChange === undefined || typeof value.onChange === "function") &&
        (!("onExtensionShortcut" in value) ||
            value.onExtensionShortcut === undefined ||
            typeof value.onExtensionShortcut === "function") &&
        (!("requestRenderNow" in value) ||
            value.requestRenderNow === undefined ||
            typeof value.requestRenderNow === "function")
    );
}

function moveToCodexLineStart(editor: EditorLike): void {
    if (!hasEditorInternals(editor)) return;

    const state = editor.state;
    editor.lastAction = null;

    if (state.cursorCol === 0 && state.cursorLine > 0) {
        state.cursorLine -= 1;
    }

    editor.setCursorCol(0);
    editor.requestRenderNow?.();
}

function moveToCodexLineEnd(editor: EditorLike): void {
    if (!hasEditorInternals(editor)) return;

    const state = editor.state;
    const currentLine = state.lines[state.cursorLine] || "";

    editor.lastAction = null;
    if (state.cursorCol >= currentLine.length && state.cursorLine < state.lines.length - 1) {
        state.cursorLine += 1;

        const nextLine = state.lines[state.cursorLine] || "";
        editor.setCursorCol(nextLine.length);
        editor.requestRenderNow?.();
        return;
    }

    editor.setCursorCol(currentLine.length);
    editor.requestRenderNow?.();
}

function isBrowsingPromptHistory(editor: EditorLike): boolean {
    return (
        hasEditorInternals(editor) && editor.historyIndex !== undefined && editor.historyIndex > -1
    );
}

function shouldBlockPromptHistoryUp(editor: EditorLike): boolean {
    if (editor.isShowingAutocomplete()) return false;
    if (editor.getText().length === 0) return false;
    if (isBrowsingPromptHistory(editor)) return false;

    const cursor = editor.getCursor();
    return cursor.line === 0 && cursor.col === 0;
}

function deleteCurrentLine(
    editor: EditorLike,
    writeClipboard: ClipboardWriter,
    notify: Notifier,
): void {
    if (!hasEditorInternals(editor)) return;

    const currentLine = editor.state.lines[editor.state.cursorLine] ?? "";

    if (editor.pushUndoSnapshot === undefined) return;

    editor.pushUndoSnapshot();
    editor.exitHistoryBrowsing?.();
    editor.lastAction = null;

    if (editor.state.lines.length === 1) {
        editor.state.lines[0] = "";
        editor.state.cursorLine = 0;
    } else {
        editor.state.lines.splice(editor.state.cursorLine, 1);
        editor.state.cursorLine = Math.min(editor.state.cursorLine, editor.state.lines.length - 1);
    }

    editor.setCursorCol(0);
    editor.onChange?.(editor.getText());
    editor.requestRenderNow?.();

    void writeClipboard(currentLine).catch(() => {
        notify("Could not copy the deleted line to the clipboard", "error");
    });
}

function enhanceEditor(
    editor: EditorLike,
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    requestRender: () => void,
    options: KeymapEditorOptions = {},
): EditorLike {
    const writeClipboard = options.writeClipboard ?? copyToClipboard;
    const notify = options.notify ?? (() => undefined);

    editor.requestRenderNow ??= requestRender;

    const originalHandleInput = editor.handleInput.bind(editor);

    editor.handleInput = (data: string) => {
        if (editor.onExtensionShortcut?.(data) === true) return;

        let configuredThinkingKey: string | null | undefined;
        if (options.getSettings !== undefined) {
            configuredThinkingKey = options.getSettings().cycleThinkingBackwardKey;
        }

        const userBindings = keybindings.getUserBindings();
        const userKeybinding = userBindings["app.thinking.cycleBackward"];
        if (isThinkingBackwardKeyMatch(data, configuredThinkingKey, userKeybinding)) {
            if (
                options.getModel !== undefined &&
                options.getThinkingLevel !== undefined &&
                options.setThinkingLevel !== undefined
            ) {
                const newLevel = cycleThinkingLevelBackward(
                    options.getModel(),
                    options.getThinkingLevel(),
                    options.setThinkingLevel,
                );
                if (newLevel === undefined) {
                    notify("Current model does not support thinking", "warning");
                } else {
                    editor.requestRenderNow?.();
                }

                return;
            }
        }

        if (keybindings.matches(data, "app.models.clearAll")) {
            deleteCurrentLine(editor, writeClipboard, notify);
            return;
        }

        if (
            keybindings.matches(data, "tui.editor.cursorUp") &&
            shouldBlockPromptHistoryUp(editor)
        ) {
            editor.requestRenderNow?.();
            return;
        }

        if (keybindings.matches(data, "tui.editor.cursorLineStart")) {
            moveToCodexLineStart(editor);
            return;
        }

        if (keybindings.matches(data, "tui.editor.cursorLineEnd")) {
            moveToCodexLineEnd(editor);
            return;
        }

        originalHandleInput(data);
    };

    return editor;
}

export function applyKeymapEditor(
    ctx: KeymapEditorContext,
    options: KeymapEditorOptions = {},
): EditorEnhancerHandle<EditorFactoryArgs, EditorComponent> {
    return registerEditorEnhancer(
        ctx,
        KEYMAP_EDITOR_ENHANCER,
        (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings),
        (editor, tui, _theme, keybindings) => {
            if (!isEditorLike(editor)) return editor;
            return enhanceEditor(editor, keybindings, () => tui.requestRender(), options);
        },
    );
}
