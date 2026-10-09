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
import {
    installBashExecSpacingEditor,
    type BashExecSpacingEditorContext,
} from "../src/bash-exec-spacing.ts";
import {
    installPasteCollapseEditor,
    installPasteCollapsePatch,
    type PasteCollapseEditorContext,
    type PasteCollapseSettings,
} from "../src/paste-collapse.ts";

const TOOL_EXPAND = "\x0f";
const CUSTOM_EXPAND = "\x05";

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
    getExpandedText(): string;
    getText(): string;
    handleInput(data: string): void;
};

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

const defaultSettings: PasteCollapseSettings = {
    pasteCollapseCharThreshold: 1000,
    pasteCollapseEnabled: true,
    pasteCollapseExpandKey: null,
    pasteCollapseLineThreshold: 10,
    pasteCollapseUseToolExpandKey: true,
};

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

function isTestEditor(value: EditorComponent): value is TestEditor {
    return typeof value.getExpandedText === "function";
}

function getTestEditor(value: EditorComponent): TestEditor {
    if (!isTestEditor(value)) throw new Error("Expected CustomEditor expanded-text seam");
    return value;
}

let currentTestSettings = defaultSettings;
const pasteHandles = new Set<{ update(settings: PasteCollapseSettings): void }>();

function setTestSettings(settings: Partial<PasteCollapseSettings>): void {
    currentTestSettings = { ...defaultSettings, ...settings };
    for (const handle of pasteHandles) handle.update(currentTestSettings);
}

function withSettings(settings: Partial<PasteCollapseSettings>, run: () => void): void {
    setTestSettings(settings);
    try {
        run();
    } finally {
        setTestSettings(defaultSettings);
    }
}

function createPasteCollapseEditor(): TestEditor {
    pasteHandles.add(installPasteCollapsePatch(currentTestSettings));
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
    } satisfies PasteCollapseEditorContext;

    pasteHandles.add(installPasteCollapseEditor(context, currentTestSettings));

    if (editorFactory === undefined) {
        assert.fail("expected editor factory");
    }

    const tui = new TUI(new FakeTerminal());
    return getTestEditor(editorFactory(tui, editorTheme, new KeybindingsManager()));
}

function paste(text: string): string {
    return `\x1b[200~${text}\x1b[201~`;
}

test("large paste collapse can be disabled", () => {
    withSettings({ pasteCollapseEnabled: false }, () => {
        const editor = createPasteCollapseEditor();
        const pastedText = Array.from({ length: 20 }, (_value, index) => `line ${index}`).join(
            "\n",
        );

        editor.handleInput(paste(pastedText));
        assert.equal(editor.getText(), pastedText);
        assert.equal(editor.getExpandedText(), pastedText);
    });
});

test("paste collapse thresholds are configurable", () => {
    withSettings({ pasteCollapseCharThreshold: 5, pasteCollapseLineThreshold: 99 }, () => {
        const editor = createPasteCollapseEditor();

        editor.handleInput(paste("abcdef"));
        assert.equal(editor.getText(), "[paste #1 6 chars]");
        assert.equal(editor.getExpandedText(), "abcdef");
    });

    withSettings({ pasteCollapseCharThreshold: 999, pasteCollapseLineThreshold: 1 }, () => {
        const editor = createPasteCollapseEditor();

        editor.handleInput(paste("one\ntwo"));
        assert.equal(editor.getText(), "[paste #1 +2 lines]");
        assert.equal(editor.getExpandedText(), "one\ntwo");
    });
});

test("custom expand key expands the paste marker under the cursor", () => {
    withSettings(
        {
            pasteCollapseExpandKey: "ctrl+e",
            pasteCollapseLineThreshold: 1,
            pasteCollapseUseToolExpandKey: false,
        },
        () => {
            const editor = createPasteCollapseEditor();
            editor.handleInput(paste("one\ntwo"));
            editor.handleInput(CUSTOM_EXPAND);
            assert.equal(editor.getText(), "one\ntwo");
            assert.equal(editor.getExpandedText(), "one\ntwo");
        },
    );
});

test("tool expand key expands only the marker under the cursor", () => {
    withSettings({ pasteCollapseLineThreshold: 1 }, () => {
        const editor = createPasteCollapseEditor();
        editor.handleInput(paste("one\ntwo"));
        editor.handleInput(" ");
        editor.handleInput(paste("three\nfour"));
        editor.handleInput(TOOL_EXPAND);
        assert.equal(editor.getText(), "[paste #1 +2 lines] three\nfour");
        assert.equal(editor.getExpandedText(), "one\ntwo three\nfour");
    });
});

test("tool expand key falls through when no paste marker is under the cursor", () => {
    withSettings({}, () => {
        const baseInputs: string[] = [];
        const baseFactory: EditorFactory = () => ({
            getCursor() {
                return { line: 0, col: 0 };
            },
            getText() {
                return "";
            },
            handleInput(data: string) {
                baseInputs.push(data);
            },
            invalidate() {},
            render() {
                return [];
            },
            setText() {},
        });

        let editorFactory: EditorFactory | undefined = baseFactory;
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
        } satisfies PasteCollapseEditorContext;
        pasteHandles.add(installPasteCollapseEditor(context, currentTestSettings));
        const installedFactory = context.ui.getEditorComponent();
        if (installedFactory === undefined) assert.fail("expected editor factory");

        const editor = installedFactory(
            new TUI(new FakeTerminal()),
            editorTheme,
            new KeybindingsManager(),
        );
        editor.handleInput(TOOL_EXPAND);
        assert.deepEqual(baseInputs, [TOOL_EXPAND]);
    });
});

test("editor wrappers remain idempotent across repeated session starts", () => {
    withSettings({}, () => {
        let shortcutChecks = 0;
        const baseInputs: string[] = [];
        const baseFactory: EditorFactory = () => {
            const editor = {
                handleInput(data: string): void {
                    baseInputs.push(data);
                },
                getCursor() {
                    return { line: 0, col: 0 };
                },
                getText() {
                    return "";
                },
                setText() {},
                render() {
                    return [];
                },
                invalidate() {},
                onExtensionShortcut(data: string): boolean {
                    if (data === TOOL_EXPAND) {
                        shortcutChecks += 1;
                    }

                    return false;
                },
            } satisfies EditorComponent & {
                getCursor(): { line: number; col: number };
                onExtensionShortcut(data: string): boolean;
            };

            return editor;
        };

        let editorFactory: EditorFactory | undefined = baseFactory;
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
        } satisfies PasteCollapseEditorContext & BashExecSpacingEditorContext;

        installBashExecSpacingEditor(context, { bashExecPromptSpacing: true });
        pasteHandles.add(installPasteCollapseEditor(context, currentTestSettings));
        installBashExecSpacingEditor(context, { bashExecPromptSpacing: true });
        pasteHandles.add(installPasteCollapseEditor(context, currentTestSettings));

        const installedFactory = context.ui.getEditorComponent();
        if (installedFactory === undefined) {
            assert.fail("expected editor factory");
        }

        const tui = new TUI(new FakeTerminal());
        const editor = installedFactory(tui, editorTheme, new KeybindingsManager());
        editor.handleInput(TOOL_EXPAND);
        assert.equal(shortcutChecks, 1);
        assert.deepEqual(baseInputs, [TOOL_EXPAND]);
    });
});
