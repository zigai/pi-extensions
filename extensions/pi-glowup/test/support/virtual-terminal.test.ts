import { afterEach, describe, expect, it } from "vitest";
import { rgbFromHex, VirtualTerminal } from "./virtual-terminal.ts";

const terminals: VirtualTerminal[] = [];

function createTerminal(columns = 20, rows = 6): VirtualTerminal {
    const terminal = new VirtualTerminal(columns, rows);
    terminals.push(terminal);
    return terminal;
}

async function writeAndSettle(terminal: VirtualTerminal, data: string): Promise<void> {
    terminal.write(data);
    await terminal.settle(0);
}

afterEach(() => {
    for (const terminal of terminals.splice(0)) terminal.dispose();
});

describe("VirtualTerminal query and invariant support", () => {
    it("requires singular literal and regular-expression row matches", async () => {
        const terminal = createTerminal();
        await writeAndSettle(terminal, "alpha\r\nbeta\r\nbeta");

        expect(terminal.requireRowContaining("alpha").text).toBe("alpha");
        const globalPattern = /beta/g;
        expect(terminal.rowsMatching(globalPattern)).toHaveLength(2);
        expect(globalPattern.lastIndex).toBe(0);
        expect(() => terminal.requireRowContaining("missing")).toThrowError(
            /expected exactly one terminal row.*found 0.*Screen:.*alpha/s,
        );
        expect(() => terminal.requireRowMatching(/beta/)).toThrowError(
            /expected exactly one terminal row.*found 2.*rows: 1, 2/,
        );
    });

    it("counts exact non-overlapping occurrences and selects bounded row ranges", async () => {
        const terminal = createTerminal();
        await writeAndSettle(terminal, "aaaa\r\nmarker");

        expect(terminal.countOccurrences("aa")).toBe(2);
        expect(terminal.rowRange(0, 2).map((row) => row.text)).toEqual(["aaaa", "marker"]);
        expect(() => terminal.countOccurrences("")).toThrowError(/must not be empty/);
        expect(() => terminal.rowRange(0, 7)).toThrowError(/exceeds 6 terminal rows/);
    });

    it("validates and preserves exact RGB provenance", async () => {
        expect(rgbFromHex("#16351E")).toBe(0x16351e);
        expect(rgbFromHex("#abcdef")).toBe(0xabcdef);
        expect(() => rgbFromHex("16351E")).toThrowError(/six-digit #RRGGBB/);
        expect(() => rgbFromHex("#12345G")).toThrowError(/six-digit #RRGGBB/);

        const terminal = createTerminal(8, 2);
        await writeAndSettle(terminal, "\u001b[48;2;22;53;30m        \u001b[0m");
        const [row] = terminal.rowRange(0, 1);
        if (row === undefined) throw new Error("missing RGB test row");
        expect(row.cells.every((cell) => cell.isBackgroundRgb)).toBe(true);
        terminal.assertFullRowBackground(row, rgbFromHex("#16351E"));
        expect(() => terminal.assertFullRowBackground(row, rgbFromHex("#16351F"))).toThrowError(
            /expected every cell background must be RGB #16351F.*bg=rgb:1455390/s,
        );
    });

    it("reports leaked background, bold, and dim styling in a neutral range", async () => {
        const cases: readonly (readonly [string, RegExp])[] = [
            ["\u001b[48;2;1;2;3mX", /bg=rgb:66051/],
            ["\u001b[1mX", /bold=true/],
            ["\u001b[2mX", /dim=true/],
        ];
        for (const [ansi, detail] of cases) {
            const terminal = createTerminal();
            await writeAndSettle(terminal, ansi);
            const row = terminal.requireRowContaining("X");
            expect(() => terminal.assertNeutralRange(row, 0, 1)).toThrowError(detail);
        }
    });

    it("reports the offending wrapped row and screen", async () => {
        const terminal = createTerminal(5, 3);
        await writeAndSettle(terminal, "123456");

        expect(() => terminal.assertNoWrappedRows()).toThrowError(
            /terminal row 1: expected row must not be wrapped; actual isWrapped=true[\s\S]*Screen:[\s\S]*12345/,
        );
    });

    it("checks width and unique transcript markers", async () => {
        const terminal = createTerminal(30, 5);
        await writeAndSettle(terminal, "HEADER\r\nBEFORE\r\nAFTER");

        terminal.assertRowsFitWidth();
        terminal.assertUniqueTranscriptMarkers("HEADER", "BEFORE", "AFTER");
        expect(() =>
            terminal.assertUniqueTranscriptMarkers("HEADER", "BEFORE", "missing"),
        ).toThrowError(/after sentinel.*must occur exactly once; found 0 \(rows: none\)/);
        const duplicate = createTerminal(30, 5);
        await writeAndSettle(duplicate, "HEADER\r\nBEFORE\r\nBEFORE\r\nAFTER");
        expect(() =>
            duplicate.assertUniqueTranscriptMarkers("HEADER", "BEFORE", "AFTER"),
        ).toThrowError(/before sentinel.*found 2 \(rows: 1, 2\)/);
    });
});
