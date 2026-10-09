import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Loader, type TUI } from "@earendil-works/pi-tui";

import { RenderCountingTui } from "./tui-fixture.ts";

import { createStatusBarLifecycle } from "../src/index.ts";
import { configureStatusBar, resetStatusBarStateForTests } from "../src/status-bar-api.ts";
import {
    resetWorkedForWidgetCache,
    WIDGET_KEY,
    WORKED_FOR_STATE_ENTRY,
    type WorkedForState,
} from "../src/worked-for-widget.ts";

type LifecycleEvent = {
    readonly message?: {
        readonly role: "user" | "assistant";
        readonly stopReason?: string;
        readonly usage?: { readonly output: number; readonly reasoning?: number };
    };

    readonly assistantMessageEvent?: Parameters<
        ReturnType<typeof createStatusBarLifecycle>["message_update"]
    >[0]["assistantMessageEvent"];
};
type WidgetFactory = (
    tui: TUI,
    theme: { fg(role: string, text: string): string },
) => { render(width: number): string[] };
type LifecycleContext = Parameters<ReturnType<typeof createStatusBarLifecycle>["agent_start"]>[1];
type LifecycleHarness = {
    readonly appendEntries: WorkedForState[];
    readonly context: LifecycleContext;
    readonly currentWidget: () => WidgetFactory | undefined;
    readonly hasHandler: (event: string) => boolean;
    readonly invoke: (event: string, payload?: LifecycleEvent) => Promise<void>;
    readonly setIdle: (idle: boolean) => void;
};
type LoaderPrototypeOwner = {
    updateDisplay: (this: Loader) => void;
};
type LoaderPrototypeBoundary = Loader | LoaderPrototypeOwner;

class WorkingLoader extends Loader {
    readonly kind = "working";
}

function createWorkingLoader(): WorkingLoader {
    return new WorkingLoader(
        new RenderCountingTui(),
        (text) => text,
        (text) => text,
        "Working",
        { frames: ["⠙"] },
    );
}

function renderedLoaderText(loader: Loader): string {
    return loader.render(80)[1]?.trim() ?? "";
}

function isLoaderPrototypeOwner(value: unknown): value is LoaderPrototypeOwner {
    return (
        typeof value === "object" &&
        value !== null &&
        "updateDisplay" in value &&
        typeof value.updateDisplay === "function"
    );
}

function parseLoaderPrototypeOwner(
    value: LoaderPrototypeBoundary,
): LoaderPrototypeOwner | undefined {
    if (!isLoaderPrototypeOwner(value)) return undefined;
    return value;
}

function createHarness(): LifecycleHarness {
    const appendEntries: WorkedForState[] = [];
    let widget: WidgetFactory | undefined;
    let branch: SessionEntry[] = [];
    let idle = true;

    const handlers = createStatusBarLifecycle((data) => {
        appendEntries.push(data);
        branch = [
            ...branch,
            {
                type: "custom",
                id: `entry-${branch.length}`,
                parentId: null,
                timestamp: "2026-07-30T00:00:00.000Z",
                customType: WORKED_FOR_STATE_ENTRY,
                data,
            },
        ];
    });

    const context: LifecycleContext = {
        hasUI: true,
        cwd: process.cwd(),
        isProjectTrusted: () => false,
        isIdle: () => idle,
        sessionManager: {
            getBranch: () => branch,
        },
        ui: {
            notify() {},
            setWidget(key: string, nextWidget: WidgetFactory | undefined): void {
                assert.equal(key, WIDGET_KEY);
                widget = nextWidget;
            },
        },
    };

    return {
        appendEntries,
        context,
        currentWidget: () => widget,
        hasHandler(event: string): boolean {
            return Object.hasOwn(handlers, event);
        },
        async invoke(event: string, payload: LifecycleEvent = {}): Promise<void> {
            switch (event) {
                case "message_start":
                    assert.ok(payload.message);
                    await handlers.message_start({ message: payload.message });
                    break;
                case "message_update":
                    assert.ok(payload.message);
                    assert.ok(payload.assistantMessageEvent);
                    await handlers.message_update({
                        message: payload.message,
                        assistantMessageEvent: payload.assistantMessageEvent,
                    });

                    break;
                case "message_end": {
                    assert.ok(payload.message);

                    if (payload.message.role === "assistant") {
                        assert.ok(payload.message.usage);
                        await handlers.message_end({
                            message: {
                                role: "assistant",
                                usage: payload.message.usage,
                                stopReason: payload.message.stopReason,
                            },
                        });
                    } else {
                        await handlers.message_end({ message: { role: payload.message.role } });
                    }
                    break;
                }
                case "session_start":
                case "session_tree":
                case "agent_start":
                case "agent_settled":
                case "session_shutdown":
                    await handlers[event]({ type: event }, context);
                    break;
                default:
                    throw new Error(`Missing ${event} handler`);
            }
        },
        setIdle(nextIdle: boolean): void {
            idle = nextIdle;
        },
    };
}

