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
    cwd: Type.Optional(
        Type.String({
            description: "Working directory, relative to the current project or absolute",
        }),
    ),
});

export const jobArgsSchema = Type.Object({
    id: Type.String({ minLength: 1, description: "Job ID returned by background_start" }),
});

export const commandSchema = Type.Object(
    {
        id: Type.String(),
        command: Type.String(),
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

export type CommandSnapshot = StaticDecode<typeof commandSchema>;

type Outcome =
    | { state: "running" }
    | { state: "completed"; exitCode: number }
    | { state: "stopped" }
    | { state: "failed"; error: string };

type Command = {
    readonly id: string;
    readonly command: string;
    readonly cwd: string;
    readonly outputPath: string;
    readonly controller: AbortController;
    outcome: Outcome;
};

function snapshot(job: Command): CommandSnapshot {
    let exitCode: number | null = null;
    let error: string | null = null;

    if (job.outcome.state === "completed") exitCode = job.outcome.exitCode;
    if (job.outcome.state === "failed") error = job.outcome.error;

    return {
        id: job.id,
        command: job.command,
        cwd: job.cwd,
        outputPath: job.outputPath,
        state: job.outcome.state,
        exitCode,
        error,
    };
}

export class BackgroundCommands {
    private readonly jobs = new Map<string, { job: Command; completion: Promise<void> }>();
    private closed = false;

    constructor(
        private readonly operations: BashOperations,
        private readonly directory: string,
        private readonly onComplete: (job: CommandSnapshot) => void,
    ) {}

    start(
        command: string,
        cwd: string,
        options: { signal?: AbortSignal | undefined } = {},
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
            cwd,
            outputPath,
            controller: new AbortController(),
            outcome: { state: "running" },
        };
        const completion = Promise.resolve().then(async () => this.run(job, descriptor));
        this.jobs.set(id, { job, completion });

        return snapshot(job);
    }

    list(): CommandSnapshot[] {
        return [...this.jobs.values()].map((entry) => snapshot(entry.job));
    }

    get(id: string): CommandSnapshot {
        return snapshot(this.lookup(id).job);
    }

    output(id: string): StaticDecode<typeof outputSchema> {
        const job = this.get(id);
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

    private lookup(id: string): { job: Command; completion: Promise<void> } {
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
            console.error("Background command completed, but its completion notification failed.");
        }
    }
}
