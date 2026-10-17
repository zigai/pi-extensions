import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { setTimeout as delay } from "node:timers/promises";

export interface ScreenCell {
    readonly chars: string;
    readonly isAttributeDefault: boolean;
    readonly isForegroundDefault: boolean;
    readonly isBackgroundDefault: boolean;
    readonly isBold: boolean;
    readonly isDim: boolean;
    readonly isInverse: boolean;
}

export interface ScreenRow {
    readonly index: number;
    readonly text: string;
    readonly isWrapped: boolean;
    readonly cells: readonly ScreenCell[];
}

export class VirtualTerminal implements Terminal {
    private readonly terminal: HeadlessTerminal;
    private inputHandler: ((data: string) => void) | undefined;
    private resizeHandler: (() => void) | undefined;
    private pendingWrites: Promise<void> = Promise.resolve();

    constructor(columns: number, rows: number) {
        this.terminal = new HeadlessTerminal({
            allowProposedApi: true,
            cols: columns,
            rows,
            scrollback: 500,
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
        this.pendingWrites = this.pendingWrites.then(
            () =>
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

    setProgress(active: boolean): void {
        void active;
    }

    setProgramStatus(): void {}

    sendInput(data: string): void {
        this.inputHandler?.(data);
    }

    resize(columns: number, rows: number): void {
        this.terminal.resize(columns, rows);
        this.resizeHandler?.();
    }

    async settle(renderDelayMilliseconds = 24): Promise<void> {
        await delay(renderDelayMilliseconds);
        await this.pendingWrites;
        await delay(0);
        await this.pendingWrites;
    }

    cursor(): { readonly column: number; readonly row: number } {
        const buffer = this.terminal.buffer.active;
        return { column: buffer.cursorX, row: buffer.cursorY };
    }

    interpretedRows(): readonly ScreenRow[] {
        const buffer = this.terminal.buffer.active;
        return Array.from({ length: this.rows }, (_value, index): ScreenRow => {
            const line = buffer.getLine(buffer.viewportY + index);
            if (line === undefined) return { index, text: "", isWrapped: false, cells: [] };
            const cells: ScreenCell[] = [];
            for (let column = 0; column < this.columns; column += 1) {
                const cell = line.getCell(column);
                if (cell === undefined) continue;
                cells.push({
                    chars: cell.getChars(),
                    isAttributeDefault: cell.isAttributeDefault(),
                    isForegroundDefault: cell.isFgDefault(),
                    isBackgroundDefault: cell.isBgDefault(),
                    isBold: cell.isBold() !== 0,
                    isDim: cell.isDim() !== 0,
                    isInverse: cell.isInverse() !== 0,
                });
            }
            return {
                index,
                text: line.translateToString(true),
                isWrapped: line.isWrapped,
                cells,
            };
        });
    }

    screenText(): string {
        const rows = this.interpretedRows().map((row) => row.text);
        while (rows.at(-1) === "") rows.pop();
        return rows.join("\n");
    }

    assertScreenFits(): void;
    assertScreenFits(topRow: number, bottomRow: number, wrappedRowExclusion?: number): void;
    assertScreenFits(topRow = 0, bottomRow = this.rows - 1, wrappedRowExclusion?: number): void {
        if (
            !Number.isInteger(topRow) ||
            !Number.isInteger(bottomRow) ||
            topRow < 0 ||
            bottomRow < topRow ||
            bottomRow >= this.rows
        ) {
            throw new RangeError(
                `terminal row range ${topRow}-${bottomRow} is outside 0-${this.rows - 1}`,
            );
        }
        for (const row of this.interpretedRows()) {
            if (row.index < topRow || row.index > bottomRow) continue;
            if (row.isWrapped && row.index !== wrappedRowExclusion)
                throw new Error(
                    `terminal row ${row.index} wrapped: ${JSON.stringify(row.text)}\n${this.screenText()}`,
                );
            if (visibleWidth(row.text) > this.columns) {
                throw new Error(
                    `terminal row ${row.index} exceeds ${this.columns} columns\n${this.screenText()}`,
                );
            }
        }
    }

    assertLineEndsWithDefaultStyle(): void {
        for (const row of this.interpretedRows()) {
            const tail = row.cells.slice(visibleWidth(row.text));
            const styledCell = tail.find(
                (cell) =>
                    !cell.isAttributeDefault ||
                    !cell.isForegroundDefault ||
                    !cell.isBackgroundDefault ||
                    cell.isBold ||
                    cell.isDim ||
                    cell.isInverse,
            );
            if (styledCell !== undefined) {
                throw new Error(
                    `terminal row ${row.index} leaked style past its content\n${this.screenText()}`,
                );
            }
        }
    }

    dispose(): void {
        this.terminal.dispose();
    }
}
