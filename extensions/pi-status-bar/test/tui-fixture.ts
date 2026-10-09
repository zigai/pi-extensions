import { TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";

export class FakeTerminal implements Terminal {
    columns = 48;
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

export class RenderCountingTui extends TuiMainScreen {
    renderRequests = 0;

    constructor() {
        super(new FakeTerminal());
    }

    override requestRender(): void {
        this.renderRequests += 1;
    }
}
