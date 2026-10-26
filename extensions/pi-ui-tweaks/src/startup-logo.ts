import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";

const RESET = "\u001b[0m";
const NATIVE_ROWS = ["▀▀█ ", "█▀ █"];
const ENLARGED_ROWS = ["██████  ", "    ██  ", "████  ██", "██    ██"];

/** Double each native pixel in both axes, retaining its original foreground/background ANSI. */
export function enlargeStartupLogo(native: readonly string[]): string[] | undefined {
    // The early-startup and reload bridges can already return enlarged rows. Never scale twice.
    if (
        ENLARGED_ROWS.every(
            (row, index) =>
                stripTerminalSequences(sliceByColumn(native[index] ?? "", 1, 8)) === row,
        )
    )
        return native.slice(0, 4).map((row) => sliceByColumn(row, 1, 8) + RESET);

    if (
        !NATIVE_ROWS.every(
            (row, index) =>
                stripTerminalSequences(sliceByColumn(native[index] ?? "", 1, 4)) === row,
        )
    )
        return undefined;

    const result: string[] = [];
    for (const line of native.slice(0, 2)) {
        let top = "";
        let bottom = "";
        for (let column = 1; column <= 4; column += 1) {
            const cell = sliceByColumn(line, column, 1);
            const glyph = stripTerminalSequences(cell);
            let upper = "  ";
            let lower = "  ";

            if (glyph === "█" || glyph === "▀") upper = "██";
            if (glyph === "█" || glyph === "▄") lower = "██";

            // Spaces preserve a half-cell's original background (including the logo's blue pixel).
            top += RESET + cell.replace(glyph, upper) + RESET;
            bottom += RESET + cell.replace(glyph, lower) + RESET;
        }

        result.push(top, bottom);
    }

    return result;
}
