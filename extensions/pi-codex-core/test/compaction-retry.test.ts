import assert from "node:assert/strict";
import { test } from "vitest";
import { executeRemoteCompactionV2 } from "../src/compaction/remote-client.ts";
import type { JsonObject, RemoteCompactionV2Request } from "../src/compaction/types.ts";
import type { ScheduledTask } from "../src/runtime.ts";
import { makeTestRuntime } from "./helpers.ts";

const request: RemoteCompactionV2Request = {
    model: "gpt-5.4",
    input: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: [],
    prompt_cache_key: "retry-session",
    text: { verbosity: "medium" },
};

function event(name: string, payload: JsonObject): string {
    return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function failure(error: JsonObject): string {
    return event("response.failed", { response: { error } });
}

const success =
    event("response.output_item.done", {
        item: { type: "compaction", encrypted_content: "fresh-checkpoint" },
    }) + event("response.completed", { response: { id: "completed" } });

function runScenario(
    streams: readonly string[],
    onDelay?: (delayMs: number, task: () => void) => ScheduledTask,
) {
    const controller = new AbortController();
    const delays: number[] = [];
    const signals: AbortSignal[] = [];
    const bodies: (BodyInit | null | undefined)[] = [];
    let calls = 0;
    const services = makeTestRuntime(async (_url, init) => {
        if (init?.signal) signals.push(init.signal);
        bodies.push(init?.body);
        const stream = streams[Math.min(calls, streams.length - 1)];
        calls += 1;
        assert.ok(stream);
        return new Response(stream);
    });
    const result = executeRemoteCompactionV2(
        { responsesUrl: "https://example.test/responses", headers: new Headers() },
        request,
        {
            signal: controller.signal,
            services: {
                ...services,
                scheduler: {
                    set(delayMs, task) {
                        if (delayMs === 300_000) return { cancel() {} };
                        delays.push(delayMs);
                        if (onDelay) return onDelay(delayMs, task);
                        return services.scheduler.set(delayMs, task);
                    },
                },
            },
        },
    );
    return { controller, delays, signals, bodies, result, calls: () => calls };
}

for (const [message, expectedDelay] of [
    ["Please try again in 11.054s.", 11054],
    ["TRY AGAIN IN 28ms.", 28],
    ["Try again in 35 seconds.", 35000],
    ["Try again in 0s.", 0],
    ["Temporary limit.", 200],
    ["Try again in 99999999999999s.", 200],
] as const) {
    test(`stream rate limit preserves safe delay: ${message}`, async () => {
        const scenario = runScenario([
            event("response.output_item.done", {
                item: { type: "compaction", encrypted_content: "discard-checkpoint" },
            }) + failure({ code: "rate_limit_exceeded", message }),
            success,
        ]);
        const result = await scenario.result;
        assert.ok(result.isOk());
        assert.equal(result.value.compactionOutput.encrypted_content, "fresh-checkpoint");
        assert.deepEqual(scenario.delays, [expectedDelay]);
        assert.equal(scenario.calls(), 2);
        assert.equal(scenario.signals[0]?.aborted, true);
        assert.notEqual(scenario.signals[0], scenario.signals[1]);
        assert.equal(scenario.bodies[0], scenario.bodies[1]);
    });
}

for (const code of ["server_is_overloaded", "slow_down", "server_error", "unknown_error"]) {
    test(`stream retry classification uses code rather than rate-limit wording: ${code}`, async () => {
        const scenario = runScenario([
            failure({ code, message: "Rate limit reached. Please try again in 11s." }),
            success,
        ]);
        assert.ok((await scenario.result).isOk());
        assert.deepEqual(scenario.delays, [200]);
    });
}

test("stream retries exhaust after two retries and preserve the last failure", async () => {
    const scenario = runScenario([failure({ code: "rate_limit_exceeded", message: "Busy" })]);
    const result = await scenario.result;
    assert.ok(result.isErr());
    assert.equal(result.error._tag, "CodexStreamRetryable");
    if (result.error._tag === "CodexStreamRetryable") {
        assert.equal(result.error.code, "rate_limit_exceeded");
        assert.equal(result.error.retryAfterMs, undefined);
    }
    assert.equal(result.error.message, "response.failed: Busy");
    assert.equal(scenario.calls(), 3);
    assert.deepEqual(scenario.delays, [200, 400]);
});

test("aborting a server-directed retry delay cancels the task and prevents another request", async () => {
    let scheduled!: () => void;
    let cancelled = false;
    let notifyScheduled!: () => void;
    const ready = new Promise<void>((resolve) => {
        notifyScheduled = resolve;
    });
    const scenario = runScenario(
        [failure({ code: "rate_limit_exceeded", message: "Try again in 30s." }), success],
        (_delayMs, task) => {
            scheduled = task;
            notifyScheduled();
            return {
                cancel: () => {
                    cancelled = true;
                },
            };
        },
    );
    await ready;
    scenario.controller.abort(new Error("stop compaction"));
    const result = await scenario.result;
    assert.ok(result.isErr());
    assert.equal(result.error._tag, "CodexRequestCancelled");
    assert.equal(cancelled, true);
    scheduled();
    assert.equal(scenario.calls(), 1);
    assert.deepEqual(scenario.delays, [30000]);
});

for (const code of [
    "context_length_exceeded",
    "insufficient_quota",
    "usage_not_included",
    "cyber_policy",
    "misalignment_policy_violation",
    "invalid_prompt",
    "bio_policy",
    "invalid_request",
    "invalid_request_error",
    "invalid_argument",
    "invalid_input",
    "content_policy_violation",
]) {
    test(`fatal stream code never retries despite misleading message: ${code}`, async () => {
        const scenario = runScenario([
            failure({ code, message: "Rate limit reached. Try again in 1s." }),
            success,
        ]);
        const result = await scenario.result;
        assert.ok(result.isErr());
        assert.equal(result.error._tag, "CodexUnexpectedResponse");
        assert.equal(scenario.calls(), 1);
        assert.deepEqual(scenario.delays, []);
    });
}

test("invalid-request error type is fatal even with an unfamiliar code", async () => {
    const scenario = runScenario([
        failure({
            code: "unsupported_value",
            type: "invalid_request_error",
            message: "Try again in 1s.",
        }),
        success,
    ]);
    assert.ok((await scenario.result).isErr());
    assert.equal(scenario.calls(), 1);
    assert.deepEqual(scenario.delays, []);
});

test("incomplete policy output is not retried as a transient stream failure", async () => {
    const scenario = runScenario([
        event("response.incomplete", {
            response: { incomplete_details: { reason: "content_filter" } },
        }),
        success,
    ]);
    assert.ok((await scenario.result).isErr());
    assert.equal(scenario.calls(), 1);
    assert.deepEqual(scenario.delays, []);
});

test("an already cancelled compaction never starts a network request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel before start"));
    const result = await executeRemoteCompactionV2(
        { responsesUrl: "https://example.test/responses", headers: new Headers() },
        request,
        { signal: controller.signal, services: makeTestRuntime() },
    );
    assert.ok(result.isErr());
    assert.equal(result.error._tag, "CodexRequestCancelled");
});

test("invalid JSON in a failure event remains a nonretryable parse failure", async () => {
    const scenario = runScenario(["event: response.failed\ndata: {\n\n", success]);
    const result = await scenario.result;
    assert.ok(result.isErr());
    assert.equal(result.error._tag, "CodexInvalidJson");
    assert.equal(scenario.calls(), 1);
    assert.deepEqual(scenario.delays, []);
});

test("invalid-request type prevents retries even when the code says rate limit", async () => {
    const scenario = runScenario([
        failure({
            code: "rate_limit_exceeded",
            type: "invalid_request_error",
            message: "Try again in 1s.",
        }),
        success,
    ]);
    const result = await scenario.result;
    assert.ok(result.isErr());
    assert.equal(result.error._tag, "CodexUnexpectedResponse");
    assert.equal(scenario.calls(), 1);
    assert.deepEqual(scenario.delays, []);
});
