import assert from "node:assert/strict";
import { test } from "vitest";
import {
    DEFAULT_CODEX_CORE_CONFIG,
    parseCodexCoreConfig,
    resolveCodexRequestModel,
} from "../src/config/config.ts";
import type { JsonObject } from "../src/compaction/types.ts";
import {
    CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY,
    omitReasoningSummary,
    rewriteCodexResponsesPayload,
} from "../src/codex/responses-compat.ts";
import { ResponsesLiteRequestPolicy } from "../src/codex/responses-lite-policy.ts";
import { codexModelRequestProfile, codexReasoningEffortForRequest } from "../src/codex/models.ts";
import {
    buildReasoning,
    buildRemoteCompactionV2Request,
} from "../src/compaction/request-budget.ts";
import { JsonArrayDecoder, JsonObjectDecoder } from "../src/compaction/responses-input.ts";
import {
    captureProviderRequestTemplate,
    clearProviderRequestTemplate,
} from "../src/compaction/provider-request-template.ts";

test("resolves current Codex model selections", () => {
    assert.equal(resolveCodexRequestModel("current", "gpt-5.5"), "gpt-5.5");
    assert.equal(resolveCodexRequestModel(undefined, "gpt-5.5"), "gpt-5.5");
    assert.equal(resolveCodexRequestModel("", "gpt-5.5"), "gpt-5.5");
    assert.equal(resolveCodexRequestModel("gpt-5.4-mini", "gpt-5.5"), "gpt-5.4-mini");
});

test("tracks upstream native compaction compatibility families", () => {
    for (const model of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
        assert.equal(codexModelRequestProfile(model)?.compHash, "3000");
    }
    for (const model of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]) {
        assert.equal(codexModelRequestProfile(model)?.compHash, "2911");
    }
    assert.equal(codexModelRequestProfile("future-model"), undefined);
});

test("rewrites GPT-5.6 requests to the Responses Lite layout", () => {
    const rewritten = rewriteCodexResponsesPayload(
        {
            model: "gpt-5.6-sol",
            instructions: "model instructions",
            tools: [{ type: "function", name: "read" }],
            input: [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_image",
                            image_url: "data:image/png;base64,aGVsbG8=",
                            detail: "original",
                        },
                    ],
                },
            ],
            reasoning: { effort: "ultra", summary: "auto" },
            service_tier: "flex",
            parallel_tool_calls: true,
        },
        "session",
    );

    assert.ok(rewritten);
    assert.equal(Object.hasOwn(rewritten, "instructions"), false);
    assert.equal(Object.hasOwn(rewritten, "tools"), false);
    assert.equal(Object.hasOwn(rewritten, "service_tier"), false);
    assert.equal(rewritten.parallel_tool_calls, false);
    assert.deepEqual(rewritten.reasoning, {
        effort: "max",
        summary: "auto",
        context: "all_turns",
    });
    assert.deepEqual(rewritten.client_metadata, {
        [CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY]: "true",
    });
    assert.ok(Array.isArray(rewritten.input));
    assert.deepEqual(rewritten.input.slice(0, 2), [
        {
            type: "additional_tools",
            id: "at_38474625-7bd5-5916-8249-92b0f5358d0b",
            role: "developer",
            tools: [{ type: "function", name: "read" }],
        },
        {
            type: "message",
            id: "msg_82eb15f9-2126-595d-990d-0332d0e3db78",
            role: "developer",
            content: [{ type: "input_text", text: "model instructions" }],
        },
    ]);
    assert.doesNotMatch(JSON.stringify(rewritten.input), /"detail"/);
    assert.equal(
        rewriteCodexResponsesPayload({ model: "gpt-5.5", input: [] }, "session"),
        undefined,
    );
});

test("normalizes ultra to supported model reasoning without changing the medium default", () => {
    const ultraConfig = parseCodexCoreConfig({ openai: { compactionReasoning: "ultra" } });
    for (const [model, expected] of [
        ["gpt-6-astra", "xhigh"],
        ["gpt-5.6-sol", "max"],
        ["gpt-5.6-terra", "max"],
        ["gpt-5.6-luna", "max"],
        ["gpt-5.5", "xhigh"],
        ["gpt-5.4", "xhigh"],
        ["gpt-5.4-mini", "xhigh"],
        ["future-model", "medium"],
    ]) {
        assert.ok(model && expected);
        assert.equal(codexReasoningEffortForRequest(" ULTRA ", model), expected);
        assert.equal(buildReasoning(ultraConfig, model).reasoning.effort, expected);
        assert.equal(buildReasoning(DEFAULT_CODEX_CORE_CONFIG, model).reasoning.effort, "medium");
        assert.equal(codexReasoningEffortForRequest(" high ", model), "high");
    }
});

test("routes Astra through Lite with the upstream low default and ultra override", () => {
    const payload = {
        model: "gpt-6-astra",
        instructions: "astra system",
        tools: [],
        input: [],
        service_tier: "priority",
    };
    const normal = rewriteCodexResponsesPayload(payload, "astra-session", "gpt-6-astra");
    assert.ok(normal);
    assert.deepEqual(normal.reasoning, { effort: "low", context: "all_turns" });
    assert.equal(normal.service_tier, "priority");
    assert.equal(normal.parallel_tool_calls, false);
    const ultra = rewriteCodexResponsesPayload(
        { ...payload, reasoning: { effort: "ultra" } },
        "astra-session",
    );
    assert.deepEqual(ultra?.reasoning, { effort: "xhigh", context: "all_turns" });
    assert.equal(rewriteCodexResponsesPayload(payload, "astra-session", "gpt-5.6-sol"), undefined);
});

