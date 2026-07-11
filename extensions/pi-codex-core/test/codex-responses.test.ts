import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveCodexRequestModel } from "../src/config/config.ts";
import {
    CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY,
    omitReasoningSummary,
    rewriteCodexResponsesPayload,
} from "../src/codex/responses-compat.ts";
import { ResponsesLiteRequestPolicy } from "../src/codex/responses-lite-policy.ts";
import { codexModelRequestProfile } from "../src/codex/models.ts";

test("resolves current Codex model selections", () => {
    assert.equal(resolveCodexRequestModel("current", "gpt-5.5"), "gpt-5.5");
    assert.equal(resolveCodexRequestModel(undefined, "gpt-5.5"), "gpt-5.5");
    assert.equal(resolveCodexRequestModel("", "gpt-5.5"), "gpt-5.5");
    assert.equal(resolveCodexRequestModel("gpt-5.4-mini", "gpt-5.5"), "gpt-5.4-mini");
});

test("tracks upstream native compaction compatibility families", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
        assert.equal(codexModelRequestProfile(model)?.compHash, "3000");
    }
    for (const model of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]) {
        assert.equal(codexModelRequestProfile(model)?.compHash, "2911");
    }
    assert.equal(codexModelRequestProfile("future-model"), undefined);
});

test("rewrites GPT-5.6 requests to the Responses Lite layout", () => {
    const rewritten = rewriteCodexResponsesPayload({
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
    });

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
            role: "developer",
            tools: [{ type: "function", name: "read" }],
        },
        {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "model instructions" }],
        },
    ]);
    assert.doesNotMatch(JSON.stringify(rewritten.input), /"detail"/);
    assert.equal(rewriteCodexResponsesPayload({ model: "gpt-5.5", input: [] }), undefined);
});

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
