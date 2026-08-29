import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
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

    const result = await fetchCodexUsage(makeUsageContext("https://proxy.example/backend-api"), {
        runtime,
    });

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
                "chatgpt-account-id": "usage-account",
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
