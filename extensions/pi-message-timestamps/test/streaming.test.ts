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
import { installLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TimestampFormat } from "../src/format.ts";
import type { MessageTimestampsSettings } from "../src/settings.ts";
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
    chatContainer: Type.Object({
        children: Type.Array(rowSchema),
        addChild: Type.Function([Type.Unknown()], Type.Void()),
    }),
    streamingComponent: Type.Optional(rowSchema),
    handleEvent: Type.Function([Type.Unknown()], Type.Unknown()),
    addMessageToChat: Type.Function([Type.Unknown()], Type.Void()),
    renderSessionEntries: Type.Function([Type.Array(Type.Unknown())], Type.Void()),
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

async function createHost(
    format: TimestampFormat,
    history: Parameters<SessionManager["appendMessage"]>[0][] = [],
    assistantPlacement: MessageTimestampsSettings["assistantPlacement"] = "first-line",
) {
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
    let style: ((text: string) => string) | undefined;
    const notifications: string[] = [];
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
                                const notify = ctx.ui.notify.bind(ctx.ui);
                                ctx.ui.notify = (message, type) => {
                                    notifications.push(message);
                                    notify(message, type);
                                };
                                style = (text) => ctx.ui.theme.fg("dim", text);
                                timestamps = new Timestamps(ctx, {
                                    enabled: true,
                                    format,
                                    assistantPlacement,
                                });
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

        if (!timestamps || !style) throw new Error("Timestamp extension did not activate");

        // The SDK keeps event delivery private. Validate its real host boundary rather
        // than replacing InteractiveMode methods or constructing a look-alike host.
        const host = Compile(hostSchema).Parse(interactive);

        return {
            host,
            timestamps,
            style,
            notifications,
            sessionManager,
            restore: () => host.renderSessionEntries(sessionManager.buildContextEntries()),
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
            expect(after.join("\n")).toContain(fixture.style(label));
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
        expect(restored.join("\n")).toContain(fixture.style("10:30"));
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
        expect(row.render(48).join("\n")).toContain(fixture.style("just now"));
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
        expect(after.join("\n")).toContain(fixture.style("02.01.2024 10:30"));
        expect(body(after, "02.01.2024 10:30")).toEqual(body(before));

        const reference = new AssistantMessageComponent(message, false, undefined, undefined, 0);
        expect(row.render(7)).toEqual(reference.render(7));
    } finally {
        await fixture.dispose();
    }
});

function observeHistoryReads(container: { children: unknown[] }) {
    const children = container.children;
    let reads = 0;
    const descriptors = children.map((row, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(children, index);
        Object.defineProperty(children, index, {
            configurable: true,
            enumerable: true,
            get() {
                reads += 1;
                return row;
            },
        });

        return descriptor;
    });

    return {
        count: () => reads,
        restore() {
            for (const [index, descriptor] of descriptors.entries())
                if (descriptor !== undefined) Object.defineProperty(children, index, descriptor);
        },
    };
}

function observeRenderReads(row: { render(width: number): string[] }) {
    const descriptor = Object.getOwnPropertyDescriptor(row, "render");
    const render = row.render.bind(row);
    let reads = 0;
    Object.defineProperty(row, "render", {
        configurable: true,
        get() {
            reads += 1;
            return render;
        },
    });

    return {
        count: () => reads,
        restore() {
            if (descriptor === undefined) Reflect.deleteProperty(row, "render");
            else Object.defineProperty(row, "render", descriptor);
        },
    };
}

it("does not inspect historical rows for unrelated real SDK events", async () => {
    const fixture = await createHost(
        "time-only",
        Array.from({ length: 32 }, (_, index) =>
            assistant([{ type: "text", text: `History ${index}` }]),
        ),
    );
    const row = fixture.host.chatContainer.children.at(0);
    if (!row) throw new Error("Historical assistant missing");

    const reads = observeRenderReads(row);
    const historyReads = observeHistoryReads(fixture.host.chatContainer);
    const message = assistant([{ type: "text", text: "Streaming response" }]);
    try {
        await fixture.event({ type: "message_start", message });

        // Start/end are relevant, but neither needs to validate historical components.
        expect.soft(reads.count()).toBe(0);

        for (let index = 0; index < 100; index += 1) {
            await fixture.event({
                type: "message_update",
                message,
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 0,
                    delta: "x",
                    partial: message,
                },
            });
        }

        await fixture.event({ type: "agent_start" });
        await fixture.event({
            type: "message_end",
            message: { role: "user", content: "User", timestamp: Date.now() },
        });
        expect.soft(reads.count()).toBe(0);
        await fixture.event({ type: "message_end", message });
        expect(reads.count()).toBe(0);
        expect(historyReads.count()).toBe(0);
        expect(fixture.notifications).toEqual([]);
    } finally {
        historyReads.restore();
        reads.restore();
        await fixture.dispose();
    }
});

