import assert from "node:assert/strict";
import { test } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    TuiMainScreen as TUI,
    type EditorComponent,
    type EditorTheme,
    type Terminal,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { applyKeymapEditor, type KeymapEditorContext } from "../src/editor-keymap.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const CTRL_X = "\x18";

class FakeTerminal implements Terminal {
    columns = 80;
    rows = 24;

    get kittyProtocolActive(): boolean {
        return false;
    }

    start(): void {}

    stop(): void {}

    async drainInput(): Promise<void> {}

    write(): void {}

    moveBy(): void {}

    hideCursor(): void {}

    showCursor(): void {}

    clearLine(): void {}

    clearFromCursor(): void {}

    clearScreen(): void {}

    setTitle(): void {}

    setProgress(): void {}
}

type TestEditor = EditorComponent & {
    addToHistory(text: string): void;
    getCursor(): { line: number; col: number };
};

function isTestEditor(editor: EditorComponent): editor is TestEditor {
    return (
        typeof editor.addToHistory === "function" &&
        "getCursor" in editor &&
        typeof editor.getCursor === "function"
    );
}

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

const identityStyle = (text: string): string => text;
const editorTheme: EditorTheme = {
    borderColor: identityStyle,
    selectList: {
        selectedPrefix: identityStyle,
        selectedText: identityStyle,
        description: identityStyle,
        scrollInfo: identityStyle,
        noMatch: identityStyle,
    },
};

type ClipboardWriter = (text: string) => Promise<void>;

function createKeymapEditor(writeClipboard?: ClipboardWriter): TestEditor {
    let editorFactory: EditorFactory | undefined;
    const context = {
        hasUI: true,
        ui: {
            getEditorComponent() {
                return editorFactory;
            },
            setEditorComponent(nextFactory: EditorFactory | undefined): void {
                editorFactory = nextFactory;
            },
        },
    } satisfies KeymapEditorContext;

    applyKeymapEditor(context, { writeClipboard });

    if (editorFactory === undefined) {
        assert.fail("expected editor factory");
    }

    const tui = new TUI(new FakeTerminal());
    const editor = editorFactory(tui, editorTheme, new KeybindingsManager());
    if (!isTestEditor(editor)) {
        throw new Error("Expected CustomEditor test seam");
    }

    return editor;
}

function renderEditor(editor: TestEditor): void {
    editor.render(80);
}

test("ctrl+x copies and deletes the current line", async () => {
    const copiedLines: string[] = [];
    const editor = createKeymapEditor(async (text) => {
        copiedLines.push(text);
    });
    editor.setText("first\nsecond\nthird");
    renderEditor(editor);

    editor.handleInput(UP);
    renderEditor(editor);
    editor.handleInput(CTRL_X);
    renderEditor(editor);
    assert.equal(editor.getText(), "first\nthird");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
    assert.deepEqual(copiedLines, ["second"]);
});

test("up arrow does not recall prompt history from a non-empty draft", () => {
    const editor = createKeymapEditor();
    editor.addToHistory("previous prompt");
    editor.setText("line one\nline two");
    renderEditor(editor);

    editor.handleInput(UP);
    renderEditor(editor);
    editor.handleInput(UP);
    renderEditor(editor);
    editor.handleInput(UP);
    renderEditor(editor);
    assert.equal(editor.getText(), "line one\nline two");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
});

test("up arrow still recalls prompt history when the editor is empty", () => {
    const editor = createKeymapEditor();
    editor.addToHistory("older prompt");
    editor.addToHistory("newer prompt");
    renderEditor(editor);

    editor.handleInput(UP);
    renderEditor(editor);
    assert.equal(editor.getText(), "newer prompt");
    editor.handleInput(UP);
    renderEditor(editor);
    assert.equal(editor.getText(), "older prompt");
    editor.handleInput(DOWN);
    renderEditor(editor);
    assert.equal(editor.getText(), "newer prompt");
});

test("leaves third-party editors without the required navigation seam unchanged", () => {
    const inputs: string[] = [];
    const thirdPartyEditor = {
        getText() {
            return "draft";
        },
        handleInput(data: string) {
            inputs.push(data);
        },
        invalidate() {},
        render() {
            return [];
        },
        setText() {},
    } satisfies EditorComponent;
    let editorFactory: EditorFactory | undefined = () => thirdPartyEditor;
    const context = {
        hasUI: true,
        ui: {
            getEditorComponent() {
                return editorFactory;
            },
            setEditorComponent(nextFactory: EditorFactory | undefined) {
                editorFactory = nextFactory;
            },
        },
    } satisfies KeymapEditorContext;

    applyKeymapEditor(context);
    const appliedFactory = context.ui.getEditorComponent();
    if (appliedFactory === undefined) assert.fail("expected editor factory");

    const editor = appliedFactory(
        new TUI(new FakeTerminal()),
        editorTheme,
        new KeybindingsManager(),
    );
    editor.handleInput(UP);
    assert.equal(editor, thirdPartyEditor);
    assert.deepEqual(inputs, [UP]);
});
