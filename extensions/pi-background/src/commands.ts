import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    DEFAULT_MAX_BYTES,
    truncateTail,
    type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { Type, type StaticDecode } from "typebox";

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
        state: Type.Enum(["running", "completed", "stopped", "failed"]),
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        error: Type.Union([Type.String(), Type.Null()]),
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

type Outcome =
    | { state: "running" }
    | { state: "completed"; exitCode: number }
    | { state: "stopped" }
    | { state: "failed"; error: string };

type Command = {
    readonly id: string;
    readonly command: string;
    readonly kind: CommandSnapshot["kind"];
    readonly cwd: string;
    readonly outputPath: string;
    readonly controller: AbortController;
    outcome: Outcome;
};

type CommandEntry = {
    readonly job: Command;
    readonly completion: Promise<void>;
    collected: boolean;
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
    };
}

export class BackgroundCommands {
    private readonly jobs = new Map<string, CommandEntry>();
    private closed = false;

    constructor(
        private readonly operations: BashOperations,
        private readonly directory: string,
        private readonly onComplete: (job: CommandSnapshot) => void,
    ) {}

    start(
        command: string,
        cwd: string,
        options: { signal?: AbortSignal | undefined; kind?: CommandSnapshot["kind"] } = {},
    ): CommandSnapshot {
        if (this.closed) throw new Error("Background commands are closed");

        options.signal?.throwIfAborted();
        const id = randomUUID();

        mkdirSync(this.directory, { recursive: true, mode: 0o700 });

        const outputPath = join(this.directory, `${id}.log`);
        const descriptor = openSync(outputPath, "wx", 0o600);
        const job: Command = {
            id,
            command,
            kind: options.kind ?? "task",
            cwd,
            outputPath,
            controller: new AbortController(),
            outcome: { state: "running" },
        };
        const completion = Promise.resolve().then(async () => this.run(job, descriptor));
        this.jobs.set(id, { job, completion, collected: false });

        return snapshot(job);
    }

    list(): CommandSnapshot[] {
        return [...this.jobs.values()].map((entry) => snapshot(entry.job));
    }

    get(id: string): CommandSnapshot {
        return snapshot(this.lookup(id).job);
    }

    output(id: string): StaticDecode<typeof outputSchema> {
        const entry = this.lookup(id);
        const result = this.readOutput(entry.job);

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
        } finally {
            clearTimeout(timer);

            if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
        }

        // Read the whole batch before collecting it, so a failed read loses no results.
        const jobs = entries.map((entry) => this.readOutput(entry.job));

        for (const entry of entries) {
            if (entry.job.outcome.state !== "running") entry.collected = true;
        }

        return { jobs, timedOut: jobs.some((result) => result.job.state === "running") };
    }

    private readOutput(command: Command): StaticDecode<typeof outputSchema> {
        const job = snapshot(command);
        const descriptor = openSync(job.outputPath, "r");

        try {
            const { size } = fstatSync(descriptor);
            const length = Math.min(size, DEFAULT_MAX_BYTES);
            const buffer = Buffer.alloc(length);
            const read = readSync(descriptor, buffer, 0, length, size - length);
            const preview = truncateTail(buffer.subarray(0, read).toString("utf8"));
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

        try {
            const result = await this.operations.exec(job.command, job.cwd, {
                signal: job.controller.signal,
                onData: (data) => {
                    if (!acceptingOutput || outputFailed) return;
                    try {
                        writeFileSync(descriptor, data);
                    } catch {
                        outputFailed = true;
                        job.controller.abort();
                    }
                },
            });
            if (result.exitCode === null) {
                job.outcome = { state: "failed", error: "The command ended without an exit code." };
            } else {
                job.outcome = { state: "completed", exitCode: result.exitCode };
            }
        } catch {
            if (job.controller.signal.aborted) job.outcome = { state: "stopped" };
            else
                job.outcome = {
                    state: "failed",
                    error: "Could not execute the background command.",
                };
        } finally {
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
            this.onComplete(snapshot(job));
        } catch {
            console.error("Background command completed, but its status refresh failed.");
        }
    }
}
