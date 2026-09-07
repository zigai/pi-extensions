import { setTimeout as delay } from "node:timers/promises";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { visibleWidth, type Terminal } from "@earendil-works/pi-tui";

export type InterpretedCell = {
    readonly chars: string;
    readonly width: number;
    readonly foreground: number;
    readonly background: number;
    readonly isForegroundDefault: boolean;
    readonly isForegroundRgb: boolean;
    readonly isBackgroundRgb: boolean;
    readonly isBackgroundDefault: boolean;
    readonly isBold: boolean;
    readonly isDim: boolean;
    readonly isAttributeDefault: boolean;
};

export type InterpretedRow = {
    readonly index: number;
    readonly text: string;
    readonly isWrapped: boolean;
    readonly cells: readonly InterpretedCell[];
};

function validateRgbValue(rgb: number): void {
    if (!Number.isInteger(rgb) || rgb < 0 || rgb > 0xffffff) {
        throw new RangeError(`RGB value must be an integer from 0x000000 through 0xFFFFFF`);
    }
}

export function rgbFromHex(color: string): number {
    if (!/^#[\dA-Fa-f]{6}$/.test(color)) {
        throw new TypeError(
            `expected a six-digit #RRGGBB color, received ${JSON.stringify(color)}`,
        );
    }

    return Number.parseInt(color.slice(1), 16);
}

function countExactOccurrences(text: string, search: string): number {
    if (search.length === 0) throw new TypeError("occurrence search must not be empty");
    let count = 0;
    let offset = 0;
    while (offset <= text.length - search.length) {
        const match = text.indexOf(search, offset);
        if (match === -1) break;
        count += 1;
        offset = match + search.length;
    }

    return count;
}

/** Pi terminal adapter backed by xterm's VT parser and interpreted screen buffer. */
export class VirtualTerminal implements Terminal {
    private readonly terminal: HeadlessTerminal;
    private inputHandler: ((data: string) => void) | undefined;
    private resizeHandler: (() => void) | undefined;
    private pendingWrites: Promise<void> = Promise.resolve();
    private readonly writes: string[] = [];

    constructor(columns: number, rows: number) {
        this.terminal = new HeadlessTerminal({
            allowProposedApi: true,
            cols: columns,
            rows,
            scrollback: 2_000,
        });
    }

    start(onInput: (data: string) => void, onResize: () => void): void {
        this.inputHandler = onInput;
        this.resizeHandler = onResize;
    }

    stop(): void {
        this.inputHandler = undefined;
        this.resizeHandler = undefined;
    }

    async drainInput(): Promise<void> {}

    write(data: string): void {
        this.writes.push(data);
        this.pendingWrites = this.pendingWrites.then(
            async () =>
                new Promise<void>((resolve) => {
                    this.terminal.write(data, resolve);
                }),
        );
    }

    get columns(): number {
        return this.terminal.cols;
    }

    get rows(): number {
        return this.terminal.rows;
    }

    get kittyProtocolActive(): boolean {
        return false;
    }

    moveBy(lines: number): void {
        if (lines === 0) return;
        this.write(`\u001b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`);
    }

    hideCursor(): void {
        this.write("\u001b[?25l");
    }

    showCursor(): void {
        this.write("\u001b[?25h");
    }

    clearLine(): void {
        this.write("\u001b[2K");
    }

    clearFromCursor(): void {
        this.write("\u001b[0J");
    }

    clearScreen(): void {
        this.write("\u001b[2J\u001b[H");
    }

    setTitle(title: string): void {
        this.write(`\u001b]2;${title}\u0007`);
    }

    setProgress(_active: boolean): void {}

    sendInput(data: string): void {
        this.inputHandler?.(data);
    }

    resize(columns: number, rows: number): void {
        this.terminal.resize(columns, rows);
        this.resizeHandler?.();
    }

    /** Waits for Pi's scheduled render and all xterm parser writes to settle. */
    async settle(renderDelayMs = 24): Promise<void> {
        await delay(renderDelayMs);
        await this.pendingWrites;
        await delay(0);
        await this.pendingWrites;
    }

    rawWrites(): readonly string[] {
        return [...this.writes];
    }

    interpretedRows(): readonly InterpretedRow[] {
        const buffer = this.terminal.buffer.active;
        const rows: InterpretedRow[] = [];
        for (let viewportRow = 0; viewportRow < this.rows; viewportRow += 1) {
            const line = buffer.getLine(buffer.viewportY + viewportRow);
            if (line === undefined) {
                rows.push({ index: viewportRow, text: "", isWrapped: false, cells: [] });
                continue;
            }

            const cells: InterpretedCell[] = [];
            for (let column = 0; column < this.columns; column += 1) {
                const cell = line.getCell(column);
                if (cell === undefined) continue;
                cells.push({
                    chars: cell.getChars(),
                    width: cell.getWidth(),
                    foreground: cell.getFgColor(),
                    background: cell.getBgColor(),
                    isForegroundDefault: cell.isFgDefault(),
                    isBackgroundDefault: cell.isBgDefault(),
                    isForegroundRgb: cell.isFgRGB(),
                    isBackgroundRgb: cell.isBgRGB(),
                    isBold: cell.isBold() !== 0,
                    isDim: cell.isDim() !== 0,
                    isAttributeDefault: cell.isAttributeDefault(),
                });
            }

            rows.push({
                index: viewportRow,
                text: line.translateToString(true),
                isWrapped: line.isWrapped,
                cells,
            });
        }

        return rows;
    }

    screenText(): string {
        const rows = this.interpretedRows().map((row) => row.text);
        while (rows.at(-1) === "") rows.pop();

        return rows.join("\n");
    }

