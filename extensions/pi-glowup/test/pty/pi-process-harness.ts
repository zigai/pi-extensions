import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { spawn, type IPty } from "node-pty";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const SYNCHRONIZED_OUTPUT_END = "\u001b[?2026l";
const MAX_RAW_OUTPUT_BYTES = 4 * 1024 * 1024;

export type PtyScreenRow = {
    readonly text: string;
    readonly isWrapped: boolean;
};

export type PtyScreenFrame = {
    readonly sequence: number;
    readonly elapsedMs: number;
    readonly columns: number;
    readonly rows: readonly PtyScreenRow[];
    readonly text: string;
};

export type PiProcessOptions = {
    readonly cwd: string;
    readonly agentDir: string;
    readonly columns: number;
    readonly rows: number;
    readonly sessionPath?: string;
    readonly initialPrompt?: string;
    readonly tuiMode?: "regular" | "fullscreen";
};

type ProcessExit = {
    readonly exitCode: number;
    readonly signal: number | undefined;
};

function delay(delayMs: number): Promise<void> {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

function processEnvironment(agentDir: string): Record<string, string> {
    const environment: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        SHELL: process.env.SHELL ?? "/bin/sh",
        LANG: process.env.LANG ?? "C.UTF-8",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        NODE_OPTIONS: `--import=${resolve("test/pty/fixtures/no-network.js")}`,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_CLEAR_ON_SHRINK: "1",
    };
    if (process.env.TMPDIR !== undefined) environment.TMPDIR = process.env.TMPDIR;
    return environment;
}

function screenRows(terminal: HeadlessTerminal): readonly PtyScreenRow[] {
    const buffer = terminal.buffer.active;
    const rows: PtyScreenRow[] = [];
    for (let viewportRow = 0; viewportRow < terminal.rows; viewportRow += 1) {
        const line = buffer.getLine(buffer.viewportY + viewportRow);
        rows.push({
            text: line?.translateToString(true) ?? "",
            isWrapped: line?.isWrapped ?? false,
        });
    }
    return rows;
}

function rowsText(rows: readonly PtyScreenRow[]): string {
    const texts = rows.map((row) => row.text);
    while (texts.at(-1) === "") texts.pop();
    return texts.join("\n");
}

function formatCause(cause: unknown): string {
    return cause instanceof Error
        ? `${cause.name}: ${cause.message}\n${cause.stack ?? ""}`
        : String(cause);
}

/** Actual Pi child process in a native PTY with every synchronized render interpreted by xterm. */
export class PiPtyProcess {
    private readonly terminal: HeadlessTerminal;
    private readonly process: IPty;
    private readonly startedAt = performance.now();
    private readonly command: readonly string[];
    private readonly capturedFrames: PtyScreenFrame[] = [];
    private rawOutput = "";
    private pendingAnsi = "";
    private parseQueue: Promise<void> = Promise.resolve();
    private exitState: ProcessExit | undefined;
    private readonly exitPromise: Promise<ProcessExit>;

    constructor(options: PiProcessOptions) {
        this.terminal = new HeadlessTerminal({
            allowProposedApi: true,
            cols: options.columns,
            rows: options.rows,
            scrollback: 4_000,
        });
        const cliPath = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
        const args = [
            cliPath,
            "--provider",
            "pty-offline",
            "--model",
            "deterministic",
            "--offline",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--approve",
            ...(options.tuiMode === undefined ? [] : ["--tui-mode", options.tuiMode]),
            ...(options.sessionPath === undefined ? [] : ["--session", options.sessionPath]),
            ...(options.initialPrompt === undefined ? [] : [options.initialPrompt]),
        ];
        this.command = [process.execPath, ...args];
        this.process = spawn(process.execPath, args, {
            name: "xterm-256color",
            cols: options.columns,
            rows: options.rows,
            cwd: options.cwd,
            env: processEnvironment(options.agentDir),
        });
        this.process.onData((data) => this.consumePtyData(data));
        this.exitPromise = new Promise((resolveExit) => {
            this.process.onExit((event) => {
                const exit = { exitCode: event.exitCode, signal: event.signal };
                this.exitState = exit;
                this.flushTrailingAnsi();
                resolveExit(exit);
            });
        });
    }

