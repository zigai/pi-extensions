import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";

import {
    Editor,
    TuiMainScreen as TUI,
    type EditorTheme,
    type Terminal,
} from "@earendil-works/pi-tui";

import {
    continueList,
    installListContinuation,
    type EditorLines,
    type ListContinuationHandle,
} from "../src/list-continuation.ts";

function at(text: string): EditorLines {
    const lines = text.replace("|", "").split("\n");
    const before = text.slice(0, text.indexOf("|")).split("\n");
    return {
        lines,
        cursorLine: before.length - 1,
        cursorCol: before.at(-1)?.length ?? 0,
    };
}

function render(state: EditorLines | undefined): string | undefined {
    if (state === undefined) return undefined;

    const lines = [...state.lines];
    const line = lines[state.cursorLine] ?? "";
    lines[state.cursorLine] = `${line.slice(0, state.cursorCol)}|${line.slice(state.cursorCol)}`;
    return lines.join("\n");
}

function continued(text: string): string | undefined {
    return render(continueList(at(text)));
}

describe("continueList", () => {
    it("leaves lines that are not list items to a plain newline", () => {
        assert.equal(continued("plain text|"), undefined);
        assert.equal(continued("-dash|"), undefined);
        assert.equal(continued("1.5 apples|"), undefined);
        assert.equal(continued("---|"), undefined);
    });

    it("leaves a newline inside the list marker unchanged", () => {
        assert.equal(continued("1|. first"), undefined);
        assert.equal(continued("  |- item"), undefined);
    });

    it("starts the next numbered item with the same delimiter and spacing", () => {
        assert.equal(continued("1. first|"), "1. first\n2. |");
        assert.equal(continued("9) ninth|"), "9) ninth\n10) |");
        assert.equal(continued("3.  wide|"), "3.  wide\n4.  |");
    });

    it("keeps the indentation of nested items", () => {
        assert.equal(continued("1. a\n   1. nested|"), "1. a\n   1. nested\n   2. |");
        assert.equal(continued("  - nested|"), "  - nested\n  - |");
    });

    it("repeats the bullet symbol", () => {
        assert.equal(continued("- one|"), "- one\n- |");
        assert.equal(continued("* one|"), "* one\n* |");
        assert.equal(continued("+ one|"), "+ one\n+ |");
    });

    it("starts an unchecked task after a task item", () => {
        assert.equal(continued("- [x] done|"), "- [x] done\n- [ ] |");
        assert.equal(continued("- [ ] todo|"), "- [ ] todo\n- [ ] |");
    });

    it("moves text after the cursor into the new item", () => {
        assert.equal(continued("- one| two"), "- one\n- |two");
        assert.equal(continued("1. one| two"), "1. one\n2. |two");
    });

    it("ends the list when the item is empty", () => {
        assert.equal(continued("- one\n- |"), "- one\n|");
        assert.equal(continued("1. one\n2. |"), "1. one\n|");
        assert.equal(continued("- [ ] |"), "|");
    });

    it("renumbers the following items of the same list", () => {
        assert.equal(
            continued("1. a|\n2. b\n   - nested\n3. c\n\n1. other"),
            "1. a\n2. |\n3. b\n   - nested\n4. c\n\n1. other",
        );
    });

    it("stops renumbering at items that already have higher numbers", () => {
        assert.equal(continued("1. a|\n5. e"), "1. a\n2. |\n5. e");
    });
});

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

    setProgramStatus(): void {}
}

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

const CTRL_J = "\n";
const UNDO = "\x1f";

describe("installListContinuation", () => {
    let handle: ListContinuationHandle | undefined;

    afterEach(() => {
        handle?.dispose();
        handle = undefined;
    });

    function type(editor: Editor, text: string): void {
        for (const character of text) editor.handleInput(character);
    }

    it("continues a list when Ctrl+J inserts a newline", () => {
        handle = installListContinuation(true);
        const editor = new Editor(new TUI(new FakeTerminal()), editorTheme);

        type(editor, "1. first");
        editor.handleInput(CTRL_J);
        type(editor, "second");
        assert.equal(editor.getText(), "1. first\n2. second");
    });

    it("undoes the continued newline in one step", () => {
        handle = installListContinuation(true);
        const editor = new Editor(new TUI(new FakeTerminal()), editorTheme);

        type(editor, "- one");
        editor.handleInput(CTRL_J);
        editor.handleInput(UNDO);
        assert.equal(editor.getText(), "- one");
    });

    it("inserts a plain newline when disabled", () => {
        handle = installListContinuation(true);
        handle.update(false);
        const editor = new Editor(new TUI(new FakeTerminal()), editorTheme);

        type(editor, "- one");
        editor.handleInput(CTRL_J);
        assert.equal(editor.getText(), "- one\n");
    });

    it("restores the plain newline after disposal", () => {
        installListContinuation(true).dispose();
        const editor = new Editor(new TUI(new FakeTerminal()), editorTheme);

        type(editor, "- one");
        editor.handleInput(CTRL_J);
        assert.equal(editor.getText(), "- one\n");
    });
});
