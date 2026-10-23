import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createLocalBashOperations, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BackgroundCommands, type CommandSnapshot } from "./commands.ts";

let directory: string;
let commands: BackgroundCommands;
let notifications: CommandSnapshot[];
let nextCompletion: Promise<CommandSnapshot>;
let server: Server | undefined;
const sockets: Socket[] = [];

beforeEach(async () => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    directory = await mkdtemp(join(process.cwd(), ".cache", "background-test-"));
    notifications = [];
    nextCompletion = new Promise((resolve) => {
        commands = new BackgroundCommands(
            createLocalBashOperations(),
            join(directory, "output"),
            (job) => {
                notifications.push(job);
                resolve(job);
            },
        );
    });
});

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
