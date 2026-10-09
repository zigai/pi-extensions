import assert from "node:assert/strict";
import { test } from "vitest";

import {
    Container,
    TuiMainScreen as TUI,
    type Component,
    type Terminal,
} from "@earendil-works/pi-tui";
import { installAnchorInputToBottomPatch } from "../../pi-ui-tweaks/src/anchor-input-to-bottom.ts";
import { markFooterComponent } from "../src/footer-component.ts";
import { installFooterShrinkPaddingPatch } from "../src/tui-footer-shrink-padding.ts";

const ANSI_ESCAPE_PATTERN = "\\u001b";
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

type TuiInternals = {
    doRender(): void;
    previousLines: string[];
    previousViewportTop: number;
};

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function isTuiInternals(value: unknown): value is TuiInternals {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
        return false;
    }

    return (
        "doRender" in value &&
        typeof value.doRender === "function" &&
        "previousLines" in value &&
        Array.isArray(value.previousLines) &&
        value.previousLines.every(isString) &&
        "previousViewportTop" in value &&
        typeof value.previousViewportTop === "number"
    );
}

function getTuiInternals(tui: TUI): TuiInternals {
    if (!isTuiInternals(tui)) {
        throw new Error("Expected TUI render internals.");
    }

    return tui;
}

function stripTestAnsi(text: string): string {
    return text.split(`${ESC}[0m`).join("").split(`${ESC}]8;;${BEL}`).join("");
}

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

    hideCursor(): void {
        this.write("\u001b[?25l");
    }

    showCursor(): void {
        this.write("\u001b[?25h");
    }

    clearLine(): void {
        this.write("\u001b[K");
    }

    clearFromCursor(): void {
        this.write("\u001b[J");
    }

    clearScreen(): void {
        this.write("\u001b[2J\u001b[H");
    }

    setTitle(): void {}

    setProgress(): void {}
}

class VariableLines implements Component {
    lineCount: number;

    constructor(lineCount: number) {
        this.lineCount = lineCount;
    }

    render(): string[] {
        return Array.from({ length: this.lineCount }, (_value, index) => {
            return `line ${index.toString().padStart(2, "0")}`;
        });
    }

    invalidate(): void {}
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

class MutableLines implements Component {
    lines: string[];

    constructor(lines: string[]) {
        this.lines = lines;
    }

    render(): string[] {
        return this.lines;
    }

    invalidate(): void {}
}

class CountingLines implements Component {
    renderCount = 0;

    constructor(private readonly lines: string[]) {}

    render(): string[] {
        this.renderCount += 1;
        return this.lines;
    }

    invalidate(): void {}
}

class CountingContainer extends Container {
    renderCount = 0;

    override render(width: number): string[] {
        this.renderCount += 1;
        return super.render(width);
    }
}

class TestEditor implements Component {
    focused = false;

