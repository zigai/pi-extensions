import assert from "node:assert/strict";
import { test } from "vitest";

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, type EditorTheme, type Terminal } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";

import {
    applyMentionEditor,
    createMentionContinuation,
    type MentionEditorContext,
} from "../src/editor.ts";

type EditorFactory = NonNullable<Parameters<MentionEditorContext["ui"]["setEditorComponent"]>[0]>;

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

function createEditor(options: Parameters<typeof applyMentionEditor>[1]): CustomEditor {
    let installedFactory: EditorFactory | undefined;
    const ctx: MentionEditorContext = {
        hasUI: true,
        ui: {
            getEditorComponent() {
                return undefined;
            },
            setEditorComponent(factory) {
                installedFactory = factory;
            },
        },
    };
    applyMentionEditor(ctx, options);

    if (installedFactory === undefined) assert.fail("Expected an installed editor factory");

    const tui = new TuiMainScreen(new FakeTerminal());
    const editor = installedFactory(tui, editorTheme, new KeybindingsManager());
    if (editor instanceof CustomEditor) {
        tui.setFocus(editor);
        return editor;
    }

    return assert.fail("Expected a CustomEditor");
}

function deferred() {
    let resolve = (): void => {};

    // Promise.withResolvers is unavailable under the repository's ES2023 library target.
    const promise = new Promise<void>((done) => {
        resolve = done;
    });

    return { promise, resolve };
}

test("mention continuation is a one-shot request", () => {
    const continuation = createMentionContinuation();
    assert.equal(continuation.consume(), false);
    continuation.request();
    continuation.request();
    assert.equal(continuation.consume(), true);
    assert.equal(continuation.consume(), false);
});

test("editor mention context and text changes use the actual cursor line", async () => {
    const contexts: string[] = [];
    const changes: string[] = [];
    let requests = 0;

    const editor = createEditor({
        key: Symbol.for("zigai.pi-mention-anything.test.actual-cursor"),
        isMentionContext(line) {
            contexts.push(line);
            return line.startsWith("t:");
        },
        colorLine: identityStyle,
        onTextChange(text) {
            changes.push(text);
        },
    });
    editor.setAutocompleteProvider({
        async getSuggestions() {
            requests += 1;
            return { prefix: "", items: [] };
        },
        applyCompletion(lines, cursorLine, cursorCol) {
            return { lines, cursorLine, cursorCol };
        },
    });
    editor.setText("t:\nlast");
    editor.handleInput("\u001b[A");
    editor.handleInput("x");
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
    assert.deepEqual(contexts, ["t:x"]);
    assert.deepEqual(changes, ["t:x\nlast"]);
    assert.equal(requests, 1);
});

test("captures submitted text before outer text-change reconciliation and restores onSubmit", () => {
    const events: string[] = [];
    const editor = createEditor({
        key: Symbol.for("zigai.pi-mention-anything.test.submit-capture"),
        isMentionContext: () => false,
        colorLine: identityStyle,
        onSubmitText(text) {
            events.push(`capture:${text}`);
        },
        onTextChange(text) {
            events.push(`change:${text}`);
        },
    });
    const hostOnSubmit = (text: string): void => {
        events.push(`host:${text}`);
    };
    editor.onSubmit = hostOnSubmit;
    editor.setText("first\nlast");
    editor.handleInput("\r");
    assert.deepEqual(events, ["capture:first\nlast", "host:first\nlast", "change:"]);
    assert.equal(editor.onSubmit, hostOnSubmit);
    assert.equal(editor.getText(), "");
});

test("new-line input does not capture a submission", () => {
    const submitted: string[] = [];
    const editor = createEditor({
        key: Symbol.for("zigai.pi-mention-anything.test.multiline"),
        isMentionContext: () => false,
        colorLine: identityStyle,
        onSubmitText(text) {
            submitted.push(text);
        },
    });
    editor.setText("first");
    editor.handleInput("\n");
    assert.deepEqual(submitted, []);
    assert.equal(editor.getText(), "first\n");
});

test("autocomplete confirmation does not capture a prompt submission", async () => {
    const submitted: string[] = [];
    const editor = createEditor({
        key: Symbol.for("zigai.pi-mention-anything.test.autocomplete-submit"),
        isMentionContext: (line) => line.startsWith("t:"),
        colorLine: identityStyle,
        onSubmitText(text) {
            submitted.push(text);
        },
    });
    editor.setAutocompleteProvider({
        async getSuggestions() {
            return { prefix: "", items: [{ value: "work", label: "work" }] };
        },
        applyCompletion() {
            return { lines: ["t:work"], cursorLine: 0, cursorCol: 6 };
        },
    });

    editor.handleInput("t:");
    await Promise.resolve();
    await Promise.resolve();
    editor.handleInput("\r");
    assert.deepEqual(submitted, []);
    assert.equal(editor.getText(), "t:work");
});

test("Escape closes mention autocomplete without immediately reopening it", async () => {
    let requests = 0;

    const editor = createEditor({
        key: Symbol.for("zigai.pi-mention-anything.test.escape"),
        isMentionContext: (line) => line.startsWith("t:"),
        colorLine: identityStyle,
    });
    editor.setAutocompleteProvider({
        async getSuggestions() {
            requests += 1;
            return { prefix: "", items: [{ value: "work", label: "work" }] };
        },
        applyCompletion(lines, cursorLine, cursorCol) {
            return { lines, cursorLine, cursorCol };
        },
    });

    editor.handleInput("t:");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(editor.isShowingAutocomplete(), true);
    editor.handleInput("\u001b");
    await Promise.resolve();
    assert.equal(editor.getText(), "t:");
    assert.equal(editor.isShowingAutocomplete(), false);
    assert.equal(requests, 1);
});

test("editor consumes branch continuation after Pi closes the selected popup", async () => {
    const reopened = deferred();
    const continuation = createMentionContinuation();
    let requests = 0;

    const editor = createEditor({
        key: Symbol.for("zigai.pi-mention-anything.test.continuation"),
        isMentionContext: (line) => line.startsWith("t:"),
        colorLine: identityStyle,
        continuation,
    });
    editor.setAutocompleteProvider({
        async getSuggestions() {
            requests += 1;
            if (requests === 2) reopened.resolve();
            return { prefix: "", items: [{ value: "work", label: "work" }] };
        },
        applyCompletion() {
            continuation.request();
            return { lines: ["t:work:"], cursorLine: 0, cursorCol: 7 };
        },
    });

    editor.handleInput("t:");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(editor.isShowingAutocomplete(), true);
    editor.handleInput("\t");
    await reopened.promise;
    await Promise.resolve();
    assert.equal(editor.getText(), "t:work:");
    assert.equal(requests, 2);
    assert.equal(editor.isShowingAutocomplete(), true);
});
