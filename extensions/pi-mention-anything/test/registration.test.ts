import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { setImmediate as nextTurn } from "node:timers/promises";

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import { createListProvider } from "../src/list-provider.ts";
import {
    registerMention,
    registerMentionSources,
    type MentionExtensionApi,
} from "../src/register-mention.ts";

type HostEvent = {
    readonly type?: string;
    messages?: ContextEvent["messages"];
};

type HostContext = {
    readonly cwd: string;
    readonly hasUI: false;
    readonly ui: { notify(message: string): void };
    isProjectTrusted(): boolean;
};

type HostHandlerResult = void | { readonly messages: ContextEvent["messages"] };

type HostHandler = (
    event: HostEvent,
    ctx: HostContext,
) => HostHandlerResult | Promise<HostHandlerResult>;

type Host = {
    readonly pi: MentionExtensionApi;
    emit(this: void, event: string, payload: HostEvent): Promise<HostEvent>;
};

function isHostHandler(value: unknown): value is HostHandler {
    return typeof value === "function";
}

function isContextResult(value: unknown): value is { readonly messages: ContextEvent["messages"] } {
    return (
        value !== null &&
        typeof value === "object" &&
        "messages" in value &&
        Array.isArray(value.messages)
    );
}

function host(ui?: HostContext["ui"]): Host {
    const handlers = new Map<string, unknown[]>();
    const pi: MentionExtensionApi = {
        on(event, handler) {
            const entries = handlers.get(event) ?? [];
            entries.push(handler);
            handlers.set(event, entries);

            return () => {};
        },
    };
    const ctx: HostContext = {
        cwd: process.cwd(),
        hasUI: false,
        isProjectTrusted: () => true,
        ui: ui ?? { notify() {} },
    };

    return {
        pi,
        async emit(event, initialPayload) {
            let payload = initialPayload;

            for (const handler of handlers.get(event) ?? []) {
                if (!isHostHandler(handler)) throw new Error("Missing host event handler.");

                const result = await handler(payload, ctx);
                if (event === "context" && isContextResult(result)) {
                    payload = { messages: result.messages };
                }
            }

            return payload;
        },
    };
}

test("session shutdown awaits asynchronous provider cleanup exactly once", async () => {
    const app = host();
    let release = (): void => {};
    const cleanup = new Promise<void>((resolve) => {
        release = resolve;
    });
    let calls = 0;
    registerMention(app.pi, {
        id: "resource",
        configuration: () => ({ trigger: "r:" }),
        provider: () => ({
            ...createListProvider(async () => []),
            async dispose() {
                calls += 1;
                return cleanup;
            },
        }),
    });
    await app.emit("session_start", { type: "session_start" });
    let finished = false;
    const shutdown = app.emit("session_shutdown", { type: "session_shutdown" }).then(() => {
        finished = true;
    });
    await nextTurn();
    assert.equal(calls, 1);
    assert.equal(finished, false);
    release();
    await shutdown;
    await app.emit("session_shutdown", { type: "session_shutdown" });
    assert.equal(calls, 1);
});

test("registrations share longest-trigger ownership and do not recursively expand generated context", async () => {
    const app = host();
    let factories = 0;
    let discovery = 0;
    const register = (id: string, trigger: string, segment: string, replacement: string): void => {
        registerMention(app.pi, {
            id,
            configuration: () => ({ trigger }),
            provider: () => {
                factories += 1;

                return createListProvider(async () => {
                    discovery += 1;
                    return [
                        {
                            id,
                            label: segment,
                            segment,
                            replacement,
                            selectable: true,
                            navigable: false,
                        },
                    ];
                });
            },
        });
    };
    register("short", "x:", "target", "short target");
    register("long", "x::", "target", "x:target");
    assert.equal(factories, 0);
    await app.emit("session_start", { type: "session_start" });
    assert.equal(factories, 2);
    await app.emit("context", {
        messages: [{ role: "user", content: "ordinary prose", timestamp: 1 }],
    });
    assert.equal(discovery, 0);
    const event = await app.emit("context", {
        messages: [{ role: "user", content: "x::target x:target", timestamp: 2 }],
    });
    assert.deepEqual(event, {
        messages: [{ role: "user", content: "x:target short target", timestamp: 2 }],
    });
    await app.emit("session_shutdown", { type: "session_shutdown" });
});

test("duplicate source IDs and triggers are rejected at session registration", async () => {
    const app = host();
    for (const id of ["first", "second"]) {
        registerMention(app.pi, {
            id,
            configuration: () => ({ trigger: "same:" }),
            provider: () => createListProvider(async () => []),
        });
    }

    await assert.rejects(
        app.emit("session_start", { type: "session_start" }),
        /unique IDs and triggers/,
    );
    await app.emit("session_shutdown", { type: "session_shutdown" });
});

