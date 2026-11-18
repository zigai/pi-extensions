import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createAssistantMessageEventStream,
    InMemoryCredentialStore,
    type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { afterEach, expect, it } from "vitest";
import monitorExtension from "./index.ts";
import {
    monitorSchema,
    stopOutputSchema,
    type CommandArgs,
    type MonitorArgs,
    type WebSocketArgs,
} from "./monitors.ts";

const monitorParser = Compile(monitorSchema);
const addressParser = Compile(Type.Object({ port: Type.Integer() }));
const stopParser = Compile(stopOutputSchema);

let session: AgentSession | undefined;
let root: string | undefined;
let previousAgentDir: string | undefined;
let server: Server | undefined;
const sockets = new Set<Socket>();
const pendingResponses: Array<() => void> = [];

afterEach(async () => {
    for (const finish of pendingResponses.splice(0)) finish();

    if (session !== undefined) {
        await session.abort();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
        session = undefined;
    }

    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => {
        if (server === undefined) resolve();
        else server.close(() => resolve());
    });
    server = undefined;

    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
});

async function createRuntime() {
    root = await mkdtemp(join(tmpdir(), "pi-monitor-runtime-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories: [{ name: "monitor", factory: monitorExtension }],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const requests: string[] = [];
    const controls = { holdResponses: false };
    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
    });
    modelRuntime.registerProvider("monitor-test", {
        api: "monitor-test",
        apiKey: "isolated-test-key",
        baseUrl: "https://example.invalid",
        models: [
            {
                id: "synthetic",
                name: "synthetic",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 10000,
                maxTokens: 100,
            },
        ],
        streamSimple(model) {
            requests.push(model.id);
            const stream = createAssistantMessageEventStream();
            const message: AssistantMessage = {
                role: "assistant",
                content: [{ type: "text", text: "Synthetic answer" }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                timestamp: 1,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
            };
            const finish = () => {
                stream.push({ type: "done", reason: "stop", message });
                stream.end(message);
            };
            if (controls.holdResponses) pendingResponses.push(finish);
            else finish();

            return stream;
        },
    });
    const model = modelRuntime.getModel("monitor-test", "synthetic");
    if (model === undefined) throw new Error("Synthetic model missing");

    const created = await createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        modelRuntime,
        model,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
    });
    session = created.session;
    const errors: string[] = [];
    await session.bindExtensions({
        mode: "print",
        onError: (error) => {
            errors.push(error.error);
        },
    });
    const bound = session;

    async function execute(name: string, args: CommandArgs | WebSocketArgs | MonitorArgs) {
        const tool = bound.agent.state.tools.find((candidate) => candidate.name === name);
        if (tool === undefined) throw new Error(`Tool not registered: ${name}`);
        return tool.execute(`integration-${name}`, args, AbortSignal.timeout(3000));
    }

    async function start(args: CommandArgs) {
        return monitorParser.Parse((await execute("monitor", args)).details);
    }

    async function startWebSocket(args: WebSocketArgs) {
        return monitorParser.Parse((await execute("monitor_websocket", args)).details);
    }

    function notifications(): string[] {
        return bound.messages
            .filter((message) => message.role === "custom")
            .map((message) => {
                expect(message).toMatchObject({ customType: "pi-monitor.notification" });
                return JSON.stringify(message.content);
            });
    }

    return {
        session: bound,
        requests,
        controls,
        execute,
        start,
        startWebSocket,
        notifications,
        cwd,
        errors,
    };
}

it("wakes an idle session for each event and for the end of the stream", async () => {
    const runtime = await createRuntime();
    await runtime.session.prompt("Start watching");
    expect(runtime.requests).toHaveLength(1);

    await runtime.start({
        description: "build progress",
        command: "echo step one; sleep 0.5; echo step two; sleep 0.5; echo diagnostics >&2",
    });

    await expect.poll(() => runtime.notifications().length, { timeout: 5000 }).toBe(3);
    await runtime.session.waitForIdle();
    const [first, second, end] = runtime.notifications();
    expect(first).toContain("step one");
    expect(second).toContain("step two");
    expect(end).toContain("stream ended (exit 0)");
    expect(runtime.notifications().join("\n")).not.toContain("diagnostics");
    expect(runtime.requests).toHaveLength(4);
    expect(runtime.errors).toEqual([]);
});

it("reports a failing script with its exit code and keeps stderr in the output file", async () => {
    const runtime = await createRuntime();
    await runtime.session.prompt("Start watching");

    const monitor = await runtime.start({
        description: "test run",
        command: "echo 'boom on stderr' >&2; exit 3",
    });

    await expect.poll(() => runtime.notifications().length, { timeout: 5000 }).toBe(1);
    expect(runtime.notifications()[0]).toContain("script failed (exit 3)");
    expect(runtime.notifications()[0]).toContain(monitor.outputPath);
    const log = await readFile(monitor.outputPath, "utf8");
    expect(log).toContain("boom on stderr");
    expect(log).toContain("[exited with code 3]");
});

