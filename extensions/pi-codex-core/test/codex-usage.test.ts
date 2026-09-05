import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    consumeCodexRateLimitResetCredit,
    fetchCodexUsage,
    formatCodexUsage,
    parseCodexRateLimitResetCreditsPayload,
    parseCodexUsagePayload,
} from "../src/codex/usage.ts";
import { makeTestRuntime, testDouble } from "./helpers.ts";

const FIXED_NOW_MS = 1_700_000_000_000;
const FIXED_CLOCK = {
    nowMs: () => FIXED_NOW_MS,
    nowDate: () => new Date(FIXED_NOW_MS),
};

test("formats codex usage payloads", () => {
    const resetBase = Math.floor(FIXED_NOW_MS / 1000);
    const snapshot = parseCodexUsagePayload({
        plan_type: "pro",
        rate_limit_reset_credits: { available_count: 2 },
        rate_limit: {
            primary_window: {
                used_percent: 25,
                limit_window_seconds: 18_000,
                resets_at: resetBase + 10_800,
            },
            secondary_window: {
                used_percent: 1,
                window_minutes: 10_080,
                resets_at: resetBase + 604_800,
            },
        },
        additional_rate_limits: [
            {
                metered_feature: "gpt-5.3-codex-spark",
                limit_name: "gpt-5.3-codex-spark",
                rate_limit: {
                    primary_window: {
                        used_percent: 0,
                        limit_window_seconds: 18_000,
                        resets_at: resetBase + 10_800,
                    },
                    secondary_window: {
                        used_percent: 0,
                        window_minutes: 10_080,
                        resets_at: resetBase + 604_800,
                    },
                },
            },
        ],
    });

    assert.equal(snapshot.planType, "pro");
    assert.equal(snapshot.resetCredits?.availableCount, 2);
    assert.equal(snapshot.limits.length, 2);
    const formatted = formatCodexUsage(snapshot, FIXED_CLOCK);
    const lines = formatted.split("\n");
    assert.equal(lines[0], "Codex usage (Pro):");
    assert.match(
        formatCodexUsage({ ...snapshot, planType: "plus" }, FIXED_CLOCK),
        /^Codex usage \(Plus\):/,
    );
    assert.match(lines[1] ?? "", /^- Codex: {15}5h: 75% left {2}\(/);
    assert.match(lines[2] ?? "", /^- GPT-5\.3-Codex-Spark: 5h: 100% left \(/);
    assert.equal(lines.at(-1), "- Resets available: 2");
    assert.doesNotMatch(formatted, /\b300m\b|\b10080m\b/);
});

test("formats Codex reset credit expiration metadata", () => {
    const explicitExpiration = new Date(FIXED_NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString();
    const grantedAt = new Date(FIXED_NOW_MS).toISOString();
    const credits = parseCodexRateLimitResetCreditsPayload({
        available_count: "2",
        credits: [
            {
                id: "RateLimitResetCredit_1",
                status: "available",
                granted_at: grantedAt,
                expires_at: explicitExpiration,
                redeem_started_at: null,
                redeemed_at: null,
            },
            {
                id: "RateLimitResetCredit_2",
                status: "available",
                granted_at: grantedAt,
                redeem_started_at: null,
                redeemed_at: null,
            },
            {
                id: "RateLimitResetCredit_3",
                status: "redeemed",
                granted_at: grantedAt,
                expires_at: new Date(FIXED_NOW_MS + 60_000).toISOString(),
                redeemed_at: new Date(FIXED_NOW_MS).toISOString(),
            },
        ],
    });

    assert.ok(credits);
    assert.equal(credits.credits.length, 3);
    const firstCredit = credits.credits[0];
    assert.ok(firstCredit);
    assert.equal(firstCredit.expiresAt, explicitExpiration);
    assert.equal(firstCredit.redeemStartedAt, undefined);
    const formatted = formatCodexUsage({ limits: [], resetCredits: credits, raw: {} }, FIXED_CLOCK);

    assert.match(
        formatted,
        /- Resets available: 2\n  - Reset 1: expires in ~5d \([^\n]+\)\n  - Reset 2: expires in ~30d \(/,
    );
    assert.doesNotMatch(formatted, /~1m/);
});

test("formats Codex reset credit expiration from granted time", () => {
    const grantedAt = new Date(FIXED_NOW_MS).toISOString();
    const credits = parseCodexRateLimitResetCreditsPayload({
        available_count: 1,
        credits: [
            {
                id: "RateLimitResetCredit_1",
                status: "available",
                granted_at: grantedAt,
                redeem_started_at: null,
                redeemed_at: null,
            },
        ],
    });

    assert.ok(credits);
    const formatted = formatCodexUsage({ limits: [], resetCredits: credits, raw: {} }, FIXED_CLOCK);

    assert.match(formatted, /- Resets available: 1\n  - Reset 1: expires in ~30d \(/);
});

test("fetches Codex usage from the selected provider base URL", async () => {
    const urls: string[] = [];
    const runtime = makeTestRuntime(async (input) => {
        urls.push(String(input));
        if (String(input).endsWith("/wham/usage")) {
            return new Response(
                JSON.stringify({ rate_limit_reset_credits: { available_count: 1 } }),
                { status: 200 },
            );
        }
        if (String(input).endsWith("/wham/rate-limit-reset-credits")) {
            return new Response(JSON.stringify({ available_count: 1, credits: [] }), {
                status: 200,
            });
        }
        return new Response("not found", { status: 404 });
    });

    const result = await fetchCodexUsage(
        makeUsageContext("https://proxy.example/backend-api", { accountId: "base-url-account" }),
        {
            runtime,
        },
    );

    assert.ok(result.isOk());
    assert.deepEqual(urls, [
        "https://proxy.example/backend-api/wham/usage",
        "https://proxy.example/backend-api/wham/rate-limit-reset-credits",
    ]);
});

test("preserves an explicitly selected account over the token claim", async () => {
    const accountIds: Array<string | null> = [];
    const runtime = makeTestRuntime(async (input, init) => {
        accountIds.push(new Headers(init?.headers).get("chatgpt-account-id"));
        if (String(input).endsWith("/wham/usage")) {
            return new Response(JSON.stringify({ rate_limit: {} }), { status: 200 });
        }
        return new Response(JSON.stringify({ available_count: 0, credits: [] }), {
            status: 200,
        });
    });
    const token = makeCodexJwtAccountToken("token-account");

    const result = await fetchCodexUsage(
        makeUsageContext("https://proxy.example/backend-api", {
            apiKey: token,
            accountId: "selected-account",
        }),
        { runtime },
    );

    assert.ok(result.isOk());
    assert.deepEqual(accountIds, ["selected-account", "selected-account"]);
});

test("omits provider headers explicitly cleared with null", async () => {
    const requestHeaders: Headers[] = [];
    const runtime = makeTestRuntime(async (input, init) => {
        requestHeaders.push(new Headers(init?.headers));
        if (String(input).endsWith("/wham/usage")) {
            return new Response(JSON.stringify({ rate_limit: {} }), { status: 200 });
        }
        return new Response(JSON.stringify({ available_count: 0, credits: [] }), {
            status: 200,
        });
    });

    const result = await fetchCodexUsage(
        makeUsageContext("https://proxy.example/backend-api", {
            modelHeaders: {
                "X-Model": "model-value",
                "X-Removed": "stale-value",
                "X-Null-Model": null,
            },
            providerHeaders: {
                "chatgpt-account-id": "cleared-header-account",
                "x-removed": null,
            },
        }),
        { runtime },
    );

    assert.ok(result.isOk());
    assert.equal(requestHeaders.length, 2);
    for (const headers of requestHeaders) {
        assert.equal(headers.get("x-model"), "model-value");
        assert.equal(headers.has("x-removed"), false);
        assert.equal(headers.has("x-null-model"), false);
    }
});

test("reuses settled credits for a shared account until request-start expiry", async () => {
    let now = FIXED_NOW_MS;
    let creditRequests = 0;
    const runtime = {
        ...makeTestRuntime(async (input) => {
            if (String(input).endsWith("/wham/usage")) return Response.json({ rate_limit: {} });
            creditRequests += 1;
            return Response.json({ available_count: creditRequests, credits: [] });
        }),
        clock: { nowMs: () => now, nowDate: () => new Date(now) },
    };
    const ctx = makeUsageContext("https://cache.example/backend-api", {
        accountId: "shared-cache",
    });
    const first = await fetchCodexUsage(ctx, { runtime });
    now += 4_999;
    const cached = await fetchCodexUsage(ctx, { runtime });
    assert.ok(first.isOk() && cached.isOk());
    assert.equal(first.value.resetCredits?.availableCount, 1);
    assert.equal(cached.value.resetCredits?.availableCount, 1);
    assert.equal(creditRequests, 1);
    now += 1;
    const expired = await fetchCodexUsage(ctx, { runtime });
    assert.ok(expired.isOk());
    assert.equal(expired.value.resetCredits?.availableCount, 2);
    assert.equal(creditRequests, 2);
});

test("credit cache separates accounts and URLs and retains only one slot", async () => {
    let requests = 0;
    const runtime = makeTestRuntime(async (input) => {
        if (String(input).endsWith("/usage")) return Response.json({});
        requests += 1;
        return Response.json({ available_count: requests, credits: [] });
    });
    for (const [url, accountId] of [
        ["https://separation-a.example", "a"],
        ["https://separation-a.example", "b"],
        ["https://separation-b.example", "b"],
        ["https://separation-a.example", "a"],
    ] as const) {
        const result = await fetchCodexUsage(makeUsageContext(url, { accountId }), { runtime });
        assert.ok(result.isOk());
        assert.equal(result.value.resetCredits?.availableCount, requests);
    }
    assert.equal(requests, 4);
});

test("failed enrichment remains optional and does not poison the credit cache", async () => {
    let requests = 0;
    const runtime = makeTestRuntime(async (input) => {
        if (String(input).endsWith("/usage")) return Response.json({ plan_type: "pro" });
        requests += 1;
        if (requests === 1) return new Response("unavailable", { status: 503 });
        return Response.json({ available_count: 3, credits: [] });
    });
    const ctx = makeUsageContext("https://failed-enrichment.example", { accountId: "failure" });
    const first = await fetchCodexUsage(ctx, { runtime });
    assert.ok(first.isOk());
    assert.equal(first.value.planType, "pro");
    assert.equal(first.value.resetCredits, undefined);
    const second = await fetchCodexUsage(ctx, { runtime });
    assert.ok(second.isOk());
    assert.equal(second.value.resetCredits?.availableCount, 3);
    assert.equal(requests, 2);
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

for (const abortedCaller of [0, 1]) {
    test(`overlapping credit requests keep caller ${abortedCaller} cancellation independent`, async () => {
        const controllers = [new AbortController(), new AbortController()];
        const started = [deferred<void>(), deferred<void>()];
        const responses = [deferred<Response>(), deferred<Response>()];
        const requests: Array<AbortSignal | null | undefined> = [];
        const ctx = makeUsageContext(`https://overlap-${abortedCaller}.example`, {
            accountId: "overlap",
        });
        const results = controllers.map((controller, index) =>
            fetchCodexUsage(ctx, {
                signal: controller.signal,
                runtime: makeTestRuntime(async (input, init) => {
                    if (String(input).endsWith("/usage")) return Response.json({ rate_limit: {} });
                    requests.push(init?.signal);
                    const response = responses[index];
                    assert.ok(response);
                    init?.signal?.addEventListener(
                        "abort",
                        () => response.reject(init.signal?.reason),
                        { once: true },
                    );
                    started[index]?.resolve();
                    return response.promise;
                }),
            }),
        );
        await Promise.all(started.map((item) => item.promise));
        assert.equal(requests.length, 2);
        assert.notEqual(requests[0], requests[1]);
        controllers[abortedCaller]?.abort();
        const survivingCaller = 1 - abortedCaller;
        responses[survivingCaller]?.resolve(Response.json({ available_count: 7, credits: [] }));
        const settled = await Promise.all(results);
        const cancelled = settled[abortedCaller];
        const surviving = settled[survivingCaller];
        assert.ok(cancelled?.isOk() && surviving?.isOk());
        assert.equal(cancelled.value.resetCredits, undefined);
        assert.equal(surviving.value.resetCredits?.availableCount, 7);
    });
}

for (const settleAfterExpiry of [false, true]) {
    test(`credit TTL starts before settlement (settles after expiry: ${settleAfterExpiry})`, async () => {
        let now = FIXED_NOW_MS;
        let requests = 0;
        const started = deferred<void>();
        const response = deferred<Response>();
        const runtime = {
            ...makeTestRuntime(async (input) => {
                if (String(input).endsWith("/usage")) return Response.json({});
                requests += 1;
                if (requests === 1) {
                    started.resolve();
                    return response.promise;
                }
                return Response.json({ available_count: 2, credits: [] });
            }),
            clock: { nowMs: () => now, nowDate: () => new Date(now) },
        };
        const ctx = makeUsageContext(`https://slow-${settleAfterExpiry}.example`, {
            accountId: "slow",
        });
        const pending = fetchCodexUsage(ctx, { runtime });
        await started.promise;
        now += settleAfterExpiry ? 5_001 : 4_000;
        response.resolve(Response.json({ available_count: 1, credits: [] }));
        assert.ok((await pending).isOk());
        now = FIXED_NOW_MS + 5_001;
        const refreshed = await fetchCodexUsage(ctx, { runtime });
        assert.ok(refreshed.isOk());
        assert.equal(refreshed.value.resetCredits?.availableCount, 2);
        assert.equal(requests, 2);
    });
}

for (const readDuringConsumption of [false, true]) {
    test(`consumption invalidates pending reads (read during POST: ${readDuringConsumption})`, async () => {
        let requests = 0;
        const readStarted = deferred<void>();
        const postStarted = deferred<void>();
        const readResponse = deferred<Response>();
        const postResponse = deferred<Response>();
        const runtime = makeTestRuntime(async (input, init) => {
            if (init?.method === "POST") {
                postStarted.resolve();
                return postResponse.promise;
            }
            if (String(input).endsWith("/usage")) return Response.json({});
            requests += 1;
            if (requests === 1) {
                readStarted.resolve();
                return readResponse.promise;
            }
            return Response.json({ available_count: 0, credits: [] });
        });
        const ctx = makeUsageContext(`https://invalidate-${readDuringConsumption}.example`, {
            accountId: "invalidate",
        });
        const consume = readDuringConsumption
            ? consumeCodexRateLimitResetCredit(ctx, "stable-redemption", { runtime })
            : undefined;
        if (consume) await postStarted.promise;
        const pending = fetchCodexUsage(ctx, { runtime });
        await readStarted.promise;
        const consumption =
            consume ?? consumeCodexRateLimitResetCredit(ctx, "stable-redemption", { runtime });
        await postStarted.promise;
        postResponse.resolve(Response.json({ code: "reset" }));
        assert.ok((await consumption).isOk());
        readResponse.resolve(Response.json({ available_count: 9, credits: [] }));
        assert.ok((await pending).isOk());
        const refreshed = await fetchCodexUsage(ctx, { runtime });
        assert.ok(refreshed.isOk());
        assert.equal(refreshed.value.resetCredits?.availableCount, 0);
        assert.equal(requests, 2);
    });
}

function makeUsageContext(
    modelBaseUrl: string,
    auth: {
        readonly apiKey?: string;
        readonly accountId?: string;
        readonly modelHeaders?: ProviderHeaders;
        readonly providerHeaders?: ProviderHeaders;
    } = {},
): ExtensionContext {
    const ctx = {
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.5",
            baseUrl: modelBaseUrl,
            headers: auth.modelHeaders ?? {},
        },
        modelRegistry: {
            getApiKeyAndHeaders: async () => ({
                ok: true,
                apiKey: auth.apiKey ?? "usage-token",
                headers: auth.providerHeaders ?? {
                    "chatgpt-account-id": auth.accountId ?? "usage-account",
                },
            }),
        },
    };
    return testDouble<ExtensionContext>()(ctx);
}

function makeCodexJwtAccountToken(accountId: string): string {
    const payload = Buffer.from(
        JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: accountId },
        }),
    ).toString("base64url");
    return `header.${payload}.signature`;
}
