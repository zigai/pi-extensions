import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { Type, type StaticDecode } from "typebox";
import { EventStream } from "./event-stream.ts";

export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMEOUT_SECONDS = 1800;
export const MAX_FRAME_BYTES = 1024 * 1024;

const descriptionSchema = Type.String({
    minLength: 1,
    description:
        'Short, specific description of what is being watched, shown with every event (for example "errors in deploy.log").',
});

const timeoutSchema = Type.Optional(
    Type.Integer({
        minimum: 1,
        maximum: MAX_TIMEOUT_SECONDS,
        description: `Seconds before the monitor expires and is stopped (default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS}). You get one notice at expiry and can start it again.`,
    }),
);

export const commandArgsSchema = Type.Object({
    description: descriptionSchema,
    command: Type.String({
        minLength: 1,
        description:
            "Shell command or script. Each stdout line is an event; exit ends the watch. Stderr goes only to the output file.",
    }),
    cwd: Type.Optional(
        Type.String({
            description: "Working directory, relative to the current project or absolute",
        }),
    ),
    timeout: timeoutSchema,
});

export const websocketArgsSchema = Type.Object({
    description: descriptionSchema,
    url: Type.String({ minLength: 1, description: "ws:// or wss:// URL" }),
    protocols: Type.Optional(
        Type.Array(Type.String({ pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" }), {
            uniqueItems: true,
            description: "WebSocket subprotocols to request",
        }),
    ),
    timeout: timeoutSchema,
});

export const listArgsSchema = Type.Object({});

export const monitorArgsSchema = Type.Object({
    id: Type.String({
        minLength: 1,
        description: "Monitor ID returned by monitor or monitor_websocket",
    }),
});

const sourceSchema = Type.Union([
    Type.Object(
        { kind: Type.Literal("command"), command: Type.String(), cwd: Type.String() },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Literal("websocket"),
            url: Type.String(),
            protocols: Type.Array(Type.String()),
        },
        { additionalProperties: false },
    ),
]);

export const monitorSchema = Type.Object(
    {
        id: Type.String(),
        description: Type.String(),
        source: sourceSchema,
        outputPath: Type.String(),
        state: Type.Enum(["running", "ended", "failed", "stopped", "expired", "flooded"]),
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        eventCount: Type.Integer(),
        startedAt: Type.Number({ description: "Start time in milliseconds since the epoch" }),
        endedAt: Type.Union([Type.Number(), Type.Null()]),
        timeoutSeconds: Type.Integer(),
    },
    { additionalProperties: false },
);

export const stopOutputSchema = Type.Object(
    { monitor: monitorSchema, pending: Type.String() },
    { additionalProperties: false },
);

export const listOutputSchema = Type.Object(
    { monitors: Type.Array(monitorSchema) },
    { additionalProperties: false },
);

export type CommandArgs = StaticDecode<typeof commandArgsSchema>;
export type WebSocketArgs = StaticDecode<typeof websocketArgsSchema>;
export type MonitorArgs = StaticDecode<typeof monitorArgsSchema>;
export type ListArgs = StaticDecode<typeof listArgsSchema>;
export type MonitorSnapshot = StaticDecode<typeof monitorSchema>;
export type MonitorSource = StaticDecode<typeof sourceSchema>;
export type StopResult = StaticDecode<typeof stopOutputSchema>;

/** One message for the agent: an event, or the notice that ends a monitor. */
export type MonitorNotification = {
    readonly monitor: MonitorSnapshot;
    readonly kind: "event" | "end";
    readonly summary: string;
    readonly text: string;

    /** False when the message should join the context without starting a turn. */
    readonly wake: boolean;
};

type Monitor = {
    readonly id: string;
    readonly description: string;
    readonly source: MonitorSource;
    readonly outputPath: string;
    readonly startedAt: number;
    readonly timeoutSeconds: number;
    readonly events: EventStream;
    readonly controller: AbortController;
    state: MonitorSnapshot["state"];
    exitCode: number | null;
    endedAt: number | null;
    completion: Promise<void>;
};

