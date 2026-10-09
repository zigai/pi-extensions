import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerEditorEnhancer, type EditorEnhancerHandle } from "@zigai/pi-extension-internals";

import { autocompleteStartIndex } from "./rendering.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type EditorLike = ReturnType<EditorFactory>;

type AutocompleteVisibility = {
    isShowingAutocomplete(): boolean;
};

type AutocompleteTrigger = {
    tryTriggerAutocomplete(): void;
};

type CursorAccess = {
    getCursor(): { readonly line: number; readonly col: number };
    getLines(): string[];
};

type SubmitAccess = {
    onSubmit?: (text: string) => void;
};

export type MentionContinuation = {
    request(): void;
    consume(): boolean;
};

export type MentionEditorContext = Pick<ExtensionContext, "hasUI"> & {
    readonly ui: Pick<ExtensionContext["ui"], "getEditorComponent" | "setEditorComponent">;
};

export type MentionEditorOptions = {
    readonly key: symbol;
    readonly isMentionContext: (line: string) => boolean;
    readonly colorLine: (line: string) => string;
    readonly continuation?: MentionContinuation;
    readonly onTextChange?: (text: string) => void;
    readonly onSubmitText?: (text: string) => void;
};

function hasAutocompleteVisibility(
    editor: EditorLike,
): editor is EditorLike & AutocompleteVisibility {
    return "isShowingAutocomplete" in editor && typeof editor.isShowingAutocomplete === "function";
}

function hasAutocompleteTrigger(editor: EditorLike): editor is EditorLike & AutocompleteTrigger {
    return (
        "tryTriggerAutocomplete" in editor && typeof editor.tryTriggerAutocomplete === "function"
    );
}

function hasCursorAccess(editor: EditorLike): editor is EditorLike & CursorAccess {
    return (
        "getCursor" in editor &&
        typeof editor.getCursor === "function" &&
        "getLines" in editor &&
        typeof editor.getLines === "function"
    );
}

function hasSubmitAccess(editor: EditorLike): editor is EditorLike & SubmitAccess {
    return "onSubmit" in editor;
}

function isShowingAutocomplete(editor: EditorLike): boolean {
    return hasAutocompleteVisibility(editor) && editor.isShowingAutocomplete();
}

function tryTriggerAutocomplete(editor: EditorLike): void {
    if (hasAutocompleteTrigger(editor)) editor.tryTriggerAutocomplete();
}

export function createMentionContinuation(): MentionContinuation {
    let requested = false;

    return {
        request() {
            requested = true;
        },
        consume() {
            const result = requested;
            requested = false;
            return result;
        },
    };
}

function handleInputWithSubmitCapture(
    editor: EditorLike,
    originalHandleInput: (data: string) => void,
    data: string,
    onSubmitText: ((text: string) => void) | undefined,
): void {
    if (onSubmitText === undefined || !hasSubmitAccess(editor)) {
        originalHandleInput(data);
        return;
    }

    const originalOnSubmit = editor.onSubmit;
    const capturedOnSubmit = (text: string): void => {
        onSubmitText(text);
        originalOnSubmit?.(text);
    };

    editor.onSubmit = capturedOnSubmit;

    try {
        originalHandleInput(data);
    } finally {
        if (editor.onSubmit === capturedOnSubmit) editor.onSubmit = originalOnSubmit;
    }
}

function enhanceEditor(editor: EditorLike, options: MentionEditorOptions): EditorLike {
    const originalHandleInput = editor.handleInput.bind(editor);

    editor.handleInput = (data: string) => {
        const textBeforeInput = editor.getText();
        const autocompleteWasShowing = isShowingAutocomplete(editor);

        handleInputWithSubmitCapture(editor, originalHandleInput, data, options.onSubmitText);

        const text = editor.getText();
        const textChanged = text !== textBeforeInput;
        if (textChanged) options.onTextChange?.(text);

        if (options.continuation?.consume() === true) {
            if (!isShowingAutocomplete(editor)) tryTriggerAutocomplete(editor);
            return;
        }

        if (autocompleteWasShowing || isShowingAutocomplete(editor)) return;

        if (!textChanged) {
            const inputCharacters = Array.from(data);
            if (inputCharacters.length !== 1 || /[\p{C}\s]/u.test(inputCharacters[0] ?? "")) return;
        }

        let currentLine = text.split("\n").at(-1) ?? "";
        if (hasCursorAccess(editor)) {
            const cursor = editor.getCursor();
            currentLine = editor.getLines()[cursor.line] ?? "";
            currentLine = currentLine.slice(0, cursor.col);
        }

        if (!options.isMentionContext(currentLine)) return;

        tryTriggerAutocomplete(editor);
    };

    const originalRender = editor.render.bind(editor);

    editor.render = (width: number): string[] => {
        const renderedLines = originalRender(width);
        let colorThrough = renderedLines.length;
        if (isShowingAutocomplete(editor)) colorThrough = autocompleteStartIndex(renderedLines);
        return renderedLines.map((line, index) => {
            if (index >= colorThrough) return line;
            return options.colorLine(line);
        });
    };

    return editor;
}

export function applyMentionEditor(
    ctx: MentionEditorContext,
    options: MentionEditorOptions,
): EditorEnhancerHandle<Parameters<EditorFactory>, EditorLike> {
    return registerEditorEnhancer(
        ctx,
        options.key,
        (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings),
        (editor) => enhanceEditor(editor, options),
    );
}