test.each([false, true])(
    "independent copies share expansion and reload lifecycle (default source: %s)",
    async (withDefault) => {
        const { pi, emit } = host();
        const registration = (
            id: string,
            trigger: string,
            segment: string,
            replacement: string,
        ) => ({
            id,
            configuration: () => ({ trigger }),
            provider: () =>
                createListProvider(async () => [
                    {
                        id,
                        label: id,
                        segment,
                        replacement,
                        selectable: true,
                        navigable: false,
                    },
                ]),
        });

        if (withDefault)
            registerMention(pi, registration("default", "base:", "item", "default expanded"));
        else registerMentionSources(pi, () => []);

        vi.resetModules();

        // Each load intentionally gets a fresh module instance, matching Pi's per-extension Jiti loaders.
        const treeCopy = await import("../src/register-mention.ts");
        assert.notEqual(treeCopy.registerMention, registerMention);
        treeCopy.registerMention(pi, registration("tree", "tree:", "src", "tree expanded"));
        vi.resetModules();
        const tmuxCopy = await import("../src/register-mention.ts");
        tmuxCopy.registerMention(pi, registration("tmux", "t:", "main", "tmux expanded"));

        await emit("session_start", { type: "session_start" });
        assert.deepEqual(
            await emit("context", {
                messages: [{ role: "user", content: "tree:src t:main", timestamp: 1 }],
            }),
            {
                messages: [{ role: "user", content: "tree expanded tmux expanded", timestamp: 1 }],
            },
        );

        await emit("session_shutdown", { type: "session_shutdown" });
        assert.deepEqual(
            await emit("context", {
                messages: [{ role: "user", content: "tree:src t:main", timestamp: 2 }],
            }),
            { messages: [{ role: "user", content: "tree:src t:main", timestamp: 2 }] },
        );
        await emit("session_start", { type: "session_start" });
        assert.deepEqual(
            await emit("context", {
                messages: [{ role: "user", content: "tree:src t:main", timestamp: 3 }],
            }),
            { messages: [{ role: "user", content: "tree expanded tmux expanded", timestamp: 3 }] },
        );
        await emit("session_shutdown", { type: "session_shutdown" });
    },
);

test("removing one owner preserves shared sources and permits replacement registration", async () => {
    const ui = { notify() {} };
    const first = host(ui);
    const second = host(ui);
    const disposed: string[] = [];

    for (const [app, id] of [
        [first, "first"],
        [second, "second"],
    ] as const) {
        registerMention(app.pi, {
            id,
            configuration: () => ({ trigger: `${id}:` }),
            provider: () => ({
                ...createListProvider(async () => [
                    {
                        id,
                        label: id,
                        segment: "item",
                        replacement: `${id} expanded`,
                        selectable: true,
                        navigable: false,
                    },
                ]),
                dispose() {
                    disposed.push(id);
                },
            }),
        });
        await app.emit("session_start", {});
    }

    await first.emit("session_shutdown", {});
    assert.deepEqual(disposed, ["first"]);
    assert.deepEqual(
        await second.emit("context", {
            messages: [{ role: "user", content: "first:item second:item", timestamp: 1 }],
        }),
        {
            messages: [{ role: "user", content: "first:item second expanded", timestamp: 1 }],
        },
    );
    await first.emit("session_start", {});
    assert.deepEqual(
        await first.emit("context", {
            messages: [{ role: "user", content: "first:item second:item", timestamp: 2 }],
        }),
        {
            messages: [{ role: "user", content: "first expanded second expanded", timestamp: 2 }],
        },
    );
    await first.emit("session_shutdown", {});
    await second.emit("session_shutdown", {});
    await first.emit("session_shutdown", {});
    assert.deepEqual(disposed, ["first", "first", "second"]);
});

test("session reset disposes the previous provider before recreating it", async () => {
    const app = host();
    const lifecycle: string[] = [];
    registerMention(app.pi, {
        id: "reset",
        configuration: () => ({ trigger: "r:" }),
        provider: () => {
            lifecycle.push("create");

            return {
                ...createListProvider(async () => []),
                dispose() {
                    lifecycle.push("dispose");
                },
            };
        },
    });
    await app.emit("session_start", {});
    await app.emit("session_start", {});
    assert.deepEqual(lifecycle, ["create", "dispose", "create"]);
    await app.emit("session_shutdown", {});
    assert.deepEqual(lifecycle, ["create", "dispose", "create", "dispose"]);
});