    render(): string[] {
        return ["EDITOR TOP", "EDITOR BODY", "EDITOR BOTTOM"];
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

class VariableEditor implements Component {
    focused = false;

    constructor(public lineCount: number) {}

    render(): string[] {
        return Array.from({ length: this.lineCount }, (_value, index) => `EDITOR ${index}`);
    }

    invalidate(): void {}
}

class TestFooter implements Component {
    render(): string[] {
        return ["FOOTER"];
    }

    invalidate(): void {}
}

test("footer and anchor patches record child line ranges during one render frame", () => {
    const anchorHandle = installAnchorInputToBottomPatch({ anchorInputToBottom: true });
    installFooterShrinkPaddingPatch();

    const terminal = new FakeTerminal();
    const tui = new TUI(terminal);
    const message = new CountingLines(["message"]);
    const status = new CountingLines(["", "⠴ Working... (4s)"]);
    const spacer = new CountingLines([""]);
    const editorContainer = new CountingContainer();
    const editor = new TestEditor();
    const footer = new CountingLines(["FOOTER"]);

    try {
        editorContainer.addChild(editor);
        tui.addChild(message);
        tui.addChild(status);
        tui.addChild(spacer);
        tui.addChild(editorContainer);
        tui.addChild(markFooterComponent(footer, "live"));
        tui.setFocus(editor);
        assert.equal(Object.hasOwn(message, "render"), false);
        tui.render(30);
        assert.equal(message.renderCount, 1);
        assert.equal(status.renderCount, 1);
        assert.equal(spacer.renderCount, 1);
        assert.equal(editorContainer.renderCount, 1);
        assert.equal(footer.renderCount, 1);
        assert.equal(Object.hasOwn(message, "render"), false);
    } finally {
        anchorHandle.dispose();
    }
});

test("footer shrink padding keeps the final chat row attached when anchor compacts chrome", () => {
    const anchorHandle = installAnchorInputToBottomPatch({ anchorInputToBottom: true });
    installFooterShrinkPaddingPatch();

    const terminal = new FakeTerminal();

    const chatLines = [
        ...Array.from({ length: 16 }, (_value, index) => `chat ${index}`),
        "USER MESSAGE BOTTOM",
    ];

    const chat = new FixedLines(chatLines);
    const status = new FixedLines(["", "⠴ Working... (4s)"]);
    const spacer = new FixedLines([""]);
    const editorContainer = new Container();
    const editor = new VariableEditor(5);
    const tui = new TUI(terminal);
    const tuiInternals = getTuiInternals(tui);

    try {
        editorContainer.addChild(editor);
        tui.addChild(chat);
        tui.addChild(status);
        tui.addChild(spacer);
        tui.addChild(editorContainer);
        tui.addChild(markFooterComponent(new TestFooter(), "live"));
        tui.setFocus(editor);

        tuiInternals.doRender();
        editor.lineCount = 3;
        tuiInternals.doRender();

        const visibleLines = tuiInternals.previousLines
            .slice(tuiInternals.previousViewportTop)
            .map(stripTestAnsi);
        const finalChatRowIndex = visibleLines.indexOf("USER MESSAGE BOTTOM");
        assert.notEqual(finalChatRowIndex, -1);
        assert.equal(visibleLines[finalChatRowIndex - 1], "chat 15");
    } finally {
        anchorHandle.dispose();
    }
});

test("footer shrink padding preserves visible tail without native clear", () => {
    installFooterShrinkPaddingPatch();

    const terminal = new FakeTerminal();
    const lines = new VariableLines(24);
    const tui = new TUI(terminal);
    tui.setClearOnShrink(true);
    const tuiInternals = getTuiInternals(tui);
    tui.addChild(lines);
    tui.addChild(markFooterComponent(new TestFooter(), "live"));

    tuiInternals.doRender();
    terminal.writes = [];

    lines.lineCount = 13;
    tuiInternals.doRender();

    const output = terminal.writes.join("");
    const visibleTopLine = stripTestAnsi(
        tuiInternals.previousLines[tuiInternals.previousViewportTop] ?? "",
    );
    const lineBeforeFooter = stripTestAnsi(tuiInternals.previousLines.at(-2) ?? "");
    const footerLine = stripTestAnsi(tuiInternals.previousLines.at(-1) ?? "");
    assert.equal(tuiInternals.previousLines.length, 25);
    assert.equal(visibleTopLine, "line 04");
    assert.equal(lineBeforeFooter, "line 12");
    assert.equal(footerLine.includes("FOOTER"), true);
    assert.doesNotMatch(output, new RegExp(`${ANSI_ESCAPE_PATTERN}\\[2J`));
});

test("footer shrink padding recognizes Pi's top-level footer container", () => {
    installFooterShrinkPaddingPatch();

    const terminal = new FakeTerminal();
    const lines = new VariableLines(60);
    const footerContainer = new Container();
    const tui = new TUI(terminal);
    const tuiInternals = getTuiInternals(tui);

    footerContainer.addChild(markFooterComponent(new TestFooter(), "live"));
    tui.addChild(lines);
    tui.addChild(footerContainer);

    tuiInternals.doRender();
    lines.lineCount = 55;
    tuiInternals.doRender();

    const visibleLines = tuiInternals.previousLines
        .slice(tuiInternals.previousViewportTop)
        .map(stripTestAnsi);

    assert.equal(tuiInternals.previousLines.length, 61);
    assert.equal(visibleLines.at(-1)?.includes("FOOTER"), true);
});

test("footer shrink padding yields to full redraw for distant content rebuilds", () => {
    installFooterShrinkPaddingPatch();

    const terminal = new FakeTerminal();
    const lines = new MutableLines(
        Array.from({ length: 40 }, (_value, index) => `old ${index.toString().padStart(2, "0")}`),
    );
    const tui = new TUI(terminal);
    tui.setClearOnShrink(true);
    const tuiInternals = getTuiInternals(tui);
    tui.addChild(lines);
    tui.addChild(markFooterComponent(new TestFooter(), "live"));

    tuiInternals.doRender();
    terminal.writes = [];

    lines.lines = Array.from({ length: 8 }, (_value, index) => {
        return `new ${index.toString().padStart(2, "0")}`;
    });
    tuiInternals.doRender();

    const output = terminal.writes.join("");
    const firstLine = stripTestAnsi(tuiInternals.previousLines[0] ?? "");
    const footerLine = stripTestAnsi(tuiInternals.previousLines.at(-1) ?? "");
    assert.equal(tuiInternals.previousLines.length, 9);
    assert.equal(firstLine, "new 00");
    assert.equal(footerLine.includes("FOOTER"), true);
    assert.match(output, new RegExp(`${ANSI_ESCAPE_PATTERN}\\[2J`));
});

test("footer shrink padding keeps small-shrink blanks below numbered content", () => {
    installFooterShrinkPaddingPatch();

    const terminal = new FakeTerminal();
    const lines = new VariableLines(24);
    const tui = new TUI(terminal);
    tui.setClearOnShrink(true);
    const tuiInternals = getTuiInternals(tui);
    tui.addChild(lines);
    tui.addChild(markFooterComponent(new TestFooter(), "live"));

    tuiInternals.doRender();
    terminal.writes = [];

    lines.lineCount = 22;
    tuiInternals.doRender();

    const output = terminal.writes.join("");
    const visibleLines = tuiInternals.previousLines
        .slice(tuiInternals.previousViewportTop)
        .map(stripTestAnsi);

    assert.equal(tuiInternals.previousLines.length, 25);
    assert.deepEqual(visibleLines.slice(0, 3), ["line 15", "line 16", "line 17"]);
    assert.equal(visibleLines[6], "line 21");
    assert.deepEqual(visibleLines.slice(7, 9), ["", ""]);
    assert.equal(visibleLines.at(-1)?.includes("FOOTER"), true);
    assert.doesNotMatch(output, new RegExp(`${ANSI_ESCAPE_PATTERN}\\[2J`));
});

test("footer shrink padding keeps focused editor attached to footer", () => {
    installFooterShrinkPaddingPatch();

    const terminal = new FakeTerminal();
    const lines = new VariableLines(24);
    const editor = new TestEditor();
    const editorContainer = new InheritedChildrenContainer(editor);
    const belowWidgetContainer = new Container();
    const tui = new TUI(terminal);
    tui.setClearOnShrink(true);
    const tuiInternals = getTuiInternals(tui);

    tui.addChild(lines);
    tui.addChild(editorContainer);
    tui.addChild(belowWidgetContainer);
    tui.addChild(markFooterComponent(new TestFooter(), "live"));
    tui.setFocus(editor);

    tuiInternals.doRender();
    terminal.writes = [];

    lines.lineCount = 21;
    tuiInternals.doRender();

    const output = terminal.writes.join("");
    const visibleLines = tuiInternals.previousLines
        .slice(tuiInternals.previousViewportTop)
        .map(stripTestAnsi);

    assert.equal(tuiInternals.previousLines.length, 28);
    assert.deepEqual(visibleLines.slice(-4), [
        "EDITOR TOP",
        "EDITOR BODY",
        "EDITOR BOTTOM",
        "FOOTER",
    ]);
    assert.doesNotMatch(output, new RegExp(`${ANSI_ESCAPE_PATTERN}\\[2J`));
});

test("footer shrink padding keeps working loader attached to editor", () => {
    installFooterShrinkPaddingPatch();

    const terminal = new FakeTerminal();
    const lines = new VariableLines(24);
    const statusContainer = new FixedLines(["", "⠴ Working... (40s)"]);
    const aboveWidgetContainer = new FixedLines([""]);
    const editorContainer = new Container();
    const editor = new TestEditor();
    const belowWidgetContainer = new Container();
    const tui = new TUI(terminal);
    tui.setClearOnShrink(true);
    const tuiInternals = getTuiInternals(tui);

    editorContainer.addChild(editor);
    tui.addChild(lines);
    tui.addChild(statusContainer);
    tui.addChild(aboveWidgetContainer);
    tui.addChild(editorContainer);
    tui.addChild(belowWidgetContainer);
    tui.addChild(markFooterComponent(new TestFooter(), "live"));
    tui.setFocus(editor);

    tuiInternals.doRender();
    terminal.writes = [];

    lines.lineCount = 21;
    tuiInternals.doRender();

    const output = terminal.writes.join("");
    const visibleLines = tuiInternals.previousLines
        .slice(tuiInternals.previousViewportTop)
        .map(stripTestAnsi);
    const workingIndex = visibleLines.indexOf("⠴ Working... (40s)");
    const editorTopIndex = visibleLines.indexOf("EDITOR TOP");
    assert.equal(tuiInternals.previousLines.length, 30);
    assert.notEqual(workingIndex, -1);
    assert.notEqual(editorTopIndex, -1);
    assert.equal(editorTopIndex - workingIndex, 1);
    assert.deepEqual(visibleLines.slice(-4), [
        "EDITOR TOP",
        "EDITOR BODY",
        "EDITOR BOTTOM",
        "FOOTER",
    ]);
    assert.doesNotMatch(output, new RegExp(`${ANSI_ESCAPE_PATTERN}\\[2J`));
});

test("footer shrink padding keeps worked-for widget attached to editor", () => {
    installFooterShrinkPaddingPatch();

    const terminal = new FakeTerminal();
    const lines = new VariableLines(24);
    const statusContainer = new FixedLines([]);
    const aboveWidgetContainer = new FixedLines(["", "Worked for 4m 34s. [57 tok/s]"]);
    const editorContainer = new Container();
    const editor = new TestEditor();
    const belowWidgetContainer = new Container();
    const tui = new TUI(terminal);
    tui.setClearOnShrink(true);
    const tuiInternals = getTuiInternals(tui);

    editorContainer.addChild(editor);
    tui.addChild(lines);
    tui.addChild(statusContainer);
    tui.addChild(aboveWidgetContainer);
    tui.addChild(editorContainer);
    tui.addChild(belowWidgetContainer);
    tui.addChild(markFooterComponent(new TestFooter(), "live"));
    tui.setFocus(editor);

    tuiInternals.doRender();
    terminal.writes = [];

    lines.lineCount = 21;
    tuiInternals.doRender();

    const output = terminal.writes.join("");
    const visibleLines = tuiInternals.previousLines
        .slice(tuiInternals.previousViewportTop)
        .map(stripTestAnsi);
    const workedIndex = visibleLines.indexOf("Worked for 4m 34s. [57 tok/s]");
    const editorTopIndex = visibleLines.indexOf("EDITOR TOP");
    assert.equal(tuiInternals.previousLines.length, 30);
    assert.notEqual(workedIndex, -1);
    assert.notEqual(editorTopIndex, -1);
    assert.equal(editorTopIndex - workedIndex, 1);
    assert.deepEqual(visibleLines.slice(-4), [
        "EDITOR TOP",
        "EDITOR BODY",
        "EDITOR BOTTOM",
        "FOOTER",
    ]);
    assert.doesNotMatch(output, new RegExp(`${ANSI_ESCAPE_PATTERN}\\[2J`));
});