it("does not revisit existing rows when the SDK restores more session entries", async () => {
    const fixture = await createHost("time-only", [
        assistant([{ type: "text", text: "Existing" }]),
    ]);
    const row = fixture.host.chatContainer.children.at(0);
    if (!row) throw new Error("Historical assistant missing");

    const reads = observeRenderReads(row);
    const historyReads = observeHistoryReads(fixture.host.chatContainer);
    try {
        for (let index = 0; index < 32; index += 1)
            fixture.sessionManager.appendMessage(
                assistant([{ type: "text", text: `Restored ${index}` }]),
            );

        fixture.restore();
        expect(reads.count()).toBe(0);
        expect(historyReads.count()).toBe(0);
        const restored = fixture.host.chatContainer.children.at(-1);
        expect(restored?.render(64).join("\n")).toContain(fixture.style("10:30"));
        expect(fixture.notifications).toEqual([]);
    } finally {
        historyReads.restore();
        reads.restore();
        await fixture.dispose();
    }
});

it("ignores an unsupported historical component instead of rejecting a new streaming row", async () => {
    const fixture = await createHost("time-only", [
        assistant([{ type: "text", text: "Existing" }]),
    ]);
    const historical = fixture.host.chatContainer.children.at(0);
    if (!historical) throw new Error("Historical assistant missing");

    const descriptor = Object.getOwnPropertyDescriptor(historical, "render");
    const message = assistant([{ type: "text", text: "New response" }]);
    try {
        Reflect.set(historical, "render", undefined);
        await fixture.event({ type: "message_start", message });
        const row = fixture.host.streamingComponent;
        if (!row) throw new Error("Streaming assistant missing");

        expect.soft(Object.hasOwn(row, "render")).toBe(true);
        await fixture.event({ type: "message_end", message });
        expect.soft(row.render(64).join("\n")).toContain(fixture.style("10:30"));
        expect(fixture.notifications).toEqual([]);
    } finally {
        if (descriptor === undefined) Reflect.deleteProperty(historical, "render");
        else Object.defineProperty(historical, "render", descriptor);

        await fixture.dispose();
    }
});

it.each(["message_start", "message_end"] as const)(
    "safely skips and reports an invalid actually-used streaming component at %s",
    async (type) => {
        const fixture = await createHost("time-only");
        const message = assistant([{ type: "text", text: "Response" }]);
        let restore = () => {};
        try {
            const started = fixture.event({ type: "message_start", message });
            const row = fixture.host.streamingComponent;
            if (!row) throw new Error("Streaming assistant missing");
            if (type === "message_end") await started;

            const descriptor = Object.getOwnPropertyDescriptor(row, "render");
            restore = () => {
                if (descriptor === undefined) Reflect.deleteProperty(row, "render");
                else Object.defineProperty(row, "render", descriptor);
            };
            Reflect.set(row, "render", undefined);

            if (type === "message_start") await started;
            else await fixture.event({ type: "message_end", message });

            expect(row.render).toBeUndefined();

            if (type === "message_start") expect(Object.hasOwn(row, "handleMouse")).toBe(false);

            expect(fixture.notifications).toEqual([
                "Message timestamps: unsupported interactive host shape; timestamps may be unavailable.",
            ]);
        } finally {
            restore();
            await fixture.dispose();
        }
    },
);

