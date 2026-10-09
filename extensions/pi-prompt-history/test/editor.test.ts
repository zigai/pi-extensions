import assert from "node:assert/strict";
import { test } from "vitest";

import type { UserMessage } from "@earendil-works/pi-ai";
import { CustomEditor, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, type EditorTheme, type Terminal } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { applyPromptHistoryEditor, type PromptHistoryEditorContext } from "../src/editor.ts";

type EditorFactory = NonNullable<
    Parameters<PromptHistoryEditorContext["ui"]["setEditorComponent"]>[0]
>;

type EditorTestContext = {
    readonly ctx: PromptHistoryEditorContext;
    readonly addedPrompts: string[];
    readonly installedFactories: EditorFactory[];
};

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

function editorFactoryArgs(): Parameters<EditorFactory> {
    return [new TuiMainScreen(new FakeTerminal()), editorTheme, new KeybindingsManager()];
}

function userEntry(content: UserMessage["content"], timestamp: number): SessionEntry {
    return {
        id: `entry-${timestamp}`,
        parentId: null,
        timestamp: new Date(timestamp).toISOString(),
        type: "message",
        message: {
            role: "user",
            content,
            timestamp,
        },
    };
}

function createEditorTestContext(branch: SessionEntry[] = [], hasUI = true): EditorTestContext {
    const addedPrompts: string[] = [];
    const installedFactories: EditorFactory[] = [];
    const recordingFactory: EditorFactory = (tui, theme, keybindings) => {
        const editor = new CustomEditor(tui, theme, keybindings);
        editor.addToHistory = (text): void => {
            addedPrompts.push(text);
        };

        return editor;
    };
    const ctx = {
        hasUI,
        sessionManager: {
            getBranch() {
                return branch;
            },
        },
        ui: {
            getEditorComponent() {
                return recordingFactory;
            },
            setEditorComponent(factory: EditorFactory | undefined) {
                if (factory !== undefined) installedFactories.push(factory);
            },
        },
    };

    return {
        ctx,
        addedPrompts,
        installedFactories,
    };
}

test("prompt history preloads prompts from the current branch in branch order", () => {
    const context = createEditorTestContext([
        userEntry("older current prompt", 1),
        userEntry("newer current prompt", 2),
    ]);

    applyPromptHistoryEditor(context.ctx);
    assert.equal(context.installedFactories.length, 1);
    const factory = context.installedFactories.at(0);
    if (factory === undefined) assert.fail("Expected installed editor factory");
    factory(...editorFactoryArgs());
    assert.deepEqual(context.addedPrompts, ["older current prompt", "newer current prompt"]);
});

test("prompt history preserves a configured host editor and its rendering", () => {
    const addedPrompts: string[] = [];
    const hostEditor = {
        render(width: number) {
            if (width <= 0) return [];

            return ["<magic>workflowz</magic>"];
        },
        invalidate() {},
        getText() {
            return "workflowz";
        },
        setText() {},
        handleInput() {},
        addToHistory(text: string) {
            addedPrompts.push(text);
        },
    };
    let installedFactory: EditorFactory | undefined;
    const ctx: PromptHistoryEditorContext = {
        hasUI: true,
        sessionManager: {
            getBranch() {
                return [userEntry("current prompt", 1)];
            },
        },
        ui: {
            getEditorComponent() {
                return () => hostEditor;
            },
            setEditorComponent(factory) {
                installedFactory = factory;
            },
        },
    };

    applyPromptHistoryEditor(ctx);
    assert.notEqual(installedFactory, undefined);
    if (installedFactory === undefined) return;

    const [tui, theme, keybindings] = editorFactoryArgs();
    tui.setFocus(hostEditor);
    const editor = installedFactory(tui, theme, keybindings);
    assert.equal(editor, hostEditor);
    assert.deepEqual(editor.render(80), ["<magic>workflowz</magic>"]);
    assert.deepEqual(addedPrompts, ["current prompt"]);
});

test("prompt history keeps Pi's default editor shortcut hook non-recursive", () => {
    let installedFactory: EditorFactory | undefined;
    const ctx: PromptHistoryEditorContext = {
        hasUI: true,
        sessionManager: {
            getBranch() {
                return [];
            },
        },
        ui: {
            getEditorComponent() {
                return undefined;
            },
            setEditorComponent(factory) {
                installedFactory = factory;
            },
        },
    };

    applyPromptHistoryEditor(ctx);
    assert.notEqual(installedFactory, undefined);
    if (installedFactory === undefined) return;

    const [testTui, theme, keybindings] = editorFactoryArgs();
    const defaultEditor = new CustomEditor(testTui, theme, keybindings);
    testTui.setFocus(defaultEditor);
    const editor = installedFactory(testTui, theme, keybindings);
    assert.equal(editor instanceof CustomEditor, true);
    if (!(editor instanceof CustomEditor)) return;

    // Pi 0.84.3 delegates custom-editor shortcuts to its default editor. Returning that same
    // instance makes the delegate call itself for every key pressed during startup.
    editor.onExtensionShortcut ??= (data) => defaultEditor.onExtensionShortcut?.(data) ?? false;
    assert.doesNotThrow(() => editor.onExtensionShortcut?.("/"));
    assert.notEqual(editor, defaultEditor);
});

test("prompt history does not install an editor without a UI", () => {
    const context = createEditorTestContext([], false);

    applyPromptHistoryEditor(context.ctx);
    assert.equal(context.installedFactories.length, 0);
});
