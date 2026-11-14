import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createLocalBashOperations, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackgroundCommands, type CommandOutput, type CommandSnapshot } from "./commands.ts";

let directory: string;
let commands: BackgroundCommands;
let notifications: CommandSnapshot[];
let nextCompletion: Promise<CommandSnapshot>;
let deliveries: CommandOutput[];
let nextDelivery: Promise<CommandOutput>;
let clock: number;
let server: Server | undefined;
const sockets: Socket[] = [];

beforeEach(async () => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    directory = await mkdtemp(join(process.cwd(), ".cache", "background-test-"));
    notifications = [];
    deliveries = [];
    clock = 1_000;
    let resolveDelivery: (result: CommandOutput) => void = () => undefined;
    nextDelivery = new Promise((resolve) => {
        resolveDelivery = resolve;
    });
    nextCompletion = new Promise((resolve) => {
        commands = new BackgroundCommands({
            operations: createLocalBashOperations(),
            directory: join(directory, "output"),
            onChange: (job) => {
                notifications.push(job);
                resolve(job);
            },
            onResult: (result) => {
                deliveries.push(result);
                resolveDelivery(result);
            },
            now: () => clock,
        });
    });
});

async function settleDeliveries(): Promise<void> {
    return new Promise((resolve) => {
        setImmediate(resolve);
    });
}

afterEach(async () => {
    await commands.dispose();

    for (const socket of sockets.splice(0)) socket.destroy();

    if (server !== undefined) {
        const current = server;
        server = undefined;
        await new Promise<void>((resolve, reject) => {
            current.close((error) => {
                if (error !== undefined) reject(error);
                else resolve();
            });
        });
    }

    await rm(directory, { recursive: true, force: true });
});

async function blockingCommand(): Promise<{ command: string; connection: Promise<Socket> }> {
    const listener = createServer((socket) => {
        sockets.push(socket);
    });
    server = listener;
    const connection = new Promise<Socket>((resolve, reject) => {
        listener.once("connection", resolve);
        listener.once("error", reject);
    });
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = Value.Parse(Type.Object({ port: Type.Number() }), listener.address());
    await writeFile(
        join(directory, "child.mjs"),
        `import { connect } from 'node:net';
const socket = connect(${address.port}, '127.0.0.1');
socket.on('data', () => {
    process.stdout.write('finished\\n');
    socket.end();
});
`,
    );

    return { command: "node child.mjs", connection };
}

it("returns a running job before the command completes, then notifies once with its output", async () => {
    const fixture = await blockingCommand();
    const job = commands.start(fixture.command, directory);
    const socket = await fixture.connection;

    expect(job.state).toBe("running");
    expect(commands.get(job.id).state).toBe("running");
    expect(notifications).toEqual([]);
    socket.write("finish");

    const completed = await nextCompletion;
    expect(completed).toMatchObject({ id: job.id, state: "completed", exitCode: 0, error: null });
    expect(await readFile(job.outputPath, "utf8")).toBe("finished\n");
    expect(commands.output(job.id)).toMatchObject({ output: "finished\n", truncated: false });
    expect(notifications).toEqual([completed]);
});

it("reports nonzero exit codes and preserves stdout and stderr", async () => {
    const job = commands.start("printf 'first\\n'; printf 'warning\\n' >&2; exit 7", directory);
    const completed = await nextCompletion;

    expect(completed).toMatchObject({ id: job.id, state: "completed", exitCode: 7, error: null });
    const output = commands.output(job.id);
    expect(output.output).toContain("first\n");
    expect(output.output).toContain("warning\n");
    expect(output.truncated).toBe(false);
});