function renderedWidgetText(widget: WidgetFactory | undefined): string {
    if (widget === undefined) throw new Error("Expected widget factory");

    const component = widget(new RenderCountingTui(), { fg: (_role, text) => text });
    return component.render(80)[0] ?? "";
}

test("working time survives indicator replacements and restarts for a new run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetStatusBarStateForTests();
    const harness = createHarness();

    try {
        await harness.invoke("session_start");
        await harness.invoke("agent_start");
        const first = createWorkingLoader();
        vi.advanceTimersByTime(2_100);
        assert.equal(renderedLoaderText(first), "⠙ Working (2s)");
        first.stop();

        vi.advanceTimersByTime(1_000);
        await harness.invoke("agent_start");
        const resumed = createWorkingLoader();
        assert.equal(renderedLoaderText(resumed), "⠙ Working (3s)");
        const separate = new Loader(
            new RenderCountingTui(),
            (text) => text,
            (text) => text,
            "Loading",
            { frames: ["⠙"] },
        );
        assert.equal(renderedLoaderText(separate), "⠙ Loading (0s)");
        separate.stop();
        resumed.stop();

        await harness.invoke("agent_settled");
        vi.advanceTimersByTime(1_000);
        await harness.invoke("agent_start");
        const next = createWorkingLoader();
        assert.equal(renderedLoaderText(next), "⠙ Working (0s)");
        next.stop();
    } finally {
        await harness.invoke("session_shutdown");
        vi.useRealTimers();
    }
});

test("working timer pause and reset survive indicator replacements", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetStatusBarStateForTests();
    const harness = createHarness();
    const handle = configureStatusBar({});

    try {
        await harness.invoke("session_start");
        await harness.invoke("agent_start");
        const first = createWorkingLoader();
        vi.advanceTimersByTime(2_100);
        handle.pauseTimer();
        first.stop();

        vi.advanceTimersByTime(2_000);
        const paused = createWorkingLoader();
        assert.equal(renderedLoaderText(paused), "⠙ Working (2s)");
        handle.resumeTimer();
        vi.advanceTimersByTime(1_000);
        assert.equal(renderedLoaderText(paused), "⠙ Working (3s)");
        paused.stop();
        handle.resetTimer();

        vi.advanceTimersByTime(1_000);
        const reset = createWorkingLoader();
        assert.equal(renderedLoaderText(reset), "⠙ Working (1s)");
        reset.stop();
    } finally {
        handle.dispose();
        await harness.invoke("session_shutdown");
        vi.useRealTimers();
    }
});