    rowsContaining(text: string): readonly InterpretedRow[] {
        return this.interpretedRows().filter((row) => row.text.includes(text));
    }

    rowsMatching(pattern: RegExp): readonly InterpretedRow[] {
        return this.interpretedRows().filter((row) => {
            const isolatedPattern = new RegExp(pattern.source, pattern.flags);
            isolatedPattern.lastIndex = 0;
            return isolatedPattern.test(row.text);
        });
    }

    requireRowContaining(text: string): InterpretedRow {
        return this.requireSingleRow(
            this.rowsContaining(text),
            `containing ${JSON.stringify(text)}`,
        );
    }

    requireRowMatching(pattern: RegExp): InterpretedRow {
        return this.requireSingleRow(this.rowsMatching(pattern), `matching ${pattern.toString()}`);
    }

    countOccurrences(search: string): number {
        return countExactOccurrences(this.screenText(), search);
    }

    rowRange(start: number, end: number): readonly InterpretedRow[] {
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
            throw new RangeError(`row range must satisfy 0 <= start <= end`);
        }
        if (end > this.rows) {
            throw new RangeError(`row range [${start}, ${end}) exceeds ${this.rows} terminal rows`);
        }

        return this.interpretedRows().slice(start, end);
    }

    assertNoWrappedRows(rows: readonly InterpretedRow[] = this.interpretedRows()): void {
        const wrapped = rows.find((row) => row.isWrapped);
        if (wrapped === undefined) return;
        throw this.invariantError(wrapped.index, "row must not be wrapped", "isWrapped=true");
    }

    assertRowsFitWidth(rows: readonly InterpretedRow[] = this.interpretedRows()): void {
        const overflowing = rows.find((row) => visibleWidth(row.text) > this.columns);
        if (overflowing === undefined) return;
        throw this.invariantError(
            overflowing.index,
            `visible width must not exceed ${this.columns}`,
            `visibleWidth=${visibleWidth(overflowing.text)}`,
        );
    }

    assertFullRowBackground(row: InterpretedRow, expectedRgb: number): void {
        validateRgbValue(expectedRgb);

        if (row.cells.length !== this.columns) {
            throw this.invariantError(
                row.index,
                `complete row must contain ${this.columns} cells`,
                `cells=${row.cells.length}`,
            );
        }

        const failingColumn = row.cells.findIndex(
            (cell) => !cell.isBackgroundRgb || cell.background !== expectedRgb,
        );
        if (failingColumn === -1) return;
        throw this.invariantError(
            row.index,
            `every cell background must be RGB #${expectedRgb.toString(16).padStart(6, "0").toUpperCase()}`,
            this.cellSummary(failingColumn, row.cells[failingColumn]),
        );
    }

    assertNeutralRange(row: InterpretedRow, start = 0, end = row.cells.length): void {
        if (
            !Number.isInteger(start) ||
            !Number.isInteger(end) ||
            start < 0 ||
            end < start ||
            end > row.cells.length
        ) {
            throw new RangeError(`cell range [${start}, ${end}) is outside row ${row.index}`);
        }

        const offset = row.cells
            .slice(start, end)
            .findIndex(
                (cell) =>
                    !cell.isAttributeDefault ||
                    !cell.isForegroundDefault ||
                    !cell.isBackgroundDefault ||
                    cell.isBold ||
                    cell.isDim,
            );
        if (offset === -1) return;
        const column = start + offset;
        throw this.invariantError(
            row.index,
            `cells [${start}, ${end}) must use default attributes and colors without bold or dim`,
            this.cellSummary(column, row.cells[column]),
        );
    }

    assertUniqueTranscriptMarkers(
        header: string,
        beforeSentinel: string,
        afterSentinel: string,
    ): void {
        for (const [role, marker] of [
            ["header", header],
            ["before sentinel", beforeSentinel],
            ["after sentinel", afterSentinel],
        ] as const) {
            const count = this.countOccurrences(marker);
            if (count !== 1) {
                const rows = this.rowsContaining(marker).map((row) => row.index);
                const matchingRows = rows.length === 0 ? "none" : rows.join(", ");
                throw new Error(
                    `${role} ${JSON.stringify(marker)} must occur exactly once; found ${count} (rows: ${matchingRows})\nScreen:\n${this.screenText()}`,
                );
            }
        }
    }

    private requireSingleRow(
        matches: readonly InterpretedRow[],
        description: string,
    ): InterpretedRow {
        const match = matches[0];
        if (matches.length === 1 && match !== undefined) return match;
        const matchingRows =
            matches.length === 0 ? "none" : matches.map((row) => row.index).join(", ");

        throw new Error(
            `expected exactly one terminal row ${description}; found ${matches.length} (rows: ${matchingRows})\nScreen:\n${this.screenText()}`,
        );
    }

    private cellSummary(column: number, cell: InterpretedCell | undefined): string {
        if (cell === undefined) return `column=${column}, missing cell`;
        const foreground = cell.isForegroundDefault
            ? "default"
            : `${cell.isForegroundRgb ? "rgb" : "palette"}:${cell.foreground}`;
        const background = cell.isBackgroundDefault
            ? "default"
            : `${cell.isBackgroundRgb ? "rgb" : "palette"}:${cell.background}`;
        return `column=${column}, chars=${JSON.stringify(cell.chars)}, fg=${foreground}, bg=${background}, bold=${cell.isBold}, dim=${cell.isDim}, attributesDefault=${cell.isAttributeDefault}`;
    }

    private invariantError(row: number, expected: string, actual: string): Error {
        return new Error(
            `terminal row ${row}: expected ${expected}; actual ${actual}\nScreen:\n${this.screenText()}`,
        );
    }

    dispose(): void {
        this.terminal.dispose();
    }
}
