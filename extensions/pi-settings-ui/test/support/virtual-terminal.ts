import type { Terminal as PiTerminal } from "@earendil-works/pi-tui";
import { Terminal as HeadlessTerminal } from "@xterm/headless";

export class VirtualTerminal implements PiTerminal {
    readonly writes: string[] = [];
    private readonly terminal: HeadlessTerminal;
    private input: ((data: string) => void) | undefined;
    private resized: (() => void) | undefined;
    private _columns: number;
    private _rows: number;

    constructor(columns = 80, rows = 24) {
        this._columns = columns;
        this._rows = rows;
        this.terminal = new HeadlessTerminal({
            allowProposedApi: true,
            cols: columns,
            rows,
            scrollback: 1_000,
        });
    }

    start(onInput: (data: string) => void, onResize: () => void): void {
        this.input = onInput;
        this.resized = onResize;
    }

    stop(): void {
        this.input = undefined;
        this.resized = undefined;
    }

    async drainInput(): Promise<void> {}

    write(data: string): void {
        this.writes.push(data);
        this.terminal.write(data);
    }

    get columns(): number {
        return this._columns;
    }

    get rows(): number {
        return this._rows;
    }

    get kittyProtocolActive(): boolean {
        return false;
    }

    feed(data: string): void {
        if (this.input === undefined) throw new Error("Virtual terminal is not started.");

        this.input(data);
    }

    resize(columns: number, rows: number): void {
        this._columns = columns;
        this._rows = rows;
        this.terminal.resize(columns, rows);
        this.resized?.();
    }

    async settle(): Promise<void> {
        await new Promise<void>((resolve) => this.terminal.write("", resolve));
    }

    screenRows(): string[] {
        const buffer = this.terminal.buffer.active;
        const rows: string[] = [];
        for (let row = 0; row < this._rows; row += 1) {
            rows.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
        }

        return rows;
    }

    screenText(): string {
        const rows = this.screenRows();
        while (rows.at(-1) === "") rows.pop();

        return rows.join("\n");
    }

    wrappedRows(): number[] {
        const buffer = this.terminal.buffer.active;
        const rows: number[] = [];
        for (let row = 0; row < this._rows; row += 1) {
            if (buffer.getLine(buffer.viewportY + row)?.isWrapped === true) rows.push(row);
        }

        return rows;
    }

    styledRightMarginCells(): Array<{ column: number; row: number }> {
        const buffer = this.terminal.buffer.active;
        const cells: Array<{ column: number; row: number }> = [];
        for (let row = 0; row < this._rows; row += 1) {
            const line = buffer.getLine(buffer.viewportY + row);
            let finalContentColumn = -1;
            for (let column = this._columns - 1; column >= 0; column -= 1) {
                if (line?.getCell(column)?.getChars().trim() !== "") {
                    finalContentColumn = column;
                    break;
                }
            }

            for (let column = finalContentColumn + 1; column < this._columns; column += 1) {
                const cell = line?.getCell(column);
                if (cell !== undefined && !cell.isAttributeDefault()) cells.push({ column, row });
            }
        }

        return cells;
    }

    rawOutput(): string {
        return this.writes.join("");
    }

    moveBy(lines: number): void {
        if (lines > 0) this.write(`\u001b[${lines}B`);
        if (lines < 0) this.write(`\u001b[${-lines}A`);
    }

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

    setTitle(title: string): void {
        this.write(`\u001b]0;${title}\u0007`);
    }

    setProgress(): void {}

    dispose(): void {
        this.terminal.dispose();
    }
}
