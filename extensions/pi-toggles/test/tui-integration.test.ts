import { TuiAltScreen, TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { TogglesPanel, type PanelItem, type TogglesPanelStyles } from "../src/toggles-panel.ts";
import { type ScreenRow, VirtualTerminal } from "./support/virtual-terminal.ts";

const styles: TogglesPanelStyles = {
    accent: (text) => `\u001b[36m${text}\u001b[39m`,
    text: (text) => `\u001b[37m${text}\u001b[39m`,
    muted: (text) => `\u001b[90m${text}\u001b[39m`,
    dim: (text) => `\u001b[2m${text}\u001b[22m`,
    warning: (text) => `\u001b[33m${text}\u001b[39m`,
    success: (text) => `\u001b[32m${text}\u001b[39m`,
    error: (text) => `\u001b[31m${text}\u001b[39m`,
    selected: (text) => `\u001b[7m${text}\u001b[27m`,
    bold: (text) => `\u001b[1m${text}\u001b[22m`,
    border: (text) => `\u001b[34m${text}\u001b[39m`,
};

function panelItem(
    category: PanelItem["category"],
    label: string,
    options: {
        readonly currentValue?: string;
        readonly effectiveValue?: string;
        readonly decidedBy?: string;
        readonly values?: readonly string[];
    } = {},
): PanelItem {
    const currentValue = options.currentValue ?? "inherit";
    return {
        id: `${category}:${label}`,
        category,
        label,
        currentValue,
        effectiveValue:
            options.effectiveValue ?? (currentValue === "inherit" ? "on" : currentValue),
        decidedBy: options.decidedBy ?? "profile:review",
        description: `${label} capability description`,
        values: options.values ?? ["inherit", "on", "off"],
    };
}

const items: readonly PanelItem[] = [
    panelItem("tool", "read"),
    panelItem("tool", "write", { currentValue: "off", effectiveValue: "off" }),
    panelItem("tool", "browser", {
        currentValue: "unsupported",
        effectiveValue: "unsupported",
        decidedBy: "runtime",
        values: [],
    }),
    ...Array.from({ length: 12 }, (_value, index) => panelItem("tool", `tool-${index + 1}`)),
    panelItem("skill", "typescript"),
    panelItem("skill", "python", { currentValue: "on" }),
    panelItem("command", "review"),
    panelItem("system-fragment", "project-rules", { currentValue: "on" }),
    panelItem("profile", "review", {
        currentValue: "active",
        effectiveValue: "active",
        decidedBy: "session",
        values: ["active", "inactive"],
    }),
];

interface TuiMode {
    readonly name: string;
    readonly create: (terminal: VirtualTerminal) => TUI;
}

const tuiModes = [
    {
        name: "main screen",
        create: (terminal: VirtualTerminal): TUI => new TuiMainScreen(terminal),
    },
    {
        name: "alternate screen",
        create: (terminal: VirtualTerminal): TUI => new TuiAltScreen(terminal),
    },
] as const satisfies readonly TuiMode[];

function assertPanelFits(terminal: VirtualTerminal): void {
    const rows = terminal.interpretedRows();
    const border = "─".repeat(Math.max(0, terminal.columns - 1));
    const titleRow = rows.find((row) => row.text.includes("Pi Toggles"));
    expect(titleRow).toBeDefined();
    if (titleRow === undefined) throw new Error("TogglesPanel title row was not rendered");

    let topBorderRow: ScreenRow | undefined;
    let bottomBorderRow: ScreenRow | undefined;
    for (const row of rows) {
        if (row.text !== border) continue;
        if (row.index < titleRow.index) {
            topBorderRow = row;
            continue;
        }
        bottomBorderRow ??= row;
    }

    expect(topBorderRow).toBeDefined();
    expect(bottomBorderRow).toBeDefined();
    if (topBorderRow === undefined || bottomBorderRow === undefined) {
        throw new Error("TogglesPanel borders were not rendered");
    }

    const wrappedContinuationRows = rows
        .slice(topBorderRow.index, bottomBorderRow.index + 1)
        .filter((row) => row.isWrapped);
    expect(wrappedContinuationRows.every((row) => row.text.trim().length === 0)).toBe(true);
    const wrappedRowExclusion = wrappedContinuationRows[0]?.index;
    expect(wrappedContinuationRows.length).toBeLessThanOrEqual(1);
    terminal.assertScreenFits(topBorderRow.index, bottomBorderRow.index, wrappedRowExclusion);
    const followingRow = rows.at(bottomBorderRow.index + 1);
    expect(followingRow).toMatchObject({
        text: "",
        isWrapped: false,
    });
    if (followingRow === undefined) {
        throw new Error("TogglesPanel has no following terminal row");
    }
    terminal.assertScreenFits(followingRow.index, followingRow.index);
}

describe.each(tuiModes)("TogglesPanel through the Pi $name TUI", ({ create }) => {
    let terminal: VirtualTerminal | undefined;
    let tui: TUI | undefined;

    afterEach(async () => {
        tui?.stop();
        await terminal?.settle(0);
        terminal?.dispose();
    });

    it("owns focus, input, responsive redraws, and cancellation in interpreted terminal output", async () => {
        const changes: Array<{ readonly id: string; readonly value: string }> = [];
        let cancellations = 0;
        const panel = new TogglesPanel(
            items.map((item) => ({ ...item })),
            "session",
            styles,
            (id, value) => changes.push({ id, value }),
            () => {
                cancellations += 1;
            },
        );
        terminal = new VirtualTerminal(120, 32);
        tui = create(terminal);
        tui.setClearOnShrink(true);
        tui.addChild(panel);
        tui.setFocus(panel);
        tui.start();
        await terminal.settle();

        expect(panel.focused).toBe(true);
        expect(terminal.screenText()).toContain("Pi Toggles  SESSION POLICY");
        expect(terminal.screenText()).toContain("Tools 15");
        expect(terminal.screenText()).toContain("Profile 1");
        expect(terminal.screenText()).toContain("read");
        expect(terminal.screenText()).toContain("profile:review");
        expect(terminal.screenText()).toContain("read capability description");
        expect(terminal.screenText()).toContain("unsupported");
        const initialSearchRow = terminal
            .interpretedRows()
            .find((row) => row.text.includes("Search"));
        expect(initialSearchRow).toBeDefined();
        expect(terminal.cursor().row).toBe(initialSearchRow?.index);
        assertPanelFits(terminal);
        terminal.assertLineEndsWithDefaultStyle();

        terminal.sendInput("\u001b[B");
        terminal.sendInput(" ");
        terminal.sendInput("\u001b[A");
        terminal.sendInput("\r");
        await terminal.settle();
        expect(changes).toEqual([
            { id: "tool:write", value: "inherit" },
            { id: "tool:read", value: "on" },
        ]);
        expect(terminal.screenText()).toContain("› read");
        expect(terminal.screenText()).toContain("on");

        terminal.sendInput("write");
        await terminal.settle();
        expect(terminal.screenText()).toMatch(/Search\s+>\s*write/);
        expect(terminal.screenText()).toContain("› write");
        expect(terminal.screenText()).not.toContain("tool-10");
        const filteredSearchRow = terminal
            .interpretedRows()
            .find((row) => /Search\s+>\s*write/.test(row.text));
        expect(filteredSearchRow).toBeDefined();
        const filteredCursor = terminal.cursor();
        expect(filteredCursor.row).toBe(filteredSearchRow?.index);
        expect(filteredSearchRow?.text.slice(0, filteredCursor.column)).toMatch(
            /Search\s+>\s*write$/,
        );

        terminal.sendInput("\t");
        terminal.sendInput("type");
        terminal.sendInput("\r");
        await terminal.settle();
        expect(terminal.screenText()).toContain("› typescript");
        expect(changes.at(-1)).toEqual({ id: "skill:typescript", value: "on" });

        terminal.sendInput("\u001b[Z");
        await terminal.settle();
        const restoredSearchRow = terminal
            .interpretedRows()
            .find((row) => /Search\s+>\s*write/.test(row.text));
        expect(restoredSearchRow).toBeDefined();
        const restoredCursor = terminal.cursor();
        expect(restoredCursor.row).toBe(restoredSearchRow?.index);
        expect(restoredSearchRow?.text.slice(0, restoredCursor.column)).toMatch(
            /Search\s+>\s*write$/,
        );
        terminal.sendInput("\u001b[D");
        terminal.sendInput("\r");
        tui.requestRender(true);
        await terminal.settle();
        expect(terminal.screenText()).toContain("› review");
        expect(changes.at(-1)).toEqual({ id: "profile:review", value: "inactive" });
        terminal.sendInput("\u001b[C");
        terminal.sendInput("\u001b");
        await terminal.settle();
        expect(cancellations).toBe(1);

        terminal.resize(40, 18);
        tui.requestRender(true);
        await terminal.settle();
        assertPanelFits(terminal);
        terminal.assertLineEndsWithDefaultStyle();
        expect(terminal.screenText()).not.toContain("DECIDED BY");
        expect(terminal.screenText()).not.toContain("read capability description");

        terminal.resize(74, 32);
        tui.requestRender(true);
        await terminal.settle();
        assertPanelFits(terminal);
        terminal.assertLineEndsWithDefaultStyle();
        expect(terminal.screenText()).toContain("Pi Toggles");
        expect(terminal.screenText()).toContain("› write");
        expect(terminal.screenText()).not.toContain("DECIDED BY");
        expect(terminal.screenText()).not.toContain("tool-10");
    });
});
