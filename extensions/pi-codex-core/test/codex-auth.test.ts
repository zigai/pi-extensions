import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import {
    ModelRegistry,
    ModelRuntime,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    codexToolProviderHeaders,
    resolveActiveCodexResponsesProvider,
    resolveCodexToolProvider,
} from "../src/codex/auth.ts";
import { CodexAuthUnavailable } from "../src/codex/failures.ts";
import { enabledCodexToolNames } from "../src/activation.ts";
import { DEFAULT_CODEX_CORE_CONFIG } from "../src/config/config.ts";
import { Redacted } from "../src/codex/redacted.ts";
import { testDouble } from "./helpers.ts";

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
            headers: {
                "OpenAI-Organization": "org_test",
                "X-Custom-Auth": "custom",
                version: "stale-provider-version",
            },
        }),
        { requireAccountId: false },
    );

    assert.ok(result.isOk());
    assert.equal(
        JSON.stringify(result.value.redactedHeaders),
        '{"OpenAI-Organization":"[redacted]","X-Custom-Auth":"[redacted]","version":"[redacted]"}',
    );
    const headers = codexToolProviderHeaders(result.value);
    assert.equal(headers.get("OpenAI-Organization"), "org_test");
    assert.equal(headers.get("X-Custom-Auth"), "custom");
    assert.equal(headers.get("Authorization"), "Bearer token");
    assert.equal(headers.has("version"), false);
    assert.match(headers.get("User-Agent") ?? "", /^codex_cli_rs\/0\.1\.0 /);
});

test("Codex tool auth preserves header-only provider credentials", async () => {
    const result = await resolveCodexToolProvider(
        makeToolAuthContext({ headers: { "X-API-Key": "actor-token", "X-Removed": null } }),
        { requireAccountId: false, useActiveModel: true },
    );

    assert.ok(result.isOk());
    assert.equal(JSON.stringify(result.value.redactedHeaders), '{"X-API-Key":"[redacted]"}');
    const headers = codexToolProviderHeaders(result.value);
    assert.equal(headers.get("X-API-Key"), "actor-token");
    assert.equal(headers.has("X-Removed"), false);
    assert.equal(headers.has("Authorization"), false);
});

test("Codex tool auth does not treat null credential headers as credentials", async () => {
    const result = await resolveCodexToolProvider(
        makeToolAuthContext({ headers: { Authorization: null, "X-API-Key": null } }),
        { requireAccountId: false, useActiveModel: true },
    );

    assert.ok(result.isErr());
    assert.match(result.error.message, /Codex-compatible token/);
});

test("Codex tool auth redacts and forwards authorization credentials", async () => {
    const result = await resolveCodexToolProvider(
        makeToolAuthContext({
            headers: {
                Authorization: "Basic credential",
                "OpenAI-Organization": "org_test",
            },
        }),
        { requireAccountId: false, useActiveModel: true },
    );

    assert.ok(result.isOk());
    assert.equal(
        JSON.stringify(result.value.redactedHeaders),
        '{"Authorization":"[redacted]","OpenAI-Organization":"[redacted]"}',
    );
    const headers = codexToolProviderHeaders(result.value);
    assert.equal(headers.get("Authorization"), "Basic credential");
});

test("new OpenAI login does not authorize legacy Codex tools or native compaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-core-legacy-auth-"));
    try {
        const authPath = join(root, "auth.json");
        await writeFile(authPath, JSON.stringify({ openai: oauthCredential("new-account") }));
        const runtime = await ModelRuntime.create({
            authPath,
            modelsPath: null,
            refreshOnCreate: false,
        });
        const modelRegistry = new ModelRegistry(runtime);
        const model = modelRegistry.find("openai", "gpt-5.5");
        assert.ok(model);
        const ctx = testDouble<ExtensionContext>({ model, modelRegistry });

        assert.deepEqual(enabledCodexToolNames(ctx, DEFAULT_CODEX_CORE_CONFIG), [
            "web_run",
            "imagegen",
            "view_image",
        ]);
        const provider = await resolveCodexToolProvider(ctx);
        assert.ok(provider.isErr());
        assert.ok(provider.error instanceof CodexAuthUnavailable);
        assert.match(provider.error.message, /\/login openai-codex/);
        assert.match(provider.error.message, /legacy/);
        assert.match(provider.error.message, /\/login openai is not sufficient/);
        const compaction = await resolveActiveCodexResponsesProvider(ctx);
        assert.ok(compaction.isOk());
        assert.equal(compaction.value, undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("OpenAI model keeps using separate legacy credentials for Codex tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-core-legacy-auth-"));
    try {
        const authPath = join(root, "auth.json");
        const legacy = oauthCredential("legacy-account");
        await writeFile(
            authPath,
            JSON.stringify({
                openai: oauthCredential("new-account"),
                "openai-codex": legacy,
            }),
        );
        const runtime = await ModelRuntime.create({
            authPath,
            modelsPath: null,
            refreshOnCreate: false,
        });
        const modelRegistry = new ModelRegistry(runtime);
        const model = modelRegistry.find("openai", "gpt-5.5");
        assert.ok(model);
        const provider = await resolveCodexToolProvider(
            testDouble<ExtensionContext>({ model, modelRegistry }),
        );
        assert.ok(provider.isOk());
        assert.equal(provider.value.baseUrl, "https://chatgpt.com/backend-api/codex");
        const headers = codexToolProviderHeaders(provider.value);
        assert.equal(headers.get("Authorization"), `Bearer ${legacy.access}`);
        assert.equal(headers.get("ChatGPT-Account-ID"), "legacy-account");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

function oauthCredential(accountId: string) {
    const payload = Buffer.from(
        JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: accountId },
        }),
    ).toString("base64url");
    return {
        type: "oauth",
        access: `header.${payload}.signature`,
        refresh: "unused-refresh-token",
        expires: Number.MAX_SAFE_INTEGER,
    };
}

function makeToolAuthContext(auth: {
    readonly apiKey?: string | undefined;
    readonly headers?: ProviderHeaders | undefined;
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

    return testDouble<ExtensionContext>(ctx);
}
