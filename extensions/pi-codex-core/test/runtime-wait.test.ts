import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "vitest";
import { waitWithScheduler, type Scheduler } from "../src/runtime.ts";

for (const abort of [false, true]) {
    test(`scheduled wait cleans timer and listener on ${abort ? "abort" : "completion"}`, async () => {
        const controller = new AbortController();
        let fire!: () => void;
        let cancellations = 0;
        const scheduler: Scheduler = {
            set(delay, task) {
                assert.equal(delay, 123);
                fire = task;
                return {
                    cancel: () => {
                        cancellations += 1;
                    },
                };
            },
        };
        const wait = waitWithScheduler(scheduler, 123, { signal: controller.signal });
        assert.equal(getEventListeners(controller.signal, "abort").length, 1);
        const reason = new Error("stop waiting");
        if (abort) {
            controller.abort(reason);
            await assert.rejects(wait, (cause: unknown) => cause === reason);
        } else {
            fire();
            await wait;
        }
        assert.equal(cancellations, 1);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        fire();
        controller.abort();
        assert.equal(cancellations, 1);
    });
}

test("synchronously firing schedulers still dispose their returned task", async () => {
    const controller = new AbortController();
    let cancellations = 0;
    await waitWithScheduler(
        {
            set(_delay, task) {
                task();
                return {
                    cancel: () => {
                        cancellations += 1;
                    },
                };
            },
        },
        0,
        { signal: controller.signal },
    );
    assert.equal(cancellations, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("scheduler failure removes the abort listener", async () => {
    const controller = new AbortController();
    const reason = new Error("scheduler unavailable");
    await assert.rejects(
        waitWithScheduler(
            {
                set() {
                    throw reason;
                },
            },
            1,
            { signal: controller.signal },
        ),
        (cause: unknown) => cause === reason,
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("pre-aborted wait preserves caller reason without scheduling", async () => {
    const controller = new AbortController();
    const reason = new Error("already stopped");
    controller.abort(reason);
    await assert.rejects(
        waitWithScheduler(
            {
                set() {
                    throw new Error("must not schedule");
                },
            },
            1,
            { signal: controller.signal },
        ),
        (cause: unknown) => cause === reason,
    );
});

test("HTTP pre-abort policy retains an undefined reason", async () => {
    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;
    Object.defineProperty(signal, "reason", { value: undefined });
    const scheduler: Scheduler = {
        set() {
            throw new Error("must not schedule");
        },
    };
    const outcome = await waitWithScheduler(scheduler, 1, {
        signal,
        preservePreAbortReason: true,
    }).then(
        () => ({ rejected: false, cause: undefined }),
        (cause: unknown) => ({ rejected: true, cause }),
    );
    assert.deepEqual(outcome, { rejected: true, cause: undefined });
    await assert.rejects(waitWithScheduler(scheduler, 1, { signal }), { name: "AbortError" });
});
