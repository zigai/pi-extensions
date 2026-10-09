import assert from "node:assert/strict";
import { test } from "vitest";

import {
    Container,
    ScrollView,
    TuiAltScreen,
    TuiMainScreen as TUI,
    VStack,
    type Component,
    type Terminal,
} from "@earendil-works/pi-tui";
import { installAnchorInputToBottomPatch } from "../src/anchor-input-to-bottom.ts";

class FakeTerminal implements Terminal {
    columns = 30;
    rows = 10;
    writes: string[] = [];

    get kittyProtocolActive(): boolean {
        return false;
    }

    start(): void {}

    stop(): void {}

    async drainInput(): Promise<void> {}

    write(data: string): void {
        this.writes.push(data);
    }

    moveBy(): void {}

    hideCursor(): void {}

    showCursor(): void {}

    clearLine(): void {}

    clearFromCursor(): void {}

    clearScreen(): void {}

    setTitle(): void {}

    setProgress(): void {}
}

class FixedLines implements Component {
    private readonly lines: string[];

    constructor(lines: string[]) {
        this.lines = lines;
    }

    render(): string[] {
        return this.lines;
    }

    invalidate(): void {}
}

class InheritedChildrenContainer implements Component {
    constructor(private readonly child: Component) {}

    get children(): Component[] {
        return [this.child];
    }

    render(width: number): string[] {
        return this.child.render(width);
    }

    invalidate(): void {}
}

class TestEditor implements Component {
    render(): string[] {
        return ["EDITOR TOP", "EDITOR BODY", "EDITOR BOTTOM"];
    }

    invalidate(): void {}
}

