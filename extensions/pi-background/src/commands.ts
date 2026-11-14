import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    DEFAULT_MAX_BYTES,
    truncateTail,
    type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { Type, type StaticDecode } from "typebox";

export const DEFAULT_TASK_TIMEOUT_SECONDS = 1800;
export const MAX_TASK_TIMEOUT_SECONDS = 7200;

export const startArgsSchema = Type.Object({
    command: Type.String({ minLength: 1, description: "Shell command to execute" }),
    kind: Type.Optional(
        Type.Enum(["task", "service"], {
            description:
                "task (default): finite work to collect before your final answer. service: a server or watcher that stays running; verify readiness instead of waiting for exit.",
        }),
    ),
    cwd: Type.Optional(
        Type.String({
            description: "Working directory, relative to the current project or absolute",
        }),
    ),
    timeout: Type.Optional(
        Type.Integer({
            minimum: 1,
            maximum: MAX_TASK_TIMEOUT_SECONDS,
            description: `Seconds before a task is stopped together with its child processes (default ${DEFAULT_TASK_TIMEOUT_SECONDS}, maximum ${MAX_TASK_TIMEOUT_SECONDS}). Set it near the longest the command should need. Services take no timeout.`,
        }),
    ),
});

export const jobArgsSchema = Type.Object({
    id: Type.String({ minLength: 1, description: "Job ID returned by background_start" }),
});

export const waitArgsSchema = Type.Object({
    timeout: Type.Optional(
        Type.Number({
            minimum: 1,
            maximum: 120,
            description:
                "Maximum seconds to wait before returning progress for inspection (default 60, maximum 120). Commands keep running.",
        }),
    ),
    ids: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
            uniqueItems: true,
            description:
                "Task IDs to wait for. Omit to collect all outstanding tasks, including finished results not yet collected. Services cannot be waited on.",
        }),
    ),
});

export const commandSchema = Type.Object(
    {
        id: Type.String(),
        command: Type.String(),
        kind: Type.Enum(["task", "service"]),
        cwd: Type.String(),
        outputPath: Type.String(),
        state: Type.Enum(["running", "completed", "stopped", "timed_out", "failed"]),
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        error: Type.Union([Type.String(), Type.Null()]),
        startedAt: Type.Number({ description: "Start time in milliseconds since the epoch" }),
        endedAt: Type.Union([Type.Number(), Type.Null()]),
        lastOutputAt: Type.Union([Type.Number(), Type.Null()]),
        timeoutSeconds: Type.Union([Type.Integer(), Type.Null()]),
    },
    { additionalProperties: false },
);

export const outputSchema = Type.Object(
    {
        job: commandSchema,
        output: Type.String(),
        truncated: Type.Boolean(),
    },
    { additionalProperties: false },
);

export const waitOutputSchema = Type.Object(
    { jobs: Type.Array(outputSchema), timedOut: Type.Boolean() },
    { additionalProperties: false },
);

export type CommandSnapshot = StaticDecode<typeof commandSchema>;
export type CommandOutput = StaticDecode<typeof outputSchema>;

type Outcome =
    | { state: "running" }
    | { state: "completed"; exitCode: number }
    | { state: "stopped" }
    | { state: "timed_out" }
    | { state: "failed"; error: string };

type Command = {
    readonly id: string;
    readonly command: string;
    readonly kind: CommandSnapshot["kind"];
    readonly cwd: string;
    readonly outputPath: string;
    readonly controller: AbortController;
    readonly startedAt: number;
    readonly timeoutSeconds: number | null;
    endedAt: number | null;
    lastOutputAt: number | null;
    deadlineReached: boolean;
    outcome: Outcome;
};

type CommandEntry = {
    readonly job: Command;
    readonly completion: Promise<void>;
    collected: boolean;
    waiters: number;
};

function snapshot(job: Command): CommandSnapshot {
    let exitCode: number | null = null;
    let error: string | null = null;

    if (job.outcome.state === "completed") exitCode = job.outcome.exitCode;
    if (job.outcome.state === "failed") error = job.outcome.error;

    return {
        id: job.id,
        command: job.command,
        kind: job.kind,
        cwd: job.cwd,
        outputPath: job.outputPath,
        state: job.outcome.state,
        exitCode,
        error,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        lastOutputAt: job.lastOutputAt,
        timeoutSeconds: job.timeoutSeconds,
    };
}

export type BackgroundCommandsOptions = {
    readonly operations: BashOperations;
    readonly directory: string;

    /** Called whenever a job ends, for status displays. */
    readonly onChange: (job: CommandSnapshot) => void;

    /** Called once for a job that ended without anything collecting its result. */
    readonly onResult: (result: CommandOutput) => void;
    readonly now?: () => number;
};

type PreviewLimits = { readonly maxLines?: number; readonly maxBytes: number };