it("keeps full UTF-8 output on disk while bounding the preview with Pi's normal output limit", async () => {
    const expected = `${"α".repeat(DEFAULT_MAX_BYTES)}\nfinished\n`;
    await writeFile(
        join(directory, "output.mjs"),
        `process.stdout.write(${JSON.stringify(expected)});`,
    );
    const job = commands.start("node output.mjs", directory);
    await nextCompletion;

    expect(await readFile(job.outputPath, "utf8")).toBe(expected);
    const output = commands.output(job.id);
    expect(output.truncated).toBe(true);
    expect(output.output.endsWith("\nfinished\n")).toBe(true);
    expect(Buffer.byteLength(output.output)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
});

it("stops a running command, closes its connection, and makes repeated stops harmless", async () => {
    const fixture = await blockingCommand();
    const job = commands.start(fixture.command, directory);
    const socket = await fixture.connection;
    const disconnected = once(socket, "close");

    const stopped = await commands.stop(job.id);
    await disconnected;

    expect(stopped).toMatchObject({ id: job.id, state: "stopped", exitCode: null, error: null });
    expect(await commands.stop(job.id)).toEqual(stopped);
    expect(notifications).toEqual([stopped]);
});

it("shutdown stops owned work and suppresses completion notifications", async () => {
    const fixture = await blockingCommand();
    const job = commands.start(fixture.command, directory);
    const socket = await fixture.connection;
    const disconnected = once(socket, "close");

    await commands.dispose();
    await disconnected;
    await commands.dispose();

    expect(commands.get(job.id).state).toBe("stopped");
    expect(notifications).toEqual([]);
    expect(() => commands.start("printf unexpected", directory)).toThrow("closed");
});

it("reports launch failures and rejects unknown jobs", async () => {
    const job = commands.start("printf unexpected", join(directory, "missing"));
    const failed = await nextCompletion;

    expect(failed).toMatchObject({ id: job.id, state: "failed", exitCode: null });
    expect(failed.error).toBe("Could not execute the background command.");
    expect(() => commands.get("missing")).toThrow("Unknown background command");
});

it("collects completed and running tasks together without waiting for services or replaying results", async () => {
    const fixture = await blockingCommand();
    const service = commands.start(fixture.command, directory, { kind: "service" });
    await fixture.connection;
    const first = commands.start("printf 'tests passed'", directory);
    const second = commands.start("printf 'build failed'; exit 3", directory);
    const result = await commands.wait();

    expect(result.jobs).toMatchObject([
        {
            job: { id: first.id, kind: "task", state: "completed", exitCode: 0 },
            output: "tests passed",
        },
        {
            job: { id: second.id, kind: "task", state: "completed", exitCode: 3 },
            output: "build failed",
        },
    ]);

    expect(commands.get(service.id)).toMatchObject({ kind: "service", state: "running" });
    expect(await commands.wait()).toEqual({ jobs: [], timedOut: false });
    expect(await commands.wait([first.id])).toMatchObject({ jobs: [{ job: { id: first.id } }] });
});

it("includes an already finished task and does not collect eventual results on a running status read", async () => {
    const first = commands.start("printf done", directory);
    await nextCompletion;

    expect(await commands.wait()).toMatchObject({
        jobs: [{ job: { id: first.id }, output: "done" }],
    });
    const fixture = await blockingCommand();
    const second = commands.start(fixture.command, directory);
    const socket = await fixture.connection;
    commands.output(second.id); // Reading a running task must not collect its eventual completion.
    socket.write("finish");
    const collected = await commands.wait();
    expect(collected.jobs).toMatchObject([{ job: { id: second.id }, output: "finished\n" }]);
    expect(await commands.wait()).toEqual({ jobs: [], timedOut: false });
});

it("returns running output at the default checkpoint and later collects the task", async () => {
    const fixture = await blockingCommand();
    const job = commands.start(fixture.command, directory);
    const socket = await fixture.connection;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
        const waiting = commands.wait();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await waiting).toMatchObject({
            timedOut: true,
            jobs: [{ job: { id: job.id, state: "running" } }],
        });

        expect(vi.getTimerCount()).toBe(0);
        expect(commands.get(job.id).state).toBe("running");
    } finally {
        vi.useRealTimers();
    }

    socket.write("finish");
    expect(await commands.wait()).toMatchObject({
        timedOut: false,
        jobs: [{ job: { id: job.id, state: "completed" }, output: "finished\n" }],
    });
});

it("collects only completed jobs at a checkpoint and does not also deliver them", async () => {
    const fixture = await blockingCommand();
    const running = commands.start(fixture.command, directory);
    const socket = await fixture.connection;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
        const finished = commands.start("printf ready", directory);
        const waiting = commands.wait(undefined, { timeout: 1 });
        await nextCompletion;
        await settleDeliveries();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await waiting).toMatchObject({
            timedOut: true,
            jobs: [
                { job: { id: running.id, state: "running" } },
                { job: { id: finished.id, state: "completed" }, output: "ready" },
            ],
        });
    } finally {
        vi.useRealTimers();
    }

    socket.write("finish");
    expect((await commands.wait()).jobs.map((result) => result.job.id)).toEqual([running.id]);
    await settleDeliveries();
    expect(deliveries).toEqual([]);
});

it("rejects unbounded or invalid wait budgets without losing completed results", async () => {
    const job = commands.start("printf done", directory);
    await nextCompletion;

    for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 121]) {
        await expect(commands.wait(undefined, { timeout })).rejects.toThrow("timeout");
    }

    expect(await commands.wait()).toMatchObject({
        timedOut: false,
        jobs: [{ job: { id: job.id }, output: "done" }],
    });
});

it("clears the checkpoint when the batch already completed", async () => {
    commands.start("printf ready", directory);
    await nextCompletion;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
        expect(await commands.wait()).toMatchObject({ timedOut: false });
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.useRealTimers();
    }
});