export type MonitorsOptions = {
    readonly operations: BashOperations;
    readonly directory: string;
    readonly onNotification: (notification: MonitorNotification) => void;

    /** Called whenever a monitor starts or ends, for status displays. */
    readonly onChange: () => void;
};

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function createId(): string {
    let id = "m";
    for (const byte of randomBytes(8)) id += ID_ALPHABET[byte % ID_ALPHABET.length];

    return id;
}

function snapshot(monitor: Monitor): MonitorSnapshot {
    return {
        id: monitor.id,
        description: monitor.description,
        source: monitor.source,
        outputPath: monitor.outputPath,
        state: monitor.state,
        exitCode: monitor.exitCode,
        eventCount: monitor.events.eventCount,
        startedAt: monitor.startedAt,
        endedAt: monitor.endedAt,
        timeoutSeconds: monitor.timeoutSeconds,
    };
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatDuration(milliseconds: number): string {
    const total = Math.max(0, Math.round(milliseconds / 1_000));
    const hours = Math.floor(total / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    const seconds = total % 60;
    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(" ");
}

function validateWebSocketUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("WebSocket URL is not a valid URL.");
    }

    if (url.protocol !== "ws:" && url.protocol !== "wss:")
        throw new Error("WebSocket URL must start with ws:// or wss://.");
    if (url.username !== "" || url.password !== "")
        throw new Error("WebSocket URL must not contain credentials.");

    return url.href;
}

export class Monitors {
    private readonly monitors = new Map<string, Monitor>();
    private readonly operations: BashOperations;
    private readonly directory: string;
    private readonly onNotification: (notification: MonitorNotification) => void;
    private readonly onChange: () => void;
    private closed = false;

    constructor(options: MonitorsOptions) {
        this.operations = options.operations;
        this.directory = options.directory;
        this.onNotification = options.onNotification;
        this.onChange = options.onChange;
    }

    startCommand(args: CommandArgs, cwd: string): MonitorSnapshot {
        return this.start(
            { kind: "command", command: args.command, cwd },
            args.description,
            args.timeout,
        );
    }

    startWebSocket(args: WebSocketArgs): MonitorSnapshot {
        return this.start(
            {
                kind: "websocket",
                url: validateWebSocketUrl(args.url),
                protocols: args.protocols ?? [],
            },
            args.description,
            args.timeout,
        );
    }

    private start(
        source: MonitorSource,
        description: string,
        timeout: number | undefined,
    ): MonitorSnapshot {
        if (this.closed) throw new Error("Monitors are closed for this session.");

        const timeoutSeconds = timeout ?? DEFAULT_TIMEOUT_SECONDS;
        if (
            !Number.isInteger(timeoutSeconds) ||
            timeoutSeconds < 1 ||
            timeoutSeconds > MAX_TIMEOUT_SECONDS
        )
            throw new Error(
                `Monitor timeout must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}.`,
            );

        let id = createId();
        while (this.monitors.has(id)) id = createId();

        mkdirSync(this.directory, { recursive: true, mode: 0o700 });

        const outputPath = join(this.directory, `${id}.log`);
        closeSync(openSync(outputPath, "wx", 0o600));

        let current: Monitor | undefined;
        const events = new EventStream({
            onEvent: (text) => {
                if (current !== undefined) this.notifyEvent(current, text);
            },
            onFlood: (notice) => {
                if (current !== undefined) this.end(current, "flooded", notice);
            },
        });
        const monitor: Monitor = {
            id,
            description,
            source,
            outputPath,
            startedAt: Date.now(),
            timeoutSeconds,
            events,
            controller: new AbortController(),
            state: "running",
            exitCode: null,
            endedAt: null,
            completion: Promise.resolve(),
        };

        current = monitor;
        this.monitors.set(id, monitor);

        const deadline = setTimeout(() => {
            const count = monitor.events.eventCount;
            let notice = `[Monitor expired after ${formatDuration(timeoutSeconds * 1_000)} with ${count} event(s) delivered. Start it again if you still need the watch.]`;
            if (count === 0)
                notice = `[Monitor expired after ${formatDuration(timeoutSeconds * 1_000)} with no events delivered. Start it again if you still need the watch, and widen the filter if silence was unexpected.]`;

            this.end(monitor, "expired", notice);
        }, timeoutSeconds * 1_000);

        let run: Promise<void>;
        if (source.kind === "command") run = this.runCommand(monitor, source);
        else run = this.runWebSocket(monitor, source);

        monitor.completion = run.finally(() => {
            clearTimeout(deadline);
        });
        this.onChange();

        return snapshot(monitor);
    }

