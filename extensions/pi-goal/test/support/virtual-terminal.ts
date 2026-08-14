import { visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { Terminal as HeadlessTerminal } from "@xterm/headless";

export type InterpretedCell = {
  readonly chars: string;
  readonly isAttributeDefault: boolean;
  readonly isForegroundDefault: boolean;
  readonly isBackgroundDefault: boolean;
  readonly isBold: boolean;
  readonly isDim: boolean;
};

export type InterpretedRow = {
  readonly index: number;
  readonly text: string;
  readonly isWrapped: boolean;
  readonly cells: readonly InterpretedCell[];
};

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    const onDelayElapsed = (): void => {
      resolve();
    };
    setTimeout(onDelayElapsed, milliseconds);
  });
}

function countOccurrences(text: string, search: string): number {
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
      scrollback: 1_000,
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
    const writeToParser = (): Promise<void> => {
      return new Promise<void>((resolve: () => void): void => {
        const onWriteParsed = (): void => {
          resolve();
        };
        this.terminal.write(data, onWriteParsed);
      });
    };
    this.pendingWrites = this.pendingWrites.then(writeToParser);
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

  rawWrites(): string {
    return this.writes.join("");
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
          isAttributeDefault: cell.isAttributeDefault(),
          isForegroundDefault: cell.isFgDefault(),
          isBackgroundDefault: cell.isBgDefault(),
          isBold: cell.isBold() !== 0,
          isDim: cell.isDim() !== 0,
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

  countOccurrences(search: string): number {
    return countOccurrences(this.screenText(), search);
  }

  requireRowContaining(text: string): InterpretedRow {
    const rows = this.interpretedRows().filter((row) => row.text.includes(text));
    if (rows.length === 1 && rows[0] !== undefined) return rows[0];
    throw new Error(`expected one row containing ${JSON.stringify(text)}, found ${rows.length}`);
  }

  assertNeutralRow(text: string): void {
    const row = this.requireRowContaining(text);
    const changedCell = row.cells.find(
      (cell) =>
        !cell.isAttributeDefault ||
        !cell.isForegroundDefault ||
        !cell.isBackgroundDefault ||
        cell.isBold ||
        cell.isDim,
    );
    if (changedCell !== undefined)
      throw new Error(`row containing ${JSON.stringify(text)} is styled`);
  }

  assertGeometry(): void {
    const invalid = this.interpretedRows().find(
      (row) => row.isWrapped || visibleWidth(row.text) > this.columns,
    );
    if (invalid !== undefined) {
      throw new Error(`terminal row ${invalid.index} wrapped or exceeded ${this.columns} columns`);
    }
  }

  assertUnique(...markers: readonly string[]): void {
    for (const marker of markers) {
      const count = this.countOccurrences(marker);
      if (count !== 1) throw new Error(`${JSON.stringify(marker)} occurred ${count} times`);
    }
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