it("cancels a wait without stopping the task or collecting its result", async () => {
    const fixture = await blockingCommand();
    const job = commands.start(fixture.command, directory);
    const socket = await fixture.connection;
    const controller = new AbortController();
    const waiting = commands.wait(undefined, { signal: controller.signal });
    const rejection = expect(waiting).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    await rejection;
    expect(commands.get(job.id).state).toBe("running");
    socket.write("finish");
    expect(await commands.wait()).toMatchObject({
        jobs: [{ job: { id: job.id }, output: "finished\n" }],
    });
});

it("rejects invalid wait selections immediately and does not collect valid tasks in the selection", async () => {
    const fixture = await blockingCommand();
    const service = commands.start(fixture.command, directory, { kind: "service" });
    await fixture.connection;
    const job = commands.start("printf done", directory);

    await expect(commands.wait([job.id, "missing"])).rejects.toThrow("Unknown background command");
    await expect(commands.wait([service.id])).rejects.toThrow("service");
    expect(await commands.wait()).toMatchObject({ jobs: [{ job: { id: job.id } }] });
});

it("shutdown settles an existing wait with stopped results", async () => {
    const fixture = await blockingCommand();
    const job = commands.start(fixture.command, directory);
    await fixture.connection;
    const waiting = commands.wait();
    await commands.dispose();
    expect(await waiting).toMatchObject({ jobs: [{ job: { id: job.id, state: "stopped" } }] });
    expect(await commands.wait()).toEqual({ jobs: [], timedOut: false });
});

it("keeps uncollected results available when a wait is already cancelled", async () => {
    const job = commands.start("printf done", directory);
    await nextCompletion;
    const controller = new AbortController();
    controller.abort();

    await expect(commands.wait(undefined, { signal: controller.signal })).rejects.toMatchObject({
        name: "AbortError",
    });
    expect(await commands.wait()).toMatchObject({
        jobs: [{ job: { id: job.id }, output: "done" }],
    });
});

it("stops a task at its deadline with its child processes and reports the timeout", async () => {
    const fixture = await blockingCommand();
    const job = commands.start(fixture.command, directory, { timeout: 1 });
    const socket = await fixture.connection;
    const disconnected = once(socket, "close");

    const timedOut = await nextCompletion;
    await disconnected;

    expect(job.timeoutSeconds).toBe(1);
    expect(timedOut).toMatchObject({ id: job.id, state: "timed_out", exitCode: null });
    expect((await nextDelivery).job).toMatchObject({ id: job.id, state: "timed_out" });
});

it("gives tasks a default deadline and services none", () => {
    const task = commands.start("printf task", directory);
    const service = commands.start("printf service", directory, { kind: "service" });

    expect(task.timeoutSeconds).toBe(1800);
    expect(service.timeoutSeconds).toBeNull();
});

it("rejects service timeouts and out-of-range task timeouts without starting a job", () => {
    expect(() =>
        commands.start("printf service", directory, { kind: "service", timeout: 10 }),
    ).toThrow("Services run until stopped");

    for (const timeout of [0, -1, 1.5, Number.NaN, 7201]) {
        expect(() => commands.start("printf task", directory, { timeout })).toThrow("timeout");
    }

    expect(commands.list()).toEqual([]);
});

it("delivers a finished result once when nothing collected it, then leaves it out of waits", async () => {
    const job = commands.start("printf done; exit 3", directory);

    expect(await nextDelivery).toMatchObject({
        job: { id: job.id, state: "completed", exitCode: 3 },
        output: "done",
    });
    await settleDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(await commands.wait()).toEqual({ jobs: [], timedOut: false });
});

it("delivers a service that exits on its own", async () => {
    const service = commands.start("printf crashed; exit 1", directory, { kind: "service" });

    expect(await nextDelivery).toMatchObject({
        job: { id: service.id, state: "completed", exitCode: 1 },
        output: "crashed",
    });
});

it("does not deliver results that a wait or stop collected", async () => {
    const waited = await blockingCommand();
    const job = commands.start(waited.command, directory);
    const socket = await waited.connection;
    const waiting = commands.wait([job.id]);
    socket.write("finish");
    expect(await waiting).toMatchObject({ jobs: [{ job: { id: job.id, state: "completed" } }] });

    const looping = commands.start("while :; do sleep 0.01; done", directory);
    await commands.stop(looping.id);
    await settleDeliveries();

    expect(deliveries).toEqual([]);
});

it("does not deliver results after shutdown", async () => {
    commands.start("printf done", directory);
    await nextCompletion;
    await commands.dispose();
    await settleDeliveries();

    expect(deliveries).toEqual([]);
});

it("records when a task started, last wrote output, and ended", async () => {
    const job = commands.start("printf done", directory);
    clock = 4_000;
    const completed = await nextCompletion;

    expect(job).toMatchObject({ startedAt: 1_000, lastOutputAt: null, endedAt: null });
    expect(completed).toMatchObject({ startedAt: 1_000, lastOutputAt: 4_000, endedAt: 4_000 });
});
