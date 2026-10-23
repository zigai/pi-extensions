import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { TuiMainScreen, type Component, type Terminal } from "@earendil-works/pi-tui";
import { installLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { installMainScreenSynchronizedOutputPatch } from "../src/main-screen-synchronized-output.ts";

const BEGIN = "\u001b[?2026h";
const END = "\u001b[?2026l";
const enabled = { mainScreenSynchronizedOutput: true };

class RecordingTerminal implements Terminal {
    columns = 30;
    rows = 10;
    readonly writes: string[] = [];

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

    setProgramStatus(): void {}
}

class FixedComponent implements Component {
    render(): string[] {
        return ["FRAME"];
    }

    invalidate(): void {}
}

test("main-screen frame presents content and final hardware cursor atomically", () => {
    const terminal = new RecordingTerminal();
    const prototype = {
        doRender(this: { terminal: Terminal }): void {
            this.terminal.write(`${BEGIN}FRAME${END}`);
            this.terminal.write("CURSOR-POSITION");
            this.terminal.write("CURSOR-VISIBILITY");
        },
    };
    const handle = installMainScreenSynchronizedOutputPatch(enabled, prototype);
    try {
        prototype.doRender.call({ terminal });
        assert.equal(
            terminal.writes.join(""),
            `${BEGIN}FRAMECURSOR-POSITIONCURSOR-VISIBILITY${END}`,
        );
    } finally {
        handle.dispose();
    }
});

test("main-screen synchronization preserves bounded terminal writes", () => {
    const terminal = new RecordingTerminal();
    const chunk = "x".repeat(1024 * 1024);
    const prototype = {
        doRender(this: { terminal: Terminal }): void {
            this.terminal.write(`${BEGIN}${chunk.slice(BEGIN.length)}`);
            this.terminal.write(chunk);
            this.terminal.write(chunk);
            this.terminal.write(END);
        },
    };
    const handle = installMainScreenSynchronizedOutputPatch(enabled, prototype);
    try {
        prototype.doRender.call({ terminal });
        assert.equal(
            terminal.writes.every((write) => write.length <= chunk.length),
            true,
        );
        assert.equal(
            terminal.writes.join(""),
            `${BEGIN}${chunk.slice(BEGIN.length)}${chunk}${chunk}${END}`,
        );
    } finally {
        handle.dispose();
    }
});

test.each([1, 2, 3, 4, 5, 6, 7])(
    "main-screen synchronization strips controls split after character %i",
    (split) => {
        const terminal = new RecordingTerminal();
        const prototype = {
            doRender(this: { terminal: Terminal }): void {
                this.terminal.write(BEGIN.slice(0, split));
                this.terminal.write(`${BEGIN.slice(split)}FRAME${END.slice(0, split)}`);
                this.terminal.write(END.slice(split));
                this.terminal.write("CURSOR");
            },
        };
        const handle = installMainScreenSynchronizedOutputPatch(enabled, prototype);
        try {
            prototype.doRender.call({ terminal });
            assert.equal(terminal.writes.join(""), `${BEGIN}FRAMECURSOR${END}`);
        } finally {
            handle.dispose();
        }
    },
);

test("real process-terminal cursor visibility stays inside the synchronized frame", () => {
    const source = fileURLToPath(
        new URL("../src/main-screen-synchronized-output.ts", import.meta.url),
    );
    const output = execFileSync(
        process.execPath,
        [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `import { ProcessTerminal } from "@earendil-works/pi-tui";
        import { installMainScreenSynchronizedOutputPatch } from ${JSON.stringify(source)};
        const terminal = new ProcessTerminal();
        const target = { doRender() {
            this.terminal.write("FRAME");
            this.terminal.write("CURSOR");
            this.terminal.showCursor();
            this.terminal.hideCursor();
        }};
        const handle = installMainScreenSynchronizedOutputPatch({ mainScreenSynchronizedOutput: true }, target);
        try { target.doRender.call({ terminal }); } finally { handle.dispose(); }`,
        ],
        { encoding: "utf8", env: { ...process.env, TSX_DISABLE_CACHE: "1" } },
    );
    assert.equal(output, `${BEGIN}FRAMECURSOR\u001b[?25h\u001b[?25l${END}`);
});

test("main-screen synchronization does not emit an empty transaction", () => {
    const terminal = new RecordingTerminal();
    const prototype = { doRender(): void {} };
    const handle = installMainScreenSynchronizedOutputPatch(enabled, prototype);
    try {
        prototype.doRender.call({ terminal });
        assert.deepEqual(terminal.writes, []);
    } finally {
        handle.dispose();
    }
});

test("real main-screen render encloses output in one synchronized transaction", () => {
    const handle = installMainScreenSynchronizedOutputPatch(enabled);
    try {
        const terminal = new RecordingTerminal();
        const tui = new TuiMainScreen(terminal);
        tui.addChild(new FixedComponent());
        tui.renderNow();
        const output = terminal.writes.join("");
        assert.equal(output.startsWith(BEGIN), true);
        assert.equal(output.endsWith(END), true);
        assert.equal(output.split(BEGIN).length, 2);
        assert.equal(output.split(END).length, 2);
        assert.match(output, /FRAME/u);
    } finally {
        handle.dispose();
    }
});

test("main-screen synchronization restores inherited terminal writes after failure", () => {
    class InheritedTerminal extends RecordingTerminal {}

    const terminal = new InheritedTerminal();
    const prototype = {
        doRender(this: { terminal: Terminal }): void {
            this.terminal.write("PARTIAL");
            throw new Error("render failed");
        },
    };
    const handle = installMainScreenSynchronizedOutputPatch(enabled, prototype);
    try {
        assert.equal(Object.hasOwn(terminal, "write"), false);
        assert.throws(() => prototype.doRender.call({ terminal }), /render failed/u);
        assert.equal(Object.hasOwn(terminal, "write"), false);
        assert.equal(terminal.writes.join(""), `${BEGIN}PARTIAL${END}`);
    } finally {
        handle.dispose();
    }
});

test("installation is keyed, policy is updateable, and disposal preserves linked successors", () => {
    const terminal = new RecordingTerminal();
    const prototype = {
        doRender(this: { terminal: Terminal }): void {
            this.terminal.write("FRAME");
            this.terminal.write("CURSOR");
        },
    };
    const original = Object.getOwnPropertyDescriptor(prototype, "doRender");
    const handle = installMainScreenSynchronizedOutputPatch(enabled, prototype);
    const first = Object.getOwnPropertyDescriptor(prototype, "doRender");
    const again = installMainScreenSynchronizedOutputPatch(enabled, prototype);
    assert.equal(again, handle);
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "doRender"), first);
    handle.update({ mainScreenSynchronizedOutput: false });
    prototype.doRender.call({ terminal });
    assert.deepEqual(terminal.writes, ["FRAME", "CURSOR"]);
    terminal.writes.length = 0;
    handle.update(enabled);
    const successor = installLinkedMethodPatch(
        prototype,
        "doRender",
        (predecessor) =>
            function () {
                predecessor.call(this);
            },
    );
    handle.dispose();
    handle.dispose();
    prototype.doRender.call({ terminal });
    assert.deepEqual(terminal.writes, ["FRAME", "CURSOR"]);
    successor.dispose();
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "doRender"), original);
});

test("own terminal write descriptors are restored exactly", () => {
    const terminal = new RecordingTerminal();
    Object.defineProperty(terminal, "write", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: terminal.write.bind(terminal),
    });
    const before = Object.getOwnPropertyDescriptor(terminal, "write");
    const prototype = {
        doRender(this: { terminal: Terminal }): void {
            this.terminal.write("FRAME");
        },
    };
    const handle = installMainScreenSynchronizedOutputPatch(enabled, prototype);
    try {
        prototype.doRender.call({ terminal });
        assert.deepEqual(Object.getOwnPropertyDescriptor(terminal, "write"), before);
        assert.equal(terminal.writes.join(""), `${BEGIN}FRAME${END}`);
    } finally {
        handle.dispose();
    }
});
