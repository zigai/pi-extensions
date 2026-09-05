import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "vitest";
import { fetchTextWithRetries } from "../src/codex/http-retry.ts";
import { makeTestRuntime } from "./helpers.ts";

for (const failure of ["status", "network", "body"]) {
    test(`HTTP ${failure} retries use the runtime scheduler and four-attempt default`, async () => {
        const delays: number[] = [];
        let calls = 0;
        let cancellations = 0;
        const runtime = {
            ...makeTestRuntime(async () => {
                calls += 1;
                if (calls === 4) return new Response("complete");
                if (failure === "network") throw new Error("offline");
                if (failure === "body")
                    return new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.error(new Error("body interrupted"));
                            },
                        }),
                    );
                return new Response("busy", { status: 503 });
            }),
            scheduler: {
                set(delay: number, task: () => void) {
                    delays.push(delay);
                    task();
                    return {
                        cancel: () => {
                            cancellations += 1;
                        },
                    };
                },
            },
        };
        const result = await fetchTextWithRetries(runtime, "https://retry.example", {});
        assert.equal(result.text, "complete");
        assert.equal(calls, 4);
        assert.deepEqual(delays, [100, 200, 400]);
        assert.equal(cancellations, 3);
    });
}

test("HTTP abort during backoff cancels scheduled work without another fetch", async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const scheduled = new Promise<void>((resolve) => {
        ready = resolve;
    });
    let fire!: () => void;
    let cancellations = 0;
    let calls = 0;
    const runtime = {
        ...makeTestRuntime(async () => {
            calls += 1;
            return new Response("busy", { status: 429 });
        }),
        scheduler: {
            set(_delay: number, task: () => void) {
                fire = task;
                ready();
                return {
                    cancel: () => {
                        cancellations += 1;
                    },
                };
            },
        },
    };
    const result = fetchTextWithRetries(
        runtime,
        "https://retry.example",
        {},
        { signal: controller.signal },
    );
    await scheduled;
    const reason = new Error("cancel HTTP");
    controller.abort(reason);
    await assert.rejects(result, (cause: unknown) => cause === reason);
    fire();
    assert.equal(calls, 1);
    assert.equal(cancellations, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const attempts of [0, -1, Number.NaN]) {
    test(`zero-iteration HTTP attempt count ${attempts} retains exhaustion error`, async () => {
        await assert.rejects(
            fetchTextWithRetries(makeTestRuntime(), "https://retry.example", {}, { attempts }),
            { message: "Codex request retry limit exhausted." },
        );
    });
}

test("terminal HTTP failure preserves its Error and nonretryable responses return their body", async () => {
    const reason = new Error("last failure");
    await assert.rejects(
        fetchTextWithRetries(
            makeTestRuntime(async () => {
                throw reason;
            }),
            "https://retry.example",
            {},
            { attempts: 1 },
        ),
        (cause: unknown) => cause === reason,
    );
    const result = await fetchTextWithRetries(
        makeTestRuntime(async () => new Response("invalid", { status: 400 })),
        "https://retry.example",
        {},
    );
    assert.equal(result.response.status, 400);
    assert.equal(result.text, "invalid");
});
