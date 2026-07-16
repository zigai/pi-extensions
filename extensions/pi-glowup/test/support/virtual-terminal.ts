import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { Terminal } from "@earendil-works/pi-tui";

export type InterpretedCell = {
    readonly chars: string;
    readonly width: number;
    readonly foreground: number;
    readonly background: number;
    readonly isForegroundDefault: boolean;
    readonly isBackgroundDefault: boolean;
    readonly isBold: boolean;
    readonly isDim: boolean;
    readonly isAttributeDefault: boolean;
};

export type InterpretedRow = {
    readonly text: string;
    readonly isWrapped: boolean;
    readonly cells: readonly InterpretedCell[];
};

function delay(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
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
                rows.push({ text: "", isWrapped: false, cells: [] });
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
                    isBold: cell.isBold() !== 0,
                    isDim: cell.isDim() !== 0,
                    isAttributeDefault: cell.isAttributeDefault(),
                });
            }
            rows.push({
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

    dispose(): void {
        this.terminal.dispose();
    }
}