    frames(): readonly PtyScreenFrame[] {
        return [...this.capturedFrames];
    }

    async waitForText(text: string, timeoutMs = 10_000): Promise<PtyScreenFrame> {
        return this.waitForFrame((frame) => frame.text.includes(text), timeoutMs);
    }

    async waitForFrame(
        predicate: (frame: PtyScreenFrame) => boolean,
        timeoutMs = 10_000,
        startSequence = 0,
    ): Promise<PtyScreenFrame> {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
            await this.parseQueue;
            const match = this.capturedFrames.find(
                (frame) => frame.sequence >= startSequence && predicate(frame),
            );
            if (match !== undefined) return match;
            if (this.exitState !== undefined) {
                throw new Error(
                    `Pi exited before the requested screen appeared (${this.exitState.exitCode})`,
                );
            }
            await delay(20);
        }
        throw new Error(`Timed out after ${timeoutMs}ms waiting for a Pi screen transition`);
    }

    sendText(text: string): void {
        this.process.write(text);
    }

    sendKey(data: string): void {
        this.process.write(data);
    }

    resize(columns: number, rows: number): void {
        this.terminal.resize(columns, rows);
        this.process.resize(columns, rows);
    }

    async stop(): Promise<ProcessExit> {
        if (this.exitState !== undefined) return this.exitState;
        this.process.write("\u0004");
        const graceful = await Promise.race([this.exitPromise, delay(1_500).then(() => undefined)]);
        if (graceful !== undefined) {
            await this.parseQueue;
            return graceful;
        }
        this.process.kill();
        const exit = await this.exitPromise;
        await this.parseQueue;
        return exit;
    }

    async writeFailureArtifacts(testName: string, cause: unknown): Promise<void> {
        await this.parseQueue;
        const artifactDirectory = resolve("artifacts/pty");
        mkdirSync(artifactDirectory, { recursive: true });
        const artifactBase = resolve(artifactDirectory, testName.replace(/[^a-z0-9-]+/giu, "-"));
        writeFileSync(`${artifactBase}.ansi`, this.rawOutput);
        writeFileSync(
            `${artifactBase}.json`,
            `${JSON.stringify(
                {
                    command: this.command.map((part) =>
                        part.startsWith("/") ? basename(part) : part,
                    ),
                    cause: formatCause(cause),
                    frames: this.capturedFrames,
                },
                null,
                2,
            )}\n`,
        );
    }

    private consumePtyData(data: string): void {
        if (
            Buffer.byteLength(this.rawOutput, "utf8") + Buffer.byteLength(data, "utf8") >
            MAX_RAW_OUTPUT_BYTES
        ) {
            this.process.kill();
            throw new Error(`Pi PTY output exceeded ${MAX_RAW_OUTPUT_BYTES} bytes`);
        }
        this.rawOutput += data;
        this.pendingAnsi += data;
        let frameEnd = this.pendingAnsi.indexOf(SYNCHRONIZED_OUTPUT_END);
        while (frameEnd >= 0) {
            const boundary = frameEnd + SYNCHRONIZED_OUTPUT_END.length;
            const frameAnsi = this.pendingAnsi.slice(0, boundary);
            this.pendingAnsi = this.pendingAnsi.slice(boundary);
            this.enqueueAnsi(frameAnsi, true);
            frameEnd = this.pendingAnsi.indexOf(SYNCHRONIZED_OUTPUT_END);
        }
    }

    private flushTrailingAnsi(): void {
        if (this.pendingAnsi.length === 0) return;
        const trailing = this.pendingAnsi;
        this.pendingAnsi = "";
        this.enqueueAnsi(trailing, true);
    }

    private enqueueAnsi(data: string, capture: boolean): void {
        this.parseQueue = this.parseQueue.then(
            () =>
                new Promise<void>((resolveWrite) => {
                    this.terminal.write(data, () => {
                        if (capture) this.captureFrame();
                        resolveWrite();
                    });
                }),
        );
    }

    private captureFrame(): void {
        const rows = screenRows(this.terminal);
        this.capturedFrames.push({
            sequence: this.capturedFrames.length,
            elapsedMs: Math.round(performance.now() - this.startedAt),
            columns: this.terminal.cols,
            rows,
            text: rowsText(rows),
        });
    }
}