test("keeps Lite prefix identities stable across retries, resumes and compaction", () => {
    const sessionId = "prefix-parity";
    const tools = [{ type: "function", name: "read" }];
    const payload = {
        model: "gpt-6-astra",
        instructions: "stable instructions",
        tools,
        input: [{ role: "user", content: "first request" }],
        prompt_cache_key: "provider-cache-key",
    };
    const normal = rewriteCodexResponsesPayload(payload, sessionId);
    const prefix = responsePrefix(normal);
    assert.deepEqual(responsePrefix(rewriteCodexResponsesPayload(payload, sessionId)), prefix);
    assert.deepEqual(
        responsePrefix(rewriteCodexResponsesPayload({ ...payload, input: [] }, sessionId)),
        prefix,
    );
    assert.deepEqual(responsePrefix(rewriteCodexResponsesPayload(normal, sessionId)), prefix);
    const requestParts = {
        sessionId,
        model: payload.model,
        instructions: payload.instructions,
        tools,
        promptCacheKey: "different-cache-key",
        verbosity: "low",
        fast: false,
        input: [],
    };
    const withoutTemplate = buildRemoteCompactionV2Request(requestParts);
    assert.deepEqual(withoutTemplate.input.slice(0, 2), prefix);
    try {
        const template = captureProviderRequestTemplate(sessionId, normal);
        assert.ok(template);
        const compact = buildRemoteCompactionV2Request({
            ...requestParts,
            requestTemplate: template,
        });
        assert.deepEqual(compact.input.slice(0, 2), prefix);
        assert.equal(compact.prompt_cache_key, payload.prompt_cache_key);
        const changedTools = buildRemoteCompactionV2Request({
            ...requestParts,
            tools: [{ type: "function", name: "write" }],
            requestTemplate: template,
        });
        assert.notEqual(changedTools.input[0]?.id, prefix[0]?.id);
        assert.equal(changedTools.input[1]?.id, prefix[1]?.id);
        const manualGuidance = buildRemoteCompactionV2Request({
            ...requestParts,
            instructions: "stable instructions\nmanual guidance",
            requestTemplate: template,
        });
        assert.notEqual(manualGuidance.input[1]?.id, prefix[1]?.id);
        assert.equal(manualGuidance.input[0]?.id, prefix[0]?.id);
    } finally {
        clearProviderRequestTemplate(sessionId);
    }
    assert.deepEqual(responsePrefix(rewriteCodexResponsesPayload(payload, sessionId)), prefix);
    const otherSession = responsePrefix(rewriteCodexResponsesPayload(payload, "different-session"));
    assert.notEqual(otherSession[0]?.id, prefix[0]?.id);
    assert.notEqual(otherSession[1]?.id, prefix[1]?.id);
    const changedInstructions = responsePrefix(
        rewriteCodexResponsesPayload({ ...payload, instructions: "new instructions" }, sessionId),
    );
    assert.equal(changedInstructions[0]?.id, prefix[0]?.id);
    assert.notEqual(changedInstructions[1]?.id, prefix[1]?.id);
    const changedTools = responsePrefix(
        rewriteCodexResponsesPayload({ ...payload, tools: [] }, sessionId),
    );
    assert.notEqual(changedTools[0]?.id, prefix[0]?.id);
    assert.equal(changedTools[1]?.id, prefix[1]?.id);
    const noInstructions = rewriteCodexResponsesPayload(
        { ...payload, instructions: "", input: [] },
        sessionId,
    );
    assert.equal(JsonArrayDecoder.decode(noInstructions?.input)?.length, 1);
});

function responsePrefix(request: JsonObject | undefined): readonly JsonObject[] {
    const input = JsonArrayDecoder.decode(request?.input);
    assert.ok(input);
    return input.slice(0, 2).map((item) => {
        const record = JsonObjectDecoder.decode(item);
        assert.ok(record);
        return record;
    });
}

test("omits only the visible reasoning summary from Responses requests", () => {
    const rewritten = omitReasoningSummary(
        {
            model: "gpt-5.5",
            input: [{ role: "user", content: "hello" }],
            reasoning: {
                effort: "high",
                summary: "auto",
                encrypted_content: "opaque",
            },
        },
        "gpt-5.5",
    );

    assert.deepEqual(rewritten, {
        model: "gpt-5.5",
        input: [{ role: "user", content: "hello" }],
        reasoning: { effort: "high", encrypted_content: "opaque" },
    });
    assert.equal(
        omitReasoningSummary(
            { model: "gpt-5.5", reasoning: { effort: "high", summary: "auto" } },
            "gpt-5.6-sol",
        ),
        undefined,
    );
});

test("suppresses Responses Lite throughout Pi fallback compaction", () => {
    const policy = new ResponsesLiteRequestPolicy();

    policy.beginPiCompactionFallback("session-1");

    assert.equal(policy.shouldAttachLiteHeader("session-1"), false);
    assert.equal(policy.shouldAttachLiteHeader("session-1"), false);

    policy.finishCompaction("session-1");

    assert.equal(policy.shouldAttachLiteHeader("session-1"), true);
});

test("recovers Responses Lite state after a failed Pi fallback", () => {
    const policy = new ResponsesLiteRequestPolicy();

    policy.beginPiCompactionFallback("session-1");
    assert.equal(policy.shouldAttachLiteHeader("session-1"), false);

    assert.equal(policy.shouldAttachLiteHeader("session-1"), false);
    assert.equal(policy.shouldRewriteLitePayload("session-1"), false);
    assert.equal(policy.shouldAttachLiteHeader("session-1"), true);
    assert.equal(policy.shouldRewriteLitePayload("session-1"), true);
});