const STATUS_PREVIEW: PreviewLimits = { maxBytes: DEFAULT_MAX_BYTES };
const RESULT_PREVIEW: PreviewLimits = { maxLines: 80, maxBytes: 8 * 1024 };

export class BackgroundCommands {
    private readonly jobs = new Map<string, CommandEntry>();
    private readonly deliveries = new Set<NodeJS.Immediate>();
    private readonly operations: BashOperations;
    private readonly directory: string;
    private readonly onChange: (job: CommandSnapshot) => void;
    private readonly onResult: (result: CommandOutput) => void;
    private readonly now: () => number;
    private closed = false;

    constructor(options: BackgroundCommandsOptions) {
        this.operations = options.operations;
        this.directory = options.directory;
        this.onChange = options.onChange;
        this.onResult = options.onResult;
        this.now = options.now ?? Date.now;
    }

    start(
        command: string,
        cwd: string,
        options: {
            signal?: AbortSignal | undefined;
            kind?: CommandSnapshot["kind"] | undefined;
            timeout?: number | undefined;
        } = {},
    ): CommandSnapshot {
        if (this.closed) throw new Error("Background commands are closed");

        options.signal?.throwIfAborted();
        const kind = options.kind ?? "task";
        let timeoutSeconds: number | null = null;
        if (kind === "service") {
            if (options.timeout !== undefined)
                throw new Error("Services run until stopped; omit timeout.");
        } else {
            timeoutSeconds = options.timeout ?? DEFAULT_TASK_TIMEOUT_SECONDS;
            if (
                !Number.isInteger(timeoutSeconds) ||
                timeoutSeconds < 1 ||
                timeoutSeconds > MAX_TASK_TIMEOUT_SECONDS
            )
                throw new Error(
                    `Task timeout must be a whole number of seconds from 1 to ${MAX_TASK_TIMEOUT_SECONDS}.`,
                );
        }

        const id = randomUUID();

        mkdirSync(this.directory, { recursive: true, mode: 0o700 });

        const outputPath = join(this.directory, `${id}.log`);
        const descriptor = openSync(outputPath, "wx", 0o600);
        const job: Command = {
            id,
            command,
            kind,
            cwd,
            outputPath,
            controller: new AbortController(),
            startedAt: this.now(),
            timeoutSeconds,
            endedAt: null,
            lastOutputAt: null,
            deadlineReached: false,
            outcome: { state: "running" },
        };
        const completion = Promise.resolve().then(async () => this.run(job, descriptor));
        this.jobs.set(id, { job, completion, collected: false, waiters: 0 });

        return snapshot(job);
    }

    list(): CommandSnapshot[] {
        return [...this.jobs.values()].map((entry) => snapshot(entry.job));
    }

    get(id: string): CommandSnapshot {
        return snapshot(this.lookup(id).job);
    }

    output(id: string): CommandOutput {
        const entry = this.lookup(id);
        const result = this.readOutput(entry.job, STATUS_PREVIEW);

        if (entry.job.outcome.state !== "running") entry.collected = true;
        return result;
    }

    async wait(
        ids?: readonly string[],
        options: { signal?: AbortSignal | undefined; timeout?: number | undefined } = {},
    ): Promise<StaticDecode<typeof waitOutputSchema>> {
        const { signal, timeout = 60 } = options;
        signal?.throwIfAborted();

        if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120)
            throw new Error("Wait timeout must be between 1 and 120 seconds.");

        let entries: CommandEntry[];
        if (ids === undefined) {
            entries = [...this.jobs.values()].filter(
                (entry) => entry.job.kind === "task" && !entry.collected,
            );
        } else {
            entries = [...new Set(ids)].map((id) => this.lookup(id));
            if (entries.some((entry) => entry.job.kind === "service"))
                throw new Error("Cannot wait for a service to exit; verify readiness instead.");
        }

        const completion = Promise.all(entries.map(async (entry) => entry.completion));
        let onAbort: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;

        for (const entry of entries) entry.waiters += 1;

