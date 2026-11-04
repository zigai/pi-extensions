import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { afterEach, describe, expect, it } from "vitest";
import backgroundExtension from "./index.ts";

const snapshotSchema = Type.Object({
    id: Type.String(),
    state: Type.String(),
    kind: Type.Enum(["task", "service"]),
    exitCode: Type.Union([Type.Number(), Type.Null()]),
});
const snapshotParser = Compile(snapshotSchema);
const outputParser = Compile(
    Type.Object({
        job: snapshotSchema,
        output: Type.String(),
        truncated: Type.Boolean(),
    }),
);

const waitParser = Compile(
    Type.Object({ jobs: Type.Array(outputParser.Type()), timedOut: Type.Boolean() }),
);

type BackgroundToolArgs =
    | { readonly command: string; readonly kind?: "task" | "service" }
    | { readonly id: string }
    | { readonly ids?: string[]; readonly timeout?: number };

let session: AgentSession | undefined;
let root: string | undefined;
let previousAgentDir: string | undefined;
const pendingResponses: Array<() => void> = [];

afterEach(async () => {
    for (const finish of pendingResponses.splice(0)) finish();

    if (session !== undefined) {
        await session.abort();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
        session = undefined;
    }

    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
});

async function createRuntime() {
    root = await mkdtemp(join(tmpdir(), "pi-background-runtime-"));
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
        extensionFactories: [{ name: "background", factory: backgroundExtension }],
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
    modelRuntime.registerProvider("background-test", {
        api: "background-test",
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
                content: [{ type: "text", text: "Synthetic final answer" }],
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
    const model = modelRuntime.getModel("background-test", "synthetic");
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

    async function execute(name: string, args: BackgroundToolArgs, signal?: AbortSignal) {
        const tool = bound.agent.state.tools.find((candidate) => candidate.name === name);
        if (tool === undefined) throw new Error(`Tool not registered: ${name}`);
        return tool.execute(`integration-${name}`, args, signal ?? AbortSignal.timeout(3000));
    }

    return { session: bound, requests, controls, execute, cwd, errors };
}

// A held synthetic response exercises Pi's real active-turn queue without any model network.
// Real shell completion and stop exercise the extension's actual delivery callback.
describe.each(["task", "service"] as const)("%s completion lifecycle", (kind) => {
    it.each([
        ["idle", "success"],
        ["idle", "failure"],
        ["idle", "stop"],
        ["active", "success"],
        ["active", "failure"],
        ["active", "stop"],
    ] as const)(
        "does not deliver hidden follow-ups or wake a real %s Pi session on %s",
        async (state, outcome) => {
            const runtime = await createRuntime();
            runtime.controls.holdResponses = state === "active";
            const prompt = runtime.session.prompt("One foreground request");
            await expect.poll(() => runtime.requests.length).toBe(1);

            if (state === "idle") await prompt;
            try {
                let command = "printf done";
                if (outcome === "failure") command = "printf failed; exit 7";
                if (outcome === "stop") command = "printf ready; while :; do sleep 0.01; done";

                const result = await runtime.execute("background_start", { command, kind });
                const job = snapshotParser.Parse(result.details);
                if (outcome === "stop") {
                    await expect
                        .poll(async () => {
                            const result = await runtime.execute("background_status", {
                                id: job.id,
                            });
                            return outputParser.Parse(result.details).output;
                        })
                        .toContain("ready");
                    const stopped = await runtime.execute("background_stop", { id: job.id });
                    expect(snapshotParser.Parse(stopped.details).state).toBe("stopped");
                } else {
                    await expect
                        .poll(async () => {
                            const status = await runtime.execute("background_status", {
                                id: job.id,
                            });
                            return outputParser.Parse(status.details).job.state;
                        })
                        .toBe("completed");
                }

                expect(
                    runtime.session.messages.filter((message) => message.role === "custom"),
                ).toEqual([]);

                expect(runtime.session.getFollowUpMessages()).toEqual([]);
                expect(runtime.session.getSteeringMessages()).toEqual([]);
                expect(runtime.requests).toEqual(["synthetic"]);
            } finally {
                runtime.controls.holdResponses = false;

                for (const finish of pendingResponses.splice(0)) finish();
                await prompt;
            }

            await runtime.session.waitForIdle();
            expect(runtime.session.messages.filter((message) => message.role === "custom")).toEqual(
                [],
            );

            expect(runtime.requests).toEqual(["synthetic"]);
            expect(runtime.session.isIdle).toBe(true);

            // A next-turn message is hidden from the current transcript and queues until consumed.
            // A later user request must not reveal deferred completion context either.
            await runtime.session.prompt("A later user request");
            expect(runtime.requests).toEqual(["synthetic", "synthetic"]);
            expect(runtime.session.messages.filter((message) => message.role === "custom")).toEqual(
                [],
            );

            expect(runtime.errors).toEqual([]);
        },
    );
});

it("defaults to finite tasks and collects their results without waiting for services", async () => {
    const runtime = await createRuntime();
    const task = snapshotParser.Parse(
        (
            await runtime.execute("background_start", {
                command: "printf task-result; exit 7",
            })
        ).details,
    );
    const service = snapshotParser.Parse(
        (
            await runtime.execute("background_start", {
                command: "printf service-ready; while :; do sleep 0.01; done",
                kind: "service",
            })
        ).details,
    );
    expect(task.kind).toBe("task");
    expect(service.kind).toBe("service");
    const result = await runtime.execute("background_wait", {});
    expect(waitParser.Parse(result.details).jobs).toMatchObject([
        {
            job: { id: task.id, kind: "task", state: "completed", exitCode: 7 },
            output: "task-result",
            truncated: false,
        },
    ]);

    expect(result.structuredContent).toEqual(result.details);
    const serviceStatus = await runtime.execute("background_status", { id: service.id });
    expect(outputParser.Parse(serviceStatus.details).job.state).toBe("running");
    expect(waitParser.Parse((await runtime.execute("background_wait", {})).details).jobs).toEqual(
        [],
    );
    await expect(runtime.execute("background_wait", { ids: [service.id] })).rejects.toThrow(
        /service/i,
    );
    await runtime.execute("background_stop", { id: service.id });
});

it("requires an explicit bounded foreground shell deadline before execution", async () => {
    const runtime = await createRuntime();
    for (const timeout of [undefined, 0, -1, Number.POSITIVE_INFINITY, 121]) {
        const result = await runtime.session.extensionRunner.emitToolCall({
            type: "tool_call",
            toolName: "bash",
            toolCallId: "guarded-shell",
            input: { command: "printf test", timeout },
        });
        expect(result?.block).toBe(true);
        expect(result?.reason).toContain("has not started");
        expect(result?.reason).toContain("background_start");
    }

    for (const timeout of [1, 60, 120]) {
        expect(
            await runtime.session.extensionRunner.emitToolCall({
                type: "tool_call",
                toolName: "bash",
                toolCallId: "bounded-shell",
                input: { command: "printf test", timeout },
            }),
        ).toBeUndefined();
    }

    expect(
        await runtime.session.extensionRunner.emitToolCall({
            type: "tool_call",
            toolName: "read",
            toolCallId: "read-file",
            input: { path: "source.ts" },
        }),
    ).toBeUndefined();
});

it("returns an inspection checkpoint through Pi without cancelling the running command", async () => {
    const runtime = await createRuntime();
    const job = snapshotParser.Parse(
        (
            await runtime.execute("background_start", {
                command:
                    "node -e 'process.stdout.write(\"working\\n\"); setInterval(() => {}, 1000)'",
            })
        ).details,
    );
    const result = await runtime.execute("background_wait", { ids: [job.id], timeout: 1 });
    expect(waitParser.Parse(result.details)).toMatchObject({
        timedOut: true,
        jobs: [{ job: { id: job.id, state: "running" }, output: "working\n" }],
    });

    expect(result.structuredContent).toEqual(result.details);
    expect(
        result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
    ).toContain("Inspect");
    expect(
        outputParser.Parse((await runtime.execute("background_status", { id: job.id })).details).job
            .state,
    ).toBe("running");
    await runtime.execute("background_stop", { id: job.id });
    expect(waitParser.Parse((await runtime.execute("background_wait", {})).details)).toEqual({
        jobs: [],
        timedOut: false,
    });
});

it("forwards selected task IDs without waiting for other outstanding tasks", async () => {
    const runtime = await createRuntime();
    const blocked = snapshotParser.Parse(
        (
            await runtime.execute("background_start", {
                command: "while :; do sleep 0.01; done",
            })
        ).details,
    );
    const selected = snapshotParser.Parse(
        (
            await runtime.execute("background_start", {
                command: "printf selected-result",
                kind: "task",
            })
        ).details,
    );
    const result = waitParser.Parse(
        (await runtime.execute("background_wait", { ids: [selected.id] })).details,
    );
    expect(result.jobs.map((entry) => entry.job.id)).toEqual([selected.id]);
    expect(result.jobs[0]?.output).toBe("selected-result");
    const status = outputParser.Parse(
        (await runtime.execute("background_status", { id: blocked.id })).details,
    );
    expect(status.job.state).toBe("running");
    await runtime.execute("background_stop", { id: blocked.id });
    expect(waitParser.Parse((await runtime.execute("background_wait", {})).details).jobs).toEqual(
        [],
    );
});

it("cancels a wait without stopping or collecting its running task", async () => {
    const runtime = await createRuntime();
    const task = snapshotParser.Parse(
        (
            await runtime.execute("background_start", {
                command:
                    "printf ready > ready; while [ ! -e release ]; do sleep 0.01; done; printf survived",
            })
        ).details,
    );
    await expect
        .poll(async () => {
            try {
                await access(join(runtime.cwd, "ready"));
                return true;
            } catch {
                return false;
            }
        })
        .toBe(true);
    const controller = new AbortController();
    const waiting = runtime.execute("background_wait", { ids: [task.id] }, controller.signal);
    const cancelled = expect(waiting).rejects.toThrow("Cancelled integration wait");
    controller.abort(new Error("Cancelled integration wait"));
    await cancelled;
    const status = await runtime.execute("background_status", { id: task.id });
    expect(outputParser.Parse(status.details).job.state).toBe("running");
    await writeFile(join(runtime.cwd, "release"), "");
    const completed = waitParser.Parse((await runtime.execute("background_wait", {})).details);
    expect(completed.jobs).toMatchObject([
        {
            job: { id: task.id, state: "completed", exitCode: 0 },
            output: "survived",
        },
    ]);
});

it("treats terminal status and explicit stop as collected task results", async () => {
    const runtime = await createRuntime();
    const task = snapshotParser.Parse(
        (
            await runtime.execute("background_start", {
                command: "printf already-observed",
            })
        ).details,
    );
    await expect
        .poll(async () => {
            const result = await runtime.execute("background_status", { id: task.id });
            return outputParser.Parse(result.details).job.state;
        })
        .toBe("completed");
    const running = snapshotParser.Parse(
        (
            await runtime.execute("background_start", {
                command: "while :; do sleep 0.01; done",
            })
        ).details,
    );
    await runtime.execute("background_stop", { id: running.id });
    expect(waitParser.Parse((await runtime.execute("background_wait", {})).details).jobs).toEqual(
        [],
    );
});
