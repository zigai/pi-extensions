import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { codexToolProviderHeaders, resolveCodexToolProvider } from "../src/codex/auth.ts";
import { Redacted } from "../src/codex/redacted.ts";

test("Codex tool auth requires account ids and omits empty account headers", async () => {
    const headers = codexToolProviderHeaders({
        baseUrl: "https://chatgpt.com/backend-api/codex",
        model: "gpt-5.5",
        token: Redacted.of("token"),
        accountId: "",
    });
    assert.equal(headers.has("ChatGPT-Account-ID"), false);

    const result = await resolveCodexToolProvider(makeToolAuthContext({ apiKey: "token" }));

    assert.ok(result.isErr());
    assert.match(result.error.message, /account id is unavailable/);
});

test("Codex web auth supports API keys and preserves provider headers", async () => {
    const result = await resolveCodexToolProvider(
        makeToolAuthContext({
            apiKey: "token",
            headers: { "OpenAI-Organization": "org_test", "X-Custom-Auth": "custom" },
        }),
        { requireAccountId: false },
    );

    assert.ok(result.isOk());
    const headers = codexToolProviderHeaders(result.value);
    assert.equal(headers.get("OpenAI-Organization"), "org_test");
    assert.equal(headers.get("X-Custom-Auth"), "custom");
    assert.equal(headers.get("Authorization"), "Bearer token");
    assert.equal(headers.get("version"), "0.1.0");
    assert.match(headers.get("User-Agent") ?? "", /^codex_cli_rs\/0\.1\.0 /);
});

test("Codex tool auth preserves header-only provider credentials", async () => {
    const result = await resolveCodexToolProvider(
        makeToolAuthContext({ headers: { "X-API-Key": "actor-token" } }),
        { requireAccountId: false, useActiveModel: true },
    );

    assert.ok(result.isOk());
    const headers = codexToolProviderHeaders(result.value);
    assert.equal(headers.get("X-API-Key"), "actor-token");
    assert.equal(headers.has("Authorization"), false);
});

function makeToolAuthContext(auth: {
    readonly apiKey?: string | undefined;
    readonly headers?: Record<string, string> | undefined;
}): ExtensionContext {
    const ctx = {
        cwd: "/workspace",
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.5",
            baseUrl: "https://chatgpt.com/backend-api",
        },
        modelRegistry: {
            getApiKeyAndHeaders: async () => ({
                ok: true,
                apiKey: auth.apiKey,
                headers: auth.headers ?? {},
            }),
        },
    };
    // SAFETY: This test context supplies only the model registry fields read by Codex auth.
    return ctx as unknown as ExtensionContext;
}