it("safely skips invalid newly-restored components and warns only once", async () => {
    const fixture = await createHost("time-only");
    const invalid: { component: AssistantMessageComponent; restore(): void }[] = [];
    const patch = installLinkedMethodPatch(
        fixture.host.chatContainer,
        "addChild",
        (previous) =>
            function (component) {
                previous.call(this, component);

                if (!(component instanceof AssistantMessageComponent)) return;

                const descriptor = Object.getOwnPropertyDescriptor(component, "render");
                invalid.push({
                    component,
                    restore() {
                        if (descriptor === undefined) Reflect.deleteProperty(component, "render");
                        else Object.defineProperty(component, "render", descriptor);
                    },
                });

                Reflect.set(component, "render", undefined);
            },
    );
    try {
        for (let index = 0; index < 2; index += 1) {
            const message = assistant([{ type: "text", text: `Invalid ${index}` }]);
            fixture.sessionManager.appendMessage(message);
            fixture.host.addMessageToChat(message);
        }

        expect(invalid).toHaveLength(2);

        for (const { component } of invalid) {
            expect(Object.getOwnPropertyDescriptor(component, "render")).toMatchObject({
                value: undefined,
            });

            expect(Object.hasOwn(component, "handleMouse")).toBe(false);
        }

        expect(fixture.notifications).toEqual([
            "Message timestamps: unsupported interactive host shape; timestamps may be unavailable.",
        ]);
    } finally {
        patch.dispose();

        for (const entry of invalid) entry.restore();
        await fixture.dispose();
    }
});

it("rechecks mutable required host capabilities without probing them for unrelated events", async () => {
    const fixture = await createHost("time-only");
    const descriptor = Object.getOwnPropertyDescriptor(fixture.sessionManager, "getSessionId");
    const restore = () => {
        if (descriptor === undefined)
            Reflect.deleteProperty(fixture.sessionManager, "getSessionId");
        else Object.defineProperty(fixture.sessionManager, "getSessionId", descriptor);
    };
    try {
        // First observe a valid host; a cached positive shape result must not survive mutation.
        fixture.host.addMessageToChat(assistant([{ type: "text", text: "Before mutation" }]));
        Reflect.set(fixture.sessionManager, "getSessionId", undefined);
        await fixture.event({ type: "agent_start" });
        expect(fixture.notifications).toEqual([]);
        fixture.host.addMessageToChat(assistant([{ type: "text", text: "Unsupported host" }]));
        const skipped = fixture.host.chatContainer.children.at(-1);
        expect(skipped?.render(64).join("\n")).not.toContain(fixture.style("10:30"));
        expect(fixture.notifications).toEqual([
            "Message timestamps: unsupported interactive host shape; timestamps may be unavailable.",
        ]);

        restore();
        fixture.host.addMessageToChat(assistant([{ type: "text", text: "Recovered host" }]));

        // Assistants outside persisted history have no completion time; use a user to
        // verify shape recovery independently of assistant timestamp lookup policy.
        fixture.host.addMessageToChat({
            role: "user",
            content: "Recovered",
            timestamp: Date.now(),
        });
        const recovered = fixture.host.chatContainer.children.at(-1);
        expect(recovered?.render(64).join("\n")).toContain(fixture.style("10:30"));
        expect(fixture.notifications).toHaveLength(1);
    } finally {
        restore();
        await fixture.dispose();
    }
});

it("observes completion before awaiting the SDK and preserves a foreign row patch on disposal", async () => {
    const fixture = await createHost("time-only");
    let foreign: { dispose(): void } | undefined;
    const message = assistant([{ type: "text", text: "Completed" }]);
    try {
        await fixture.event({ type: "message_start", message });
        const row = fixture.host.streamingComponent;
        if (!row) throw new Error("Streaming assistant missing");

        const ended = fixture.event({ type: "message_end", message });
        vi.setSystemTime(new Date(2024, 0, 2, 11, 30));
        await ended;
        expect(row.render(64).join("\n")).toContain(fixture.style("10:30"));
        foreign = installLinkedMethodPatch(
            row,
            "render",
            (previous) =>
                function (width) {
                    return [...previous.call(this, width), "Foreign patch"];
                },
        );
        fixture.timestamps.dispose();
        const reference = new AssistantMessageComponent(message, false, undefined, undefined, 0);
        expect(row.render(64)).toEqual([...reference.render(64), "Foreign patch"]);
        foreign.dispose();
        expect(row.render(64)).toEqual(reference.render(64));
    } finally {
        foreign?.dispose();
        await fixture.dispose();
    }
});

