import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { installLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { test } from "vitest";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { OpenAICodexResponsesOptions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { fetchTextWithRetries } from "../src/codex/http-retry.ts";
import { installCodexRequestTierWrapper } from "../src/codex/request-tier.ts";
import { makeTestRuntime } from "./helpers.ts";
import { JsonObjectDecoder } from "../src/compaction/responses-input.ts";

test("Codex request-tier wrapper is idempotent, removable, and preserves a later stream owner", () => {
    const provider = openaiCodexProvider();

    const originalStream = Object.getOwnPropertyDescriptor(provider, "stream");
    const originalSimple = Object.getOwnPropertyDescriptor(provider, "streamSimple");
    const handle = installCodexRequestTierWrapper(provider);
    assert.ok(handle);
    assert.notDeepEqual(Object.getOwnPropertyDescriptor(provider, "stream"), originalStream);
    assert.notDeepEqual(Object.getOwnPropertyDescriptor(provider, "streamSimple"), originalSimple);
    const activeStream = Object.getOwnPropertyDescriptor(provider, "stream");
    const secondOwner = installCodexRequestTierWrapper(provider);
    assert.ok(secondOwner);
    assert.deepEqual(Object.getOwnPropertyDescriptor(provider, "stream"), activeStream);
    handle.dispose();
    handle.dispose();
    assert.deepEqual(Object.getOwnPropertyDescriptor(provider, "stream"), activeStream);
    secondOwner.dispose();
    assert.deepEqual(Object.getOwnPropertyDescriptor(provider, "stream"), originalStream);
    assert.deepEqual(Object.getOwnPropertyDescriptor(provider, "streamSimple"), originalSimple);
    const laterStream = provider.stream.bind(provider);
    const second = installCodexRequestTierWrapper(provider);
    assert.ok(second);
    provider.stream = laterStream;
    second.dispose();
    assert.equal(Object.getOwnPropertyDescriptor(provider, "stream")?.value, laterStream);
    assert.deepEqual(Object.getOwnPropertyDescriptor(provider, "streamSimple"), originalSimple);
});

test("Codex raw streams price concurrent requests by their final payload, without mutating caller options", async () => {
    const provider = openaiCodexProvider();
    const model = provider.getModels().find((candidate) => candidate.id === "gpt-5.5");
    assert.ok(model);
    const handle = installCodexRequestTierWrapper(provider);
    assert.ok(handle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const apiKey = `header.${Buffer.from(
        JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
        }),
    ).toString("base64url")}.signature`;
    const context = normalizeContext({
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
    });
    const fetchResponse = async () =>
        new Response(
            `data: ${JSON.stringify({
                type: "response.completed",
                response: {
                    status: "completed",
                    output: [],
                    service_tier: "default",
                    usage: { input_tokens: 1000, output_tokens: 100 },
                },
            })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
        );

    const costModel = {
        ...model,
        cost: { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000 },
    };
    const priorityOptions = {
        apiKey,
        transport: "sse" as const,
        fetch: fetchResponse,
        serviceTier: "flex" as const,
        onPayload: async (payload) => {
            entered();
            await gate;
            return { ...JsonObjectDecoder.Parse(payload), service_tier: "priority" };
        },
    } satisfies OpenAICodexResponsesOptions;
    const noTierOptions = {
        apiKey,
        transport: "sse" as const,
        fetch: fetchResponse,
        serviceTier: "priority" as const,
        onPayload: (payload) => {
            const request = JsonObjectDecoder.Parse(payload);
            Reflect.deleteProperty(request, "service_tier");
            return request;
        },
    } satisfies OpenAICodexResponsesOptions;
    try {
        const priority = provider.stream(costModel, context, priorityOptions).result();
        await ready;
        const regular = await provider.stream(costModel, context, noTierOptions).result();
        release();
        const prioritized = await priority;
        assert.equal(regular.stopReason, "stop", regular.errorMessage);
        assert.equal(prioritized.stopReason, "stop", prioritized.errorMessage);
        assert.deepEqual(regular.usage.cost, {
            input: 1,
            output: 0.1,
            cacheRead: 0,
            cacheWrite: 0,
            total: 1.1,
        });
        assert.deepEqual(prioritized.usage.cost, {
            input: 2.5,
            output: 0.25,
            cacheRead: 0,
            cacheWrite: 0,
            total: 2.75,
        });
        assert.equal(priorityOptions.serviceTier, "flex");
        assert.equal(noTierOptions.serviceTier, "priority");
    } finally {
        release();
        handle.dispose();
    }
});

test("Codex refuses requests when the SDK loses the payload hook receiver", async () => {
    const provider = openaiCodexProvider();
    const model = provider.getModels().find((candidate) => candidate.id === "gpt-5.5");
    assert.ok(model);
    const changedSdk = installLinkedMethodPatch(
        provider,
        "stream",
        (predecessor) =>
            function (requestModel, context, options) {
                const onPayload = options?.onPayload;

                return predecessor.call(this, requestModel, context, {
                    ...options,
                    onPayload: (payload, payloadModel) =>
                        onPayload?.call(undefined, payload, payloadModel),
                });
            },
    );
    const tier = installCodexRequestTierWrapper(provider);
    assert.ok(tier);
    let requests = 0;
    try {
        const result = await provider
            .stream(
                model,
                normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] }),
                {
                    apiKey: `header.${Buffer.from(
                        JSON.stringify({
                            "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
                        }),
                    ).toString("base64url")}.signature`,
                    transport: "sse",
                    fetch: async () => {
                        requests += 1;
                        throw new Error("Unexpected provider request");
                    },
                },
            )
            .result();
        assert.equal(result.stopReason, "error");
        assert.equal(
            result.errorMessage,
            "Codex SDK payload hook did not expose its request options.",
        );
        assert.equal(requests, 0);
    } finally {
        tier.dispose();
        changedSdk.dispose();
    }
});

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

test.each([
    ["7", 7000],
    ["0", 0],
    ["\t5\t", 5000],
    ["Tue, 14 Nov 2023 22:13:25 GMT", 5000],
    ["Wed, 21 Oct 2015 07:28:00 GMT", 0],
    ["-1", 100],
    ["1.5", 100],
    ["invalid", 100],
    ["9999999999999999999999999", 100],
])("HTTP Retry-After %j controls the retry delay", async (header, expectedDelay) => {
    const delays: number[] = [];
    let calls = 0;
    const runtime = {
        ...makeTestRuntime(async () => {
            calls += 1;
            if (calls === 2) return new Response("complete");
            return new Response("busy", { status: 503, headers: { "Retry-After": header } });
        }),
        scheduler: {
            set(delay: number, task: () => void) {
                delays.push(delay);
                task();

                return { cancel() {} };
            },
        },
    };

    const result = await fetchTextWithRetries(runtime, "https://retry.example", {});
    assert.equal(result.text, "complete");
    assert.equal(calls, 2);
    assert.deepEqual(delays, [expectedDelay]);
});

test.each([
    ["Tuesday, 14-Nov-23 22:13:25 GMT", 5000],
    ["Tue Nov 14 22:13:25 2023", 5000],
    ["Fri, 31 Nov 2023 22:13:25 GMT", 100],
])(
    "HTTP Retry-After date %j is validated in GMT rather than local time",
    async (header, expectedDelay) => {
        const previousTimeZone = process.env.TZ;
        process.env.TZ = "America/New_York";
        try {
            const delays: number[] = [];
            let calls = 0;
            const runtime = {
                ...makeTestRuntime(async () => {
                    calls += 1;
                    if (calls === 2) return new Response("complete");
                    return new Response("busy", {
                        status: 503,
                        headers: { "Retry-After": header },
                    });
                }),
                scheduler: {
                    set(delay: number, task: () => void) {
                        delays.push(delay);
                        task();

                        return { cancel() {} };
                    },
                },
            };

            assert.equal(
                (await fetchTextWithRetries(runtime, "https://retry.example", {})).text,
                "complete",
            );
            assert.deepEqual(delays, [expectedDelay]);
        } finally {
            if (previousTimeZone === undefined) delete process.env.TZ;
            else process.env.TZ = previousTimeZone;
        }
    },
);

test("HTTP Retry-After deadline starts before reading the response body", async () => {
    const delays: number[] = [];
    let now = 1_700_000_000_000;
    let calls = 0;
    const services = makeTestRuntime(async () => {
        calls += 1;
        if (calls === 2) return new Response("complete");

        const response = new Response("busy", { status: 429, headers: { "Retry-After": "5" } });
        const readText = response.text.bind(response);
        response.text = async () => {
            now += 2000;
            return readText();
        };

        return response;
    });
    const runtime = {
        ...services,
        clock: { ...services.clock, nowMs: () => now },
        scheduler: {
            set(delay: number, task: () => void) {
                delays.push(delay);
                task();

                return { cancel() {} };
            },
        },
    };

    const result = await fetchTextWithRetries(runtime, "https://retry.example", {});
    assert.equal(result.text, "complete");
    assert.deepEqual(delays, [3000]);
});

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