test("status extension covers completion, abort, restore, and cleanup lifecycles", async () => {
    vi.useFakeTimers();
    resetStatusBarStateForTests();
    resetWorkedForWidgetCache();
    const harness = createHarness();
    const concurrentHarness = createHarness();

    await harness.invoke("agent_start");
    await harness.invoke("message_start", { message: { role: "user" } });
    vi.advanceTimersByTime(100);
    await harness.invoke("message_start", { message: { role: "assistant" } });
    vi.advanceTimersByTime(100);
    await harness.invoke("message_update", {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_start" },
    });
    vi.advanceTimersByTime(1_000);
    await harness.invoke("message_end", {
        message: {
            role: "assistant",
            usage: { output: 120, reasoning: 20 },
        },
    });

    vi.advanceTimersByTime(5_000);
    await harness.invoke("message_start", { message: { role: "assistant" } });
    await harness.invoke("message_update", {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "toolcall_start" },
    });
    vi.advanceTimersByTime(2_000);
    await harness.invoke("message_end", {
        message: { role: "assistant", usage: { output: 200 } },
    });
    assert.equal(harness.hasHandler("agent_end"), false);
    assert.deepEqual(harness.appendEntries, []);
    assert.equal(harness.currentWidget(), undefined);
    await harness.invoke("agent_start");
    await harness.invoke("message_start", { message: { role: "assistant" } });
    await harness.invoke("message_update", {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "thinking_start" },
    });
    vi.advanceTimersByTime(1_000);
    await harness.invoke("message_end", {
        message: { role: "assistant", usage: { output: 100 } },
    });

    harness.setIdle(false);
    await harness.invoke("agent_settled");
    assert.deepEqual(harness.appendEntries, []);
    harness.setIdle(true);
    await harness.invoke("agent_settled");
    assert.deepEqual(harness.appendEntries, [{ durationMs: 9_200, tokensPerSecond: 400 / 4.1 }]);
    assert.equal(renderedWidgetText(harness.currentWidget()), " Worked for 9s. [97.6 tok/s]");
    await harness.invoke("agent_start");
    await harness.invoke("message_start", { message: { role: "user" } });
    await harness.invoke("message_start", { message: { role: "assistant" } });
    await harness.invoke("message_update", {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta" },
    });
    vi.advanceTimersByTime(1_000);
    await harness.invoke("message_end", {
        message: { role: "assistant", usage: { output: 100 } },
    });

    await harness.invoke("message_start", { message: { role: "user" } });
    await harness.invoke("message_start", { message: { role: "assistant" } });
    await harness.invoke("message_update", {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta" },
    });
    vi.advanceTimersByTime(2_000);
    await harness.invoke("message_end", {
        message: { role: "assistant", usage: { output: 50 } },
    });
    await harness.invoke("agent_settled");

    assert.deepEqual(harness.appendEntries[1], {
        durationMs: 3_000,
        tokensPerSecond: 25,
    });
    assert.equal(renderedWidgetText(harness.currentWidget()), " Worked for 3s. [25.0 tok/s]");
    await harness.invoke("agent_start");
    await harness.invoke("message_start", { message: { role: "user" } });
    await harness.invoke("message_start", { message: { role: "assistant" } });
    vi.advanceTimersByTime(500);
    await harness.invoke("message_end", {
        message: { role: "assistant", stopReason: "error", usage: { output: 100 } },
    });
    await harness.invoke("agent_settled");

    assert.deepEqual(harness.appendEntries[2], {
        durationMs: 500,
        tokensPerSecond: undefined,
    });
    assert.equal(renderedWidgetText(harness.currentWidget()), " Worked for 1s.");
    await harness.invoke("session_tree");
    assert.equal(renderedWidgetText(harness.currentWidget()), " Worked for 1s.");
    const prototype = parseLoaderPrototypeOwner(Loader.prototype);
    if (prototype === undefined) {
        throw new Error("Expected patched Loader.updateDisplay");
    }

    const statusUpdateDisplay = prototype.updateDisplay;
    const laterUpdateDisplay = function laterUpdateDisplay(this: Loader): void {
        statusUpdateDisplay.call(this);
    };
    prototype.updateDisplay = laterUpdateDisplay;

    await harness.invoke("session_shutdown");
    assert.equal(harness.currentWidget(), undefined);
    assert.equal(prototype.updateDisplay, laterUpdateDisplay);
    const ui = new RenderCountingTui();
    const concurrentLoader = new Loader(
        ui,
        (text) => text,
        (text) => text,
        "Working...",
        {
            frames: ["⠙"],
        },
    );
    assert.deepEqual(
        concurrentLoader.render(80).map((line) => line.trimEnd()),
        ["", " ⠙ Working... (0s)"],
    );

    vi.advanceTimersByTime(1_100);
    assert.deepEqual(
        concurrentLoader.render(80).map((line) => line.trimEnd()),
        ["", " ⠙ Working... (1s)"],
    );

    concurrentLoader.stop();

    await concurrentHarness.invoke("session_shutdown");
    assert.equal(prototype.updateDisplay, laterUpdateDisplay);

    const unpatchedLoader = new Loader(
        ui,
        (text) => text,
        (text) => text,
        "Working...",
        { frames: ["⠙"] },
    );
    assert.deepEqual(
        unpatchedLoader.render(80).map((line) => line.trimEnd()),
        ["", " ⠙ Working..."],
    );

    unpatchedLoader.stop();
    assert.ok(ui.renderRequests >= 3);
    vi.useRealTimers();
});