it.each(["message_start", "message_end"] as const)(
    "does not attach a timestamp after the host changes sessions during awaited %s",
    async (type) => {
        const fixture = await createHost("time-only");
        const message = assistant([{ type: "text", text: "Old session response" }]);
        const descriptor = Object.getOwnPropertyDescriptor(fixture.host, "sessionManager");
        try {
            const started = fixture.event({ type: "message_start", message });
            const row = fixture.host.streamingComponent;
            if (!row) throw new Error("Streaming assistant missing");

            let pending = started;

            if (type === "message_end") {
                await started;
                pending = fixture.event({ type: "message_end", message });
            }

            Object.defineProperty(fixture.host, "sessionManager", {
                configurable: true,
                value: SessionManager.inMemory(fixture.sessionManager.getCwd()),
            });
            await pending;
            expect(row.render(64).join("\n")).not.toContain(fixture.style("10:30"));

            if (type === "message_start") expect(Object.hasOwn(row, "render")).toBe(false);
            expect(fixture.notifications).toEqual([]);
        } finally {
            if (descriptor === undefined) Reflect.deleteProperty(fixture.host, "sessionManager");
            else Object.defineProperty(fixture.host, "sessionManager", descriptor);

            await fixture.dispose();
        }
    },
);

it("rechecks the event after awaiting a mutable predecessor", async () => {
    const fixture = await createHost("time-only");
    const message = assistant([{ type: "text", text: "Changed delivery" }]);
    try {
        await fixture.event({ type: "message_start", message });
        const row = fixture.host.streamingComponent;
        if (!row) throw new Error("Streaming assistant missing");

        const ended: AgentSessionEvent = { type: "message_end", message };
        const pending = fixture.event(ended);
        Reflect.set(ended, "type", "agent_start");
        await pending;
        expect(row.render(64).join("\n")).not.toContain(fixture.style("10:30"));
    } finally {
        await fixture.dispose();
    }
});

it("puts the completion time right of the last line without narrowing the response", async () => {
    const fixture = await createHost("time-only", [], "last-line");
    const message = assistant([{ type: "text", text: "Short closing line." }]);
    try {
        await fixture.event({ type: "message_start", message });
        const row = fixture.host.streamingComponent;
        if (!row) throw new Error("Streaming assistant missing");

        const reference = new AssistantMessageComponent(message, false, undefined, undefined, 0);
        const before = row.render(64);
        expect(body(before)).toEqual(body(reference.render(64)));
        expect(before.join("\n")).not.toContain("10:30");

        await fixture.event({ type: "message_end", message });
        const after = row.render(64);
        expect(body(after, "10:30")).toEqual(body(before));
        const last = after.filter((line) => stripTerminalSequences(line).trim().length > 0).at(-1);
        expect(last).toContain(fixture.style("10:30"));
        expect(stripTerminalSequences(last ?? "")).toContain("Short closing line.");
    } finally {
        await fixture.dispose();
    }
});

it("adds a blank line and a details line below a finished response", async () => {
    const user = {
        role: "user" as const,
        content: "Question",
        timestamp: new Date(2024, 0, 2, 10, 28).getTime(),
    };
    const answer = {
        ...assistant([{ type: "text", text: "The answer wraps across lines in this terminal." }]),
        usage: {
            input: 200,
            output: 1500,
            cacheRead: 1000,
            cacheWrite: 0,
            totalTokens: 2700,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    };
    const toolCall = {
        ...assistant([{ type: "text", text: "Checking a file first." }]),
        stopReason: "toolUse" as const,
    };
    const fixture = await createHost("time-only", [user, toolCall, answer], "below");
    try {
        const rows = fixture.host.chatContainer.children;
        const finished = rows.at(-1);
        if (!finished) throw new Error("Restored assistant missing");

        const reference = new AssistantMessageComponent(answer, false, undefined, undefined, 0);
        const plain = body(finished.render(60));
        const expected = body(reference.render(60));
        let end = expected.length;
        while (end > 0 && expected[end - 1] === "") end--;
        expect(plain).toEqual([
            ...expected.slice(0, end),
            "",
            "10:30 · sample · worked 2m 0s · 1.2k in · 1.5k out",
            ...expected.slice(end),
        ]);

        const intermediate = rows.find(
            (row) =>
                row !== finished &&
                body(row.render(40)).some((line) => line.includes("Checking a file first.")),
        );
        if (!intermediate) throw new Error("Restored tool-call assistant missing");

        const footer = body(intermediate.render(40)).filter((line) => line.includes("10:30"));
        expect(footer).toEqual(["10:30"]);
    } finally {
        await fixture.dispose();
    }
});