    list(): MonitorSnapshot[] {
        return [...this.monitors.values()].map(snapshot);
    }

    get(id: string): MonitorSnapshot {
        return snapshot(this.lookup(id));
    }

    /** Stops a monitor and returns undelivered lines. The agent hears of it only with `notify`. */
    async stop(id: string, options: { notify?: boolean } = {}): Promise<StopResult> {
        const monitor = this.lookup(id);
        let pending = "";
        if (monitor.state === "running") {
            pending = monitor.events.drain();
            this.finish(monitor, "stopped");

            if (options.notify === true) {
                this.emit(monitor, {
                    kind: "end",
                    summary: `Monitor "${monitor.description}" was stopped by the user`,
                    text: pending,
                    wake: false,
                });
            }

            monitor.controller.abort();
            await monitor.completion;
        }

        return { monitor: snapshot(monitor), pending };
    }

    async dispose(): Promise<void> {
        this.closed = true;

        const running = [...this.monitors.values()].filter(
            (monitor) => monitor.state === "running",
        );
        for (const monitor of running) {
            monitor.events.drain();
            this.finish(monitor, "stopped");
            monitor.controller.abort();
        }

        await Promise.all(running.map(async (monitor) => monitor.completion));
    }

    private lookup(id: string): Monitor {
        const monitor = this.monitors.get(id);
        if (monitor === undefined) throw new Error(`Unknown monitor: ${id}`);
        return monitor;
    }

    private append(monitor: Monitor, text: string): void {
        try {
            appendFileSync(monitor.outputPath, text);
        } catch {
            // The output file is a convenience copy; events still reach the agent.
        }
    }

    private notifyEvent(monitor: Monitor, text: string): void {
        if (monitor.state !== "running") return;

        this.emit(monitor, {
            kind: "event",
            summary: `Monitor event: "${monitor.description}"`,
            text,
            wake: true,
        });
    }

    private emit(monitor: Monitor, notification: Omit<MonitorNotification, "monitor">): void {
        if (this.closed) return;
        try {
            this.onNotification({ monitor: snapshot(monitor), ...notification });
        } catch {
            console.error("A monitor notification could not be delivered.");
        }
    }

    private finish(monitor: Monitor, state: MonitorSnapshot["state"]): void {
        monitor.state = state;
        monitor.endedAt = Date.now();

        let trailer = `\n[${state}]\n`;
        if (monitor.exitCode !== null) trailer = `\n[exited with code ${monitor.exitCode}]\n`;
        this.append(monitor, trailer);

        if (!this.closed) this.onChange();
    }

    /** Ends a running monitor from its own deadline or rate limit and notifies the agent. */
    private end(monitor: Monitor, state: "expired" | "flooded", notice: string): void {
        if (monitor.state !== "running") return;

        const pending = monitor.events.drain();

        this.finish(monitor, state);
        this.emit(monitor, {
            kind: "end",
            summary: notice,
            text: pending,
            wake: true,
        });

        monitor.controller.abort();
    }

    /** Ends a monitor whose source finished on its own. */
    private settle(monitor: Monitor, state: "ended" | "failed", summary: string): void {
        if (monitor.state !== "running") return;

        const pending = monitor.events.drain();

        this.finish(monitor, state);
        this.emit(monitor, { kind: "end", summary, text: pending, wake: true });
    }