        try {
            const cancelled = new Promise<never>((_resolve, reject) => {
                if (signal === undefined) return;

                onAbort = () => {
                    const cause: unknown = signal.reason;
                    if (cause instanceof Error) reject(cause);
                    else reject(new DOMException("Background wait cancelled.", "AbortError"));
                };
                signal.addEventListener("abort", onAbort, { once: true });
            });

            const checkpoint = new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeout * 1_000);
            });

            await Promise.race([completion, cancelled, checkpoint]);
            signal?.throwIfAborted();

            // Read the whole batch before collecting it, so a failed read loses no results.
            const jobs = entries.map((entry) => this.readOutput(entry.job, STATUS_PREVIEW));

            for (const entry of entries) {
                if (entry.job.outcome.state !== "running") entry.collected = true;
            }

            return { jobs, timedOut: jobs.some((result) => result.job.state === "running") };
        } finally {
            clearTimeout(timer);

            if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);

            // A job that finished during a cancelled or failed wait still reports back.
            for (const entry of entries) {
                entry.waiters -= 1;
                this.scheduleDelivery(entry);
            }
        }
    }

    private readOutput(command: Command, limits: PreviewLimits): CommandOutput {
        const job = snapshot(command);
        const descriptor = openSync(job.outputPath, "r");

        try {
            const { size } = fstatSync(descriptor);
            const length = Math.min(size, limits.maxBytes);
            const buffer = Buffer.alloc(length);
            const read = readSync(descriptor, buffer, 0, length, size - length);
            const preview = truncateTail(buffer.subarray(0, read).toString("utf8"), limits);
            return {
                job,
                output: preview.content,
                truncated: preview.truncated || size > read,
            };
        } finally {
            closeSync(descriptor);
        }
    }

    async stop(id: string): Promise<CommandSnapshot> {
        const entry = this.lookup(id);
        if (entry.job.outcome.state === "running") {
            entry.job.controller.abort();
            await entry.completion;
        }

        entry.collected = true;
        return snapshot(entry.job);
    }

    async dispose(): Promise<void> {
        this.closed = true;
        for (const delivery of this.deliveries) clearImmediate(delivery);
        this.deliveries.clear();

        const running = [...this.jobs.values()].filter(
            (entry) => entry.job.outcome.state === "running",
        );
        for (const entry of running) entry.job.controller.abort();
        await Promise.all(running.map(async (entry) => entry.completion));
    }

    private lookup(id: string): CommandEntry {
        const entry = this.jobs.get(id);
        if (entry === undefined) throw new Error("Unknown background command.");
        return entry;
    }

    private async run(job: Command, descriptor: number): Promise<void> {
        let acceptingOutput = true;
        let outputFailed = false;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        if (job.timeoutSeconds !== null) {
            deadline = setTimeout(() => {
                job.deadlineReached = true;
                job.controller.abort();
            }, job.timeoutSeconds * 1_000);
        }

        try {
            const result = await this.operations.exec(job.command, job.cwd, {
                signal: job.controller.signal,
                onData: (data) => {
                    if (!acceptingOutput || outputFailed) return;
                    try {
                        writeFileSync(descriptor, data);
                        job.lastOutputAt = this.now();
                    } catch {
                        outputFailed = true;
                        job.controller.abort();
                    }
                },
            });
            if (job.deadlineReached) {
                job.outcome = { state: "timed_out" };
            } else if (result.exitCode === null) {
                job.outcome = { state: "failed", error: "The command ended without an exit code." };
            } else {
                job.outcome = { state: "completed", exitCode: result.exitCode };
            }
        } catch {
            if (job.deadlineReached) job.outcome = { state: "timed_out" };
            else if (job.controller.signal.aborted) job.outcome = { state: "stopped" };
            else
                job.outcome = {
                    state: "failed",
                    error: "Could not execute the background command.",
                };
        } finally {
            clearTimeout(deadline);
            job.endedAt = this.now();
            acceptingOutput = false;

            try {
                closeSync(descriptor);
            } catch {
                outputFailed = true;
            }

            if (outputFailed) {
                job.outcome = { state: "failed", error: "Could not save the command output." };
            }
        }

        if (this.closed) return;
        try {
            this.onChange(snapshot(job));
        } catch {
            console.error("Background command completed, but its status refresh failed.");
        }

        const entry = this.jobs.get(job.id);
        if (entry !== undefined) this.scheduleDelivery(entry);
    }

    // A status read or stop that settles with the job collects it in the same tick, and a
    // pending wait returns it itself; deliver only results nothing else picked up.
    private scheduleDelivery(entry: CommandEntry): void {
        if (this.closed || !this.isDeliverable(entry)) return;

        const delivery = setImmediate(() => {
            this.deliveries.delete(delivery);
            this.deliver(entry);
        });
        this.deliveries.add(delivery);
    }

    private isDeliverable(entry: CommandEntry): boolean {
        return entry.job.outcome.state !== "running" && !entry.collected && entry.waiters === 0;
    }

    private deliver(entry: CommandEntry): void {
        if (this.closed || !this.isDeliverable(entry)) return;

        entry.collected = true;

        let result: CommandOutput;
        try {
            result = this.readOutput(entry.job, RESULT_PREVIEW);
        } catch {
            result = {
                job: snapshot(entry.job),
                output: `[Could not read ${entry.job.outputPath}.]`,
                truncated: false,
            };
        }

        try {
            this.onResult(result);
        } catch {
            console.error("Background command finished, but its result could not be delivered.");
        }
    }
}