it("steers an event into a turn that is still running", async () => {
    const runtime = await createRuntime();
    runtime.controls.holdResponses = true;
    const prompt = runtime.session.prompt("Long turn");
    await expect.poll(() => runtime.requests.length).toBe(1);

    try {
        await runtime.start({ description: "log errors", command: "echo ERROR found; sleep 5" });
        await expect.poll(() => runtime.session.agent.hasQueuedMessages()).toBe(true);
        expect(runtime.requests).toHaveLength(1);
    } finally {
        runtime.controls.holdResponses = false;

        for (const finish of pendingResponses.splice(0)) finish();
        await prompt;
    }

    await runtime.session.waitForIdle();
    expect(runtime.notifications()[0]).toContain("ERROR found");
    expect(runtime.requests).toHaveLength(2);
});

it("expires at its timeout with one notice and stops the command", async () => {
    const runtime = await createRuntime();
    await runtime.session.prompt("Start watching");
    const ticks = join(runtime.cwd, "ticks");

    await runtime.start({
        description: "quiet watcher",
        command: `while :; do echo x >> ${ticks}; sleep 0.05; done`,
        timeout: 1,
    });

    await expect.poll(() => runtime.notifications().length, { timeout: 5000 }).toBe(1);
    expect(runtime.notifications()[0]).toContain("expired after 1s with no events delivered");
    const size = (await stat(ticks)).size;
    await new Promise((resolve) => {
        setTimeout(resolve, 300);
    });
    expect((await stat(ticks)).size).toBe(size);
    expect(runtime.notifications()).toHaveLength(1);
});

it("stops a monitor quietly and returns lines that were not delivered", async () => {
    const runtime = await createRuntime();
    await runtime.session.prompt("Start watching");
    const ticks = join(runtime.cwd, "ticks");

    const monitor = await runtime.start({
        description: "ticker",
        command: `printf 'pending line'; while :; do echo x >> ${ticks}; sleep 0.05; done`,
    });
    await expect
        .poll(async () => (await stat(ticks).catch(() => undefined))?.size ?? 0)
        .toBeGreaterThan(0);

    const stopped = stopParser.Parse(
        (await runtime.execute("monitor_stop", { id: monitor.id })).details,
    );
    expect(stopped.monitor.state).toBe("stopped");
    expect(stopped.pending).toBe("pending line");

    const size = (await stat(ticks)).size;
    await new Promise((resolve) => {
        setTimeout(resolve, 300);
    });
    expect((await stat(ticks)).size).toBe(size);
    expect(runtime.notifications()).toEqual([]);
});

it("stops running monitors when the session shuts down", async () => {
    const runtime = await createRuntime();
    await runtime.session.prompt("Start watching");
    const ticks = join(runtime.cwd, "ticks");

    await runtime.start({
        description: "ticker",
        command: `while :; do echo x >> ${ticks}; sleep 0.05; done`,
    });
    await expect
        .poll(async () => (await stat(ticks).catch(() => undefined))?.size ?? 0)
        .toBeGreaterThan(0);

    await runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    const size = (await stat(ticks)).size;
    await new Promise((resolve) => {
        setTimeout(resolve, 300);
    });
    expect((await stat(ticks)).size).toBe(size);
    expect(runtime.notifications()).toEqual([]);
});

it("rejects a WebSocket URL with another scheme", async () => {
    const runtime = await createRuntime();
    await expect(
        runtime.execute("monitor_websocket", {
            description: "plain http",
            url: "http://127.0.0.1:1",
        }),
    ).rejects.toThrow("must start with ws:// or wss://");
    expect(runtime.notifications()).toEqual([]);
});

function frame(opcode: number, payload: Buffer): Buffer {
    if (payload.length >= 126) throw new Error("Test frames are short");
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

async function startWebSocketServer(send: (socket: Socket) => void): Promise<string> {
    server = createServer();
    server.on("upgrade", (request, socket: Socket) => {
        sockets.add(socket);
        const key = request.headers["sec-websocket-key"] ?? "";
        const accept = createHash("sha1")
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
        socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        send(socket);
    });
    await new Promise<void>((resolve) => {
        server?.listen(0, "127.0.0.1", resolve);
    });
    const { port } = addressParser.Parse(server.address());
    return `ws://127.0.0.1:${port}/events`;
}

it("turns WebSocket frames into events and reports the close", async () => {
    const runtime = await createRuntime();
    await runtime.session.prompt("Start watching");
    const url = await startWebSocketServer((socket) => {
        socket.write(frame(0x1, Buffer.from("deploy started")));
        setTimeout(() => {
            socket.write(frame(0x2, Buffer.from([1, 2, 3])));
            socket.end(frame(0x8, Buffer.from([0x03, 0xe8])));
        }, 400);
    });

    await runtime.startWebSocket({ description: "deploy events", url });

    await expect
        .poll(() => runtime.notifications().at(-1), { timeout: 5000 })
        .toContain("connection closed (code 1000)");
    const all = runtime.notifications().join("\n");
    expect(runtime.notifications()[0]).toContain("deploy started");
    expect(all).toContain("[binary frame, 3 bytes]");
});
