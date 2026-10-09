import assert from "node:assert/strict";
import { test } from "vitest";

import {
    applyBashExecPromptSpacing,
    type BashExecSpacingEditor,
} from "../src/bash-exec-spacing.ts";

type CursorPosition = {
    readonly line: number;
    readonly col: number;
};

class TestEditor implements BashExecSpacingEditor {
    text: string;
    renderRequests = 0;

    constructor(text = "") {
        this.text = text;
    }

    getCursor(): CursorPosition {
        return { line: 0, col: this.text.length } satisfies CursorPosition;
    }

    getText(): string {
        return this.text;
    }

    handleInput(): void {}

    insertTextAtCursor(text: string): void {
        this.text += text;
    }

    requestRenderNow(): void {
        this.renderRequests += 1;
    }

    setText(text: string): void {
        this.text = text;
    }
}

test("bash exec prompt spacing handles empty and excluded bang prefixes", () => {
    const empty = new TestEditor();
    assert.equal(applyBashExecPromptSpacing(empty, "!", { bashExecPromptSpacing: true }), true);
    assert.equal(empty.text, "! ");
    assert.equal(empty.renderRequests, 1);
    const excluded = new TestEditor("! ");
    assert.equal(applyBashExecPromptSpacing(excluded, "!", { bashExecPromptSpacing: true }), true);
    assert.equal(excluded.text, "!! ");
});

test("bash exec prompt spacing leaves input alone when disabled", () => {
    const editor = new TestEditor();
    assert.equal(applyBashExecPromptSpacing(editor, "!", { bashExecPromptSpacing: false }), false);
    assert.equal(editor.text, "");
});
