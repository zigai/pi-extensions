import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    AssistantMessageComponent,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    initTheme,
    InteractiveMode,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TimestampFormat } from "../src/format.ts";
import { Timestamps } from "../src/timestamps.ts";

// Chalk reads FORCE_COLOR when the real host module is imported, not at render time.
const forceColor = vi.hoisted(() => {
    const previous = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    return previous;
});

afterAll(() => {
    if (forceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = forceColor;
});

class TestTerminal implements Terminal {
    columns = 64;
    rows = 24;
    kittyProtocolActive = false;

    start(): void {}

    stop(): void {}

    async drainInput(): Promise<void> {}

    write(): void {}

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

const rowSchema = Type.Object({
    render: Type.Function([Type.Number()], Type.Array(Type.String())),
    handleMouse: Type.Optional(Type.Function([Type.Unknown()], Type.Unknown())),
});

const hostSchema = Type.Object({
    chatContainer: Type.Object({ children: Type.Array(rowSchema) }),
    streamingComponent: Type.Optional(rowSchema),
    handleEvent: Type.Function([Type.Unknown()], Type.Unknown()),
});

const thinking =
    "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.\n\nhttps://example.test/reference\n\nMore reasoning follows the link and wraps across several lines in a narrow terminal.";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
    return {
        role: "assistant",
        content,
        api: "timestamp-test",
        provider: "timestamp-test",
        model: "sample",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: new Date(2024, 0, 2, 6, 15).getTime(),
    };
}

async function createHost(format: TimestampFormat, history: AssistantMessage[] = []) {
    const root = await mkdtemp(join(tmpdir(), "pi-timestamps-streaming-"));
    const sessionManager = SessionManager.inMemory(root);
    for (const message of history) sessionManager.appendMessage(message);
    const settingsManager = SettingsManager.inMemory({
        quietStartup: true,
        tuiMode: "fullscreen",
        fullscreenExitOutput: "resume-hint",
        hideThinkingBlock: false,
        outputPad: 0,
        terminal: { showTerminalProgress: false, hyperlinks: true, images: false },
    });
    const modelRuntime = await ModelRuntime.create({
        authPath: join(root, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    modelRuntime.registerProvider("timestamp-test", {
        api: "timestamp-test",
        apiKey: "nonsecret",
        baseUrl: "http://127.0.0.1:1",
        models: [
            {
                id: "sample",
                name: "Sample",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 10000,
                maxTokens: 100,
            },
        ],
        streamSimple() {
            throw new Error("Model dispatch is forbidden in timestamp rendering tests");
        },
    });
    const model = modelRuntime.getModel("timestamp-test", "sample");
    if (!model) throw new Error("Synthetic model missing");

    let timestamps: Timestamps | undefined;
    const runtime = await createAgentSessionRuntime(
        async (options) => {
            const services = await createAgentSessionServices({
                ...options,
                modelRuntime,
                settingsManager,
                resourceLoaderOptions: {
                    noExtensions: true,
                    noSkills: true,
                    noThemes: true,
                    noPromptTemplates: true,
                    noContextFiles: true,
                    extensionFactories: [
                        (pi) => {
                            pi.on("session_start", (_event, ctx) => {
                                timestamps = new Timestamps(ctx, { enabled: true, format });
                            });
                            pi.on("session_shutdown", () => timestamps?.dispose());
                        },
                    ],
                },
            });
            const result = await createAgentSessionFromServices({
                services,
                sessionManager: options.sessionManager,
                model,
                noTools: "all",
            });

            return { ...result, services, diagnostics: services.diagnostics };
        },
        { cwd: root, agentDir: root, sessionManager },
    );
    initTheme("dark", false);
    const interactive = new InteractiveMode(runtime, { terminal: new TestTerminal() });
    const dispose = async () => {
        timestamps?.dispose();
        interactive.stop();
        await runtime.dispose();
        await rm(root, { recursive: true, force: true });
    };
    try {
        await interactive.init();

        if (!timestamps) throw new Error("Timestamp extension did not activate");

        // The SDK keeps event delivery private. Validate its real host boundary rather
        // than replacing InteractiveMode methods or constructing a look-alike host.
        const host = Compile(hostSchema).Parse(interactive);

        return {
            host,
            timestamps,
            event: (event: AgentSessionEvent) => host.handleEvent(event),
            dispose,
        };
    } catch (cause) {
        await dispose();
        throw cause;
    }
}

function body(lines: string[], label?: string): string[] {
    return lines.map((line) => {
        let plain = stripTerminalSequences(line);
        if (label !== undefined) plain = plain.replace(label, "");

        return plain.trimEnd();
    });
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2024, 0, 2, 10, 30));
    vi.stubEnv("PI_OFFLINE", "1");
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

it.each([
    { format: "auto", width: 48, label: "10:30", gutter: 7 },
    { format: "time-only", width: 64, label: "10:30", gutter: 7 },
    { format: "date-time", width: 64, label: "02.01.2024 10:30", gutter: 18 },
    { format: "relative", width: 48, label: "just now", gutter: 10 },
] satisfies { format: TimestampFormat; width: number; label: string; gutter: number }[])(
    "keeps thinking layout and link ANSI unchanged when $format streaming completes",
    async ({ format, width, label, gutter }) => {
        const fixture = await createHost(format);
        const message = assistant([{ type: "thinking", thinking }]);
        try {
            await fixture.event({ type: "message_start", message: assistant([]) });
            const row = fixture.host.streamingComponent;
            if (!row) throw new Error("Streaming assistant missing");

            expect(row.render(width)).toEqual([]);
            await fixture.event({
                type: "message_update",
                message,
                assistantMessageEvent: {
                    type: "thinking_delta",
                    contentIndex: 0,
                    delta: thinking,
                    partial: message,
                },
            });
            const before = row.render(width);
            const reference = new AssistantMessageComponent(
                message,
                false,
                undefined,
                undefined,
                0,
            );
            expect(body(before)).toEqual(body(reference.render(width - gutter)));
            expect(before.join("\n")).not.toContain(label);
            const linkBefore = before.find((line) =>
                line.includes("https://example.test/reference"),
            );
            expect(linkBefore).toContain("\x1b[4m");
            expect(linkBefore).toContain("\x1b]8;");

            await fixture.event({ type: "message_end", message });
            const after = row.render(width);
            expect(after.join("\n")).toContain(`\x1b[2m${label}\x1b[22m`);
            expect(body(after, label)).toEqual(body(before));
            expect(after.find((line) => line.includes("https://example.test/reference"))).toBe(
                linkBefore,
            );

            expect(fixture.host.streamingComponent).toBeUndefined();

            fixture.timestamps.dispose();
            expect(row.render(width)).toEqual(reference.render(width));
            expect(body(row.render(width))).not.toEqual(body(before));
        } finally {
            await fixture.dispose();
        }
    },
);

it("reserves the same gutter on restored assistants even when the first line has room", async () => {
    const message = assistant([
        { type: "thinking", thinking: `Short.\n\n${thinking}` },
        { type: "text", text: "A completed response also shares the reserved message gutter." },
    ]);
    const fixture = await createHost("time-only", [message]);
    try {
        const row = fixture.host.chatContainer.children.at(-1);
        if (!row) throw new Error("Restored assistant missing");

        const reference = new AssistantMessageComponent(message, false, undefined, undefined, 0);
        const restored = row.render(64);
        expect(restored.join("\n")).toContain("\x1b[2m10:30\x1b[22m");
        expect(restored.join("\n")).not.toContain("06:15");
        expect(body(restored, "10:30")).toEqual(body(reference.render(57)));
        fixture.timestamps.dispose();
        expect(row.render(64)).toEqual(reference.render(64));
    } finally {
        await fixture.dispose();
    }
});

it("updates the reserved gutter after format clicks and resize, without a pending timestamp target", async () => {
    const fixture = await createHost("time-only");
    const message = assistant([{ type: "thinking", thinking }]);
    const click: TuiMouseEvent = {
        type: "click",
        button: "left",
        x: 58,
        y: 1,
        screenX: 58,
        screenY: 1,
        width: 64,
        height: 24,
        shift: false,
        alt: false,
        ctrl: false,
    };
    try {
        await fixture.event({ type: "message_start", message });
        const row = fixture.host.streamingComponent;
        if (!row?.handleMouse) throw new Error("Streaming assistant mouse handler missing");

        const reference = new AssistantMessageComponent(message, false, undefined, undefined, 0);
        row.render(64);
        expect(row.handleMouse({ ...click, type: "press" })).not.toEqual({ handled: true });
        expect(body(row.render(64))).toEqual(body(reference.render(57)));

        await fixture.event({ type: "message_end", message });
        row.render(64);
        expect(row.handleMouse(click)).toEqual({ handled: true });
        expect(body(row.render(64), "02.01.2024 10:30")).toEqual(body(reference.render(46)));

        const resized = row.render(48);
        expect(body(resized, "02.01.2024 10:30")).toEqual(body(reference.render(30)));
        expect(row.handleMouse({ ...click, type: "press" })).not.toEqual({ handled: true });
        row.render(48);
        expect(row.handleMouse({ ...click, x: 31, width: 48 })).toEqual({ handled: true });
        expect(row.render(48).join("\n")).toContain("\x1b[2mjust now\x1b[22m");
        expect(body(row.render(48), "just now")).toEqual(body(reference.render(38)));
    } finally {
        await fixture.dispose();
    }
});

it("routes lower wrapped thinking clicks at the reserved content width", async () => {
    const fixture = await createHost("date-time");
    const message = assistant([{ type: "thinking", thinking }]);
    const width = 48;
    const reference = new AssistantMessageComponent(message, false, undefined, undefined, 0);
    const collapsed = new AssistantMessageComponent(message, true, undefined, undefined, 0);
    try {
        await fixture.event({ type: "message_start", message });
        const row = fixture.host.streamingComponent;
        if (!row?.handleMouse) throw new Error("Streaming assistant mouse handler missing");

        for (const completed of [false, true]) {
            let label: string | undefined;
            if (completed) {
                await fixture.event({ type: "message_end", message });
                label = "02.01.2024 10:30";
            }

            const expanded = row.render(width);
            const y = expanded.length - 1;

            // This body line exists only at the narrow layout, below the entire
            // full-width thinking region. Stay left of the timestamp hit target.
            expect(y).toBeGreaterThanOrEqual(reference.render(width).length);
            expect(body(expanded)[y]).not.toBe("");
            const click: TuiMouseEvent = {
                type: "click",
                button: "left",
                x: 0,
                y,
                screenX: 0,
                screenY: y,
                width,
                height: expanded.length,
                shift: false,
                alt: false,
                ctrl: false,
            };
            expect(row.handleMouse(click)).toMatchObject({ handled: true, target: { width: 30 } });
            expect(body(row.render(width), label)).toEqual(body(collapsed.render(30)));

            if (!completed) {
                // Reopen via the real handler so completion gets the same test.
                expect(row.handleMouse({ ...click, y: 1, screenY: 1 })).toMatchObject({
                    handled: true,
                    target: { width: 30 },
                });
            }
        }
    } finally {
        await fixture.dispose();
    }
});

it("does not attach row patches when disposed during an awaited message_start", async () => {
    const fixture = await createHost("date-time");
    const message = assistant([{ type: "thinking", thinking }]);
    try {
        const event = fixture.event({ type: "message_start", message });
        fixture.timestamps.dispose();
        await event;
        const row = fixture.host.streamingComponent;
        if (!row) throw new Error("Streaming assistant missing");

        expect.soft(Object.hasOwn(row, "render")).toBe(false);
        expect.soft(Object.hasOwn(row, "handleMouse")).toBe(false);
        const reference = new AssistantMessageComponent(message, false, undefined, undefined, 0);
        for (const width of [48, 64]) {
            expect(row.render(width)).toEqual(reference.render(width));
        }
    } finally {
        await fixture.dispose();
    }
});

it("keeps assistant dividers full width and omits labels in terminals too narrow for a gutter", async () => {
    const fixture = await createHost("date-time");
    const message = assistant([{ type: "text", text: "---\n\nBody text." }]);
    try {
        await fixture.event({ type: "message_start", message });
        const row = fixture.host.streamingComponent;
        if (!row) throw new Error("Streaming assistant missing");

        const before = row.render(48);
        expect(before.map(stripTerminalSequences)).toContain("─".repeat(48));
        await fixture.event({ type: "message_end", message });
        const after = row.render(48);
        expect(after.map(stripTerminalSequences)).toContain("─".repeat(48));
        expect(after.join("\n")).toContain("\x1b[2m02.01.2024 10:30\x1b[22m");
        expect(body(after, "02.01.2024 10:30")).toEqual(body(before));

        const reference = new AssistantMessageComponent(message, false, undefined, undefined, 0);
        expect(row.render(7)).toEqual(reference.render(7));
    } finally {
        await fixture.dispose();
    }
});
