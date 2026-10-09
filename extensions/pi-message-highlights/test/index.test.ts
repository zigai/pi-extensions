import { expect, test } from "vitest";
import { registerMessageHighlights, type MessageHighlightsApi } from "../src/index.ts";
import {
    MessageHighlightSettingsController,
    type MessageHighlightSettingsContext,
} from "../src/settings-controller.ts";
import { DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG } from "../src/settings.ts";
import type { MessageHighlightTargets } from "../src/message-highlight-patch.ts";

function deferredTargets() {
    let resolve!: (targets: MessageHighlightTargets | undefined) => void;
    const promise = new Promise<MessageHighlightTargets | undefined>((complete) => {
        resolve = complete;
    });

    return { promise, resolve };
}

function targets(): MessageHighlightTargets {
    return {
        assistantPrototype: { render: () => ["https://example.com"] },
        userPrototype: { render: () => ["https://example.com"] },
        editorPrototype: { render: () => [] },
    };
}

function harness(loadTargets: () => Promise<MessageHighlightTargets | undefined>) {
    const handlers = new Map<
        string,
        (
            event: { type: "session_start" | "session_shutdown" },
            ctx: MessageHighlightSettingsContext,
        ) => void | Promise<void>
    >();
    const notifications: string[] = [];
    let loads = 0;
    const settings = new MessageHighlightSettingsController(() => {
        loads += 1;
        return { config: DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG, errors: ["invalid settings"] };
    });
    const pi: MessageHighlightsApi = {
        on(
            event: string,
            handler: (
                event: { type: "session_start" | "session_shutdown" },
                ctx: MessageHighlightSettingsContext,
            ) => void | Promise<void>,
        ) {
            handlers.set(event, handler);
        },
    };
    const ctx: MessageHighlightSettingsContext = {
        cwd: "/test",
        hasUI: true,
        isProjectTrusted: () => false,
        ui: {
            notify(message: string) {
                notifications.push(message);
            },
        },
    };
    registerMessageHighlights(pi, settings, loadTargets);

    return {
        settings,
        ctx,
        notifications,
        loads: () => loads,
        async start() {
            await handlers.get("session_start")?.({ type: "session_start" }, ctx);
        },
        async shutdown() {
            await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
        },
    };
}

test("factory is inert; session activation loads once and shutdown restores rendering", async () => {
    const target = targets();
    const original = target.assistantPrototype.render;
    let imports = 0;
    const host = harness(async () => {
        imports += 1;
        return target;
    });
    expect(imports).toBe(0);
    expect(host.loads()).toBe(0);
    await host.start();
    expect(imports).toBe(1);
    expect(target.assistantPrototype.render(80)[0]).not.toBe("https://example.com");
    host.settings.apply(host.ctx);
    expect(host.loads()).toBe(1);
    expect(host.notifications).toHaveLength(1);
    await host.shutdown();
    await host.shutdown();
    expect(target.assistantPrototype.render).toBe(original);
    await host.start();
    expect(host.loads()).toBe(2);
    expect(host.notifications).toHaveLength(2);
    await host.shutdown();
});

test("reset rejects an older activation without disposing the new patch", async () => {
    const old = deferredTargets();
    const current = deferredTargets();
    const queue = [old, current];
    const host = harness(async () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("Unexpected target load");
        return next.promise;
    });
    const oldStart = host.start();
    const newStart = host.start();
    const target = targets();
    const original = target.userPrototype.render;
    current.resolve(target);
    await newStart;
    const installed = target.userPrototype.render;
    const staleTarget = targets();
    const staleAssistant = staleTarget.assistantPrototype.render;
    const staleUser = staleTarget.userPrototype.render;
    const staleEditor = staleTarget.editorPrototype.render;
    old.resolve(staleTarget);
    await oldStart;
    expect(staleTarget.assistantPrototype.render).toBe(staleAssistant);
    expect(staleTarget.userPrototype.render).toBe(staleUser);
    expect(staleTarget.editorPrototype.render).toBe(staleEditor);
    expect(installed).not.toBe(original);
    expect(target.userPrototype.render).toBe(installed);
    await host.shutdown();
    expect(target.userPrototype.render).toBe(original);
});

test("shutdown rejects pending activation and unavailable targets stay unpatched", async () => {
    const pending = deferredTargets();
    const host = harness(async () => pending.promise);
    const target = targets();
    const original = target.userPrototype.render;
    const start = host.start();
    await host.shutdown();
    pending.resolve(target);
    await start;
    expect(target.userPrototype.render).toBe(original);
    const unavailable = harness(async () => undefined);
    await unavailable.start();
    await unavailable.shutdown();
});

test("headless settings diagnostics are suppressed and cached until reset", async () => {
    const host = harness(async () => undefined);
    host.ctx.hasUI = false;
    host.settings.apply(host.ctx);
    host.settings.apply(host.ctx);
    expect(host.loads()).toBe(1);
    expect(host.notifications).toEqual([]);
    await host.shutdown();
});

test("reset disposes the active patch before a replacement load completes", async () => {
    const first = targets();
    const replacement = deferredTargets();
    let imports = 0;
    const host = harness(async () => {
        imports += 1;
        if (imports === 1) return first;
        return replacement.promise;
    });
    const original = first.assistantPrototype.render;
    await host.start();
    expect(first.assistantPrototype.render).not.toBe(original);
    const nextStart = host.start();
    expect(first.assistantPrototype.render).toBe(original);
    await host.shutdown();
    const next = targets();
    const nextOriginal = next.assistantPrototype.render;
    replacement.resolve(next);
    await nextStart;
    expect(next.assistantPrototype.render).toBe(nextOriginal);
});