    private async runCommand(
        monitor: Monitor,
        source: Extract<MonitorSource, { kind: "command" }>,
    ): Promise<void> {
        const decoder = new StringDecoder("utf8");
        const wrapped = `{\n${source.command}\n} 2>>${shellQuote(monitor.outputPath)}`;
        let descriptor: number | undefined;
        let writable = true;

        try {
            descriptor = openSync(monitor.outputPath, "a");
        } catch {
            writable = false;
        }

        let exitCode: number | null = null;
        let error: string | undefined;

        try {
            const result = await this.operations.exec(wrapped, source.cwd, {
                signal: monitor.controller.signal,
                onData: (data) => {
                    if (writable && descriptor !== undefined) {
                        try {
                            writeSync(descriptor, data);
                        } catch {
                            writable = false;
                        }
                    }

                    const text = decoder.write(data);
                    monitor.events.push(text);
                },
            });

            exitCode = result.exitCode;
        } catch (cause) {
            if (!monitor.controller.signal.aborted) {
                error = "the command could not be started";
                if (cause instanceof Error) error = cause.message;
            }
        } finally {
            if (descriptor !== undefined) closeSync(descriptor);
        }

        if (monitor.state !== "running") return;

        monitor.events.push(decoder.end());
        monitor.exitCode = exitCode;

        const name = `Monitor "${monitor.description}"`;
        if (error !== undefined) {
            this.settle(monitor, "failed", `${name} failed: ${error}`);
        } else if (exitCode === 0 && monitor.events.lineCount > 0) {
            this.settle(monitor, "ended", `${name} stream ended (exit 0)`);
        } else if (exitCode === 0) {
            this.settle(monitor, "ended", `${name} ended without producing output (exit 0)`);
        } else if (exitCode === null) {
            this.settle(monitor, "failed", `${name} script ended without an exit code`);
        } else {
            this.settle(
                monitor,
                "failed",
                `${name} script failed (exit ${exitCode}). Stderr is in ${monitor.outputPath}`,
            );
        }
    }

    private async runWebSocket(
        monitor: Monitor,
        source: Extract<MonitorSource, { kind: "websocket" }>,
    ): Promise<void> {
        const name = `Monitor "${monitor.description}"`;
        let socket: WebSocket;
        try {
            socket = new WebSocket(source.url, source.protocols);
        } catch (cause) {
            let message = "the socket could not be opened";
            if (cause instanceof Error) message = cause.message;
            this.settle(monitor, "failed", `${name} failed: ${message}`);

            return;
        }

        socket.binaryType = "arraybuffer";

        await new Promise<void>((resolve) => {
            let error: string | undefined;
            const onAbort = (): void => {
                socket.close(1000);
                resolve();
            };

            monitor.controller.signal.addEventListener("abort", onAbort, { once: true });

            // With binaryType "arraybuffer", a frame is a string or an ArrayBuffer.
            socket.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
                const data = event.data;
                if (data instanceof ArrayBuffer) {
                    const line = `[binary frame, ${data.byteLength} bytes]`;
                    this.append(monitor, `${line}\n`);
                    monitor.events.pushMessage(line);
                    return;
                }

                const size = Buffer.byteLength(data);
                if (size > MAX_FRAME_BYTES) {
                    const line = `[Dropped ${size}-byte frame (exceeds ${MAX_FRAME_BYTES}); closing]`;
                    this.append(monitor, `${line}\n`);
                    monitor.events.pushMessage(line);
                    socket.close(1009);
                    return;
                }

                this.append(monitor, `${data}\n`);
                monitor.events.pushMessage(data);
            });

            socket.addEventListener("error", (event: Event) => {
                error = "connection error";
                if (event instanceof ErrorEvent && event.message !== "") error = event.message;
                this.append(monitor, `[WebSocket error: ${error}]\n`);
            });

            socket.addEventListener("close", (event: CloseEvent) => {
                monitor.controller.signal.removeEventListener("abort", onAbort);

                let detail = `code ${event.code}`;
                if (event.reason !== "") detail += ` ${event.reason}`;
                this.append(monitor, `[WebSocket closed: ${detail}]\n`);

                if (error !== undefined && event.code !== 1000) {
                    this.settle(monitor, "failed", `${name} failed: ${error} (${detail})`);
                } else if (event.code === 1000 || event.code === 1005) {
                    this.settle(monitor, "ended", `${name} connection closed (${detail})`);
                } else {
                    this.settle(monitor, "failed", `${name} connection closed (${detail})`);
                }

                resolve();
            });
        });
    }
}
