import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { CustomEditor, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container, TuiMainScreen, type EditorTheme, type Terminal } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
    applyMentionEditor,
    createMentionContinuation,
    type MentionEditorContext,
} from "../src/editor.ts";
import { createChainAutocompleteProvider } from "../src/chain-autocomplete.ts";

type Factory = NonNullable<Parameters<MentionEditorContext["ui"]["setEditorComponent"]>[0]>;

class QuietTerminal implements Terminal {
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

const style = (text: string): string => text;
const theme: EditorTheme = {
    borderColor: style,
    selectList: {
        selectedPrefix: style,
        selectedText: style,
        description: style,
        scrollInfo: style,
        noMatch: style,
    },
};

type Host = {
    ui: TuiMainScreen;
    keybindings: KeybindingsManager;
    defaultEditor: CustomEditor;
    editor: CustomEditor;
    editorContainer: Container;
    editorComponentFactory: Factory | undefined;
    disposeActiveSelector(): void;
};

function createHost(): Host {
    const ui = new TuiMainScreen(new QuietTerminal());
    const keybindings = new KeybindingsManager();
    const defaultEditor = new CustomEditor(ui, theme, keybindings);

    return {
        ui,
        keybindings,
        defaultEditor,
        editor: defaultEditor,
        editorContainer: new Container(),
        editorComponentFactory: undefined,
        disposeActiveSelector() {},
    };
}

function isHostSetter(value: unknown): value is (this: Host, factory: Factory | undefined) => void {
    return typeof value === "function";
}

test("actual Pi editor construction reopens child and paging popups after Tab", async () => {
    vi.useFakeTimers();
    const host = createHost();
    const setter: unknown = Object.getOwnPropertyDescriptor(
        InteractiveMode.prototype,
        "setCustomEditorComponent",
    )?.value;
    assert.ok(isHostSetter(setter));
    const continuation = createMentionContinuation();
    let children = 0;
    let pages = 0;
    const provider = createChainAutocompleteProvider({
        current: {
            getSuggestions: async () => null,
            applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
        },
        sources: [
            {
                id: "tree",
                trigger: "tree:",
                separator: ":",
                completionSuffix: " ",
                filtering: "local",
                discover: async ({ path }) => {
                    let name = "left";
                    if (path.length > 0) {
                        children += 1;
                        name = "right";
                    }

                    return {
                        items: [
                            {
                                id: name,
                                label: name,
                                segment: name,
                                selectable: path.length > 0,
                                navigable: path.length === 0,
                            },
                        ],
                    };
                },
                resolve: async () => ({
                    status: "unresolved",
                    reason: "must retain chosen branch",
                }),
            },
            {
                id: "paged",
                trigger: "page:",
                separator: ":",
                completionSuffix: " ",
                filtering: "provider",
                discover: async ({ cursor }) => {
                    let name = "alpha";
                    if (cursor !== undefined) {
                        pages += 1;
                        name = "beta";
                    }

                    const items = [
                        {
                            id: name,
                            segment: name,
                            label: name,
                            selectable: true,
                            navigable: false,
                        },
                    ];
                    if (cursor === undefined) return { items, nextCursor: "next" };

                    return { items };
                },
                resolve: async () => ({ status: "unresolved", reason: "unused" }),
            },
        ],
        onContinue: () => continuation.request(),
    });
    const handle = applyMentionEditor(
        {
            hasUI: true,
            ui: {
                getEditorComponent: () => host.editorComponentFactory,
                setEditorComponent: (factory) => setter.call(host, factory),
            },
        },
        {
            key: Symbol.for("zigai.mention.test.actual-host-continuation"),
            continuation,
            isMentionContext: (line) => /^(?:tree:|page:)/.test(line),
            colorLine: (line) => line,
            onTextChange: (text) => provider.reconcile(text),
        },
    );
    try {
        host.editor.setAutocompleteProvider(provider);
        host.editor.handleInput("tree:");
        await vi.advanceTimersByTimeAsync(250);
        assert.equal(host.editor.isShowingAutocomplete(), true);
        host.editor.handleInput("\t");
        assert.equal(host.editor.getText(), "tree:left:");
        await vi.advanceTimersByTimeAsync(250);
        assert.equal(children, 1);
        assert.equal(
            host.editor.isShowingAutocomplete(),
            true,
            "branch Tab must reopen real editor popup",
        );

        host.editor.handleInput("\r");
        assert.equal(host.editor.getText(), "tree:left:right ");

        while (host.editor.getCursor().col > 9) host.editor.handleInput("\u001b[D");
        host.editor.handleInput("\u007f");
        await vi.advanceTimersByTimeAsync(250);
        assert.equal(host.editor.isShowingAutocomplete(), true);
        host.editor.handleInput("\t");
        assert.equal(
            host.editor.getText(),
            "tree:left: ",
            "parent completion must discard descendants",
        );
        await vi.advanceTimersByTimeAsync(250);
        assert.equal(
            host.editor.isShowingAutocomplete(),
            true,
            "edited parent must reopen its children",
        );

        host.editor.handleInput("\u001b");
        host.editor.setText("");
        host.editor.handleInput("page:");
        await vi.advanceTimersByTimeAsync(250);
        assert.equal(host.editor.isShowingAutocomplete(), true);
        host.editor.handleInput("\u001b[B");
        host.editor.handleInput("\t");
        assert.equal(host.editor.getText(), "page:");
        await vi.advanceTimersByTimeAsync(250);
        assert.equal(pages, 1);
        assert.equal(
            host.editor.isShowingAutocomplete(),
            true,
            "More must reopen without a text change",
        );

        host.editor.handleInput("\u001b[B");
        host.editor.handleInput("\r");
        assert.equal(host.editor.getText(), "page:beta ");
    } finally {
        provider.dispose();
        handle.dispose();
        vi.useRealTimers();
    }
});