function stripTerminalLineReset(line: string): string {
    return line.replaceAll("\u001b[0m\u001b]8;;\u0007", "");
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function isScreenLines(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(isString);
}

function getFullscreenScreen(tui: TuiAltScreen): string[] {
    const previousScreen: unknown = Object.getOwnPropertyDescriptor(tui, "previousScreen")?.value;
    if (!isScreenLines(previousScreen)) {
        throw new Error("Expected fullscreen TUI render internals.");
    }

    return previousScreen;
}

function createFullscreenLayout(editor: Component): VStack {
    const document = new Container();
    const transcript = new ScrollView(document, { follow: "end", primary: true });
    const pendingMessages = new Container();
    const status = new FixedLines(["", "⠴ Working..."]);
    const aboveEditor = new Container();
    aboveEditor.addChild(new FixedLines([""]));
    const editorContainer = new Container();
    editorContainer.addChild(editor);
    const belowEditor = new Container();
    const footer = new FixedLines(["FOOTER"]);

    const dock = new VStack([
        { component: pendingMessages, shrink: 1, minSize: 0 },
        { component: status, shrink: 1, minSize: 0 },
        { component: aboveEditor, shrink: 1, minSize: 0 },
        { component: editorContainer, shrink: 1, minSize: 3 },
        { component: belowEditor, shrink: 1, minSize: 0 },
        { component: footer, shrink: 1, minSize: 1 },
    ]);

    return new VStack([
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
    ]);
}

test("anchor input to bottom pads short screens above focused bottom chrome", () => {
    installAnchorInputToBottomPatch({ anchorInputToBottom: true });

    const terminal = new FakeTerminal();
    const tui = new TUI(terminal);
    const editor = new TestEditor();
    const editorContainer = new InheritedChildrenContainer(editor);
    tui.addChild(new FixedLines(["message"]));
    tui.addChild(new FixedLines(["", "⠴ Working... (4s)"]));
    tui.addChild(new FixedLines([""]));
    tui.addChild(editorContainer);
    tui.addChild(new FixedLines(["FOOTER"]));
    tui.setFocus(editor);

    assert.deepEqual(tui.render(30), [
        "message",
        "",
        "",
        "",
        "",
        "⠴ Working... (4s)",
        "EDITOR TOP",
        "EDITOR BODY",
        "EDITOR BOTTOM",
        "FOOTER",
    ]);

    installAnchorInputToBottomPatch({ anchorInputToBottom: false });
});

test("anchor input to bottom leaves short screens unchanged when disabled", () => {
    installAnchorInputToBottomPatch({ anchorInputToBottom: false });

    const terminal = new FakeTerminal();
    const tui = new TUI(terminal);
    const editor = new TestEditor();

    tui.addChild(new FixedLines(["message"]));
    tui.addChild(editor);
    tui.setFocus(editor);
    assert.deepEqual(tui.render(30), ["message", "EDITOR TOP", "EDITOR BODY", "EDITOR BOTTOM"]);
});

test("anchor input range recording preserves inherited child render methods", () => {
    installAnchorInputToBottomPatch({ anchorInputToBottom: false });

    const terminal = new FakeTerminal();
    const tui = new TUI(terminal);
    const child = new FixedLines(["message"]);
    tui.addChild(child);
    assert.equal(Object.hasOwn(child, "render"), false);
    tui.render(30);
    assert.equal(Object.hasOwn(child, "render"), false);
});

test("anchor input to bottom leaves full-height screens unchanged", () => {
    installAnchorInputToBottomPatch({ anchorInputToBottom: true });

    const terminal = new FakeTerminal();
    const tui = new TUI(terminal);
    const editor = new TestEditor();

    tui.addChild(new FixedLines(Array.from({ length: 8 }, (_value, index) => `line ${index}`)));
    tui.addChild(editor);
    tui.setFocus(editor);

    assert.deepEqual(tui.render(30), [
        "line 0",
        "line 1",
        "line 2",
        "line 3",
        "line 4",
        "line 5",
        "line 6",
        "line 7",
        "EDITOR TOP",
        "EDITOR BODY",
        "EDITOR BOTTOM",
    ]);

    installAnchorInputToBottomPatch({ anchorInputToBottom: false });
});

test("anchor input to bottom compacts full-height working loader spacing", () => {
    installAnchorInputToBottomPatch({ anchorInputToBottom: true });

    const terminal = new FakeTerminal();
    const tui = new TUI(terminal);
    const editorContainer = new Container();
    const editor = new TestEditor();

    editorContainer.addChild(editor);
    tui.addChild(new FixedLines(Array.from({ length: 4 }, (_value, index) => `line ${index}`)));
    tui.addChild(new FixedLines(["", "⠴ Working... (4s)"]));
    tui.addChild(new FixedLines([""]));
    tui.addChild(editorContainer);
    tui.addChild(new FixedLines(["FOOTER"]));
    tui.setFocus(editor);

    assert.deepEqual(tui.render(30), [
        "line 0",
        "line 1",
        "line 2",
        "line 3",
        "",
        "⠴ Working... (4s)",
        "EDITOR TOP",
        "EDITOR BODY",
        "EDITOR BOTTOM",
        "FOOTER",
    ]);

    installAnchorInputToBottomPatch({ anchorInputToBottom: false });
});

test("anchor input to bottom compacts the fullscreen spacer below the working loader", () => {
    installAnchorInputToBottomPatch({ anchorInputToBottom: true });

    const terminal = new FakeTerminal();
    terminal.rows = 8;
    const tui = new TuiAltScreen(terminal);
    const editor = new TestEditor();
    tui.setLayoutRoot(createFullscreenLayout(editor));
    tui.setFocus(editor);

    try {
        tui.start();
        tui.renderNow();

        const screen = getFullscreenScreen(tui).map((line) => stripTerminalLineReset(line).trim());
        const workingIndex = screen.indexOf("⠴ Working...");
        const editorIndex = screen.indexOf("EDITOR TOP");
        assert.notEqual(workingIndex, -1);
        assert.notEqual(editorIndex, -1);
        assert.equal(editorIndex - workingIndex, 1);
    } finally {
        tui.stop();
        installAnchorInputToBottomPatch({ anchorInputToBottom: false });
    }
});

test("fullscreen anchoring leaves the spacer below the working loader disabled", () => {
    installAnchorInputToBottomPatch({ anchorInputToBottom: false });

    const terminal = new FakeTerminal();
    terminal.rows = 8;
    const tui = new TuiAltScreen(terminal);
    const editor = new TestEditor();
    tui.setLayoutRoot(createFullscreenLayout(editor));
    tui.setFocus(editor);

    try {
        tui.start();
        tui.renderNow();

        const screen = getFullscreenScreen(tui).map((line) => stripTerminalLineReset(line).trim());
        const workingIndex = screen.indexOf("⠴ Working...");
        const editorIndex = screen.indexOf("EDITOR TOP");
        assert.notEqual(workingIndex, -1);
        assert.notEqual(editorIndex, -1);
        assert.equal(editorIndex - workingIndex, 2);
    } finally {
        tui.stop();
    }
});
