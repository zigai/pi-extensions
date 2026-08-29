import assert from "node:assert/strict";
import { test } from "vitest";

import {
    captureProviderRequestTemplate,
    clearProviderRequestTemplate,
    getProviderRequestTemplate,
} from "../src/compaction/provider-request-template.ts";
import { buildRemoteCompactionV2Request } from "../src/compaction/request-budget.ts";

type LazyConversationItem = { role: string; content?: never };

test("captures provider-ready cache fields without retaining conversation input", () => {
    const sessionId = "provider-template-standard";
    try {
        const template = captureProviderRequestTemplate(sessionId, {
            model: "gpt-5.5",
            instructions: "final chained system prompt",
            input: [{ role: "user", content: "conversation secret must not be retained" }],
            tools: [
                {
                    type: "function",
                    name: "dynamic_tool",
                    description: "Captured definition.",
                    parameters: { type: "object", properties: { value: { type: "string" } } },
                    strict: false,
                },
            ],
            prompt_cache_key: "provider-cache-key",
            reasoning: { effort: "high", summary: "auto", custom: "preserved" },
            text: { verbosity: "medium", format: { type: "text" } },
            service_tier: "priority",
            tool_choice: { type: "function", name: "dynamic_tool" },
            parallel_tool_calls: false,
            include: ["custom.output"],
            client_metadata: { static_key: "static-value" },
        });

        assert.ok(template);
        assert.equal(template.layout, "responses");
        assert.equal(template.instructions, "final chained system prompt");
        assert.equal(template.promptCacheKey, "provider-cache-key");
        assert.equal(JSON.stringify(template).includes("conversation secret"), false);

        const request = buildRemoteCompactionV2Request({
            model: "gpt-5.5",
            input: [{ role: "user", content: "compact this" }],
            instructions: template.instructions,
            promptCacheKey: "fallback-key",
            verbosity: "low",
            fast: false,
            tools: template.tools,
            requestTemplate: template,
            clientMetadata: { static_key: "replacement", compaction: "true" },
        });

        assert.equal(request.prompt_cache_key, "provider-cache-key");
        assert.deepEqual(request.tools, template.tools);
        assert.equal(request.tool_choice, "auto");
        assert.equal(request.parallel_tool_calls, true);
        assert.deepEqual(request.include, ["reasoning.encrypted_content"]);
        assert.deepEqual(request.text, { verbosity: "low" });
        assert.deepEqual(request.client_metadata, {
            static_key: "replacement",
            compaction: "true",
        });
        assert.equal(request.service_tier, "priority");
    } finally {
        clearProviderRequestTemplate(sessionId);
    }
});

test("captures and reuses the Responses Lite static prefix", () => {
    const sessionId = "provider-template-lite";
    try {
        const additionalTools = {
            type: "additional_tools",
            role: "developer",
            namespace: "captured",
            tools: [
                {
                    type: "function",
                    name: "dynamic_tool",
                    description: "Dynamic.",
                    parameters: { type: "object" },
                    strict: false,
                },
            ],
        };
        const developerMessage = {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "final Lite system prompt" }],
        };
        const template = captureProviderRequestTemplate(sessionId, {
            model: "gpt-5.6-sol",
            input: [
                additionalTools,
                developerMessage,
                { role: "user", content: "conversation input" },
            ],
            prompt_cache_key: "lite-cache-key",
            reasoning: { effort: "low", context: "all_turns" },
            parallel_tool_calls: false,
        });

        assert.ok(template);
        assert.equal(template.layout, "responses-lite");
        assert.equal(template.instructions, "final Lite system prompt");
        assert.equal(JSON.stringify(template).includes("conversation input"), false);

        const request = buildRemoteCompactionV2Request({
            model: "gpt-5.6-sol",
            input: [{ role: "user", content: "compact this" }],
            instructions: template.instructions,
            promptCacheKey: "fallback-key",
            verbosity: "low",
            fast: false,
            tools: template.tools,
            requestTemplate: template,
        });

        assert.deepEqual(request.input[0], additionalTools);
        assert.deepEqual(request.input[1], developerMessage);
        assert.equal(request.prompt_cache_key, "lite-cache-key");
        assert.equal(Object.hasOwn(request, "instructions"), false);
        assert.equal(Object.hasOwn(request, "tools"), false);
    } finally {
        clearProviderRequestTemplate(sessionId);
    }
});

test("isolates templates by session, model, and wire layout", () => {
    const sessionId = "provider-template-isolation";
    try {
        captureProviderRequestTemplate(
            sessionId,
            {
                model: "gpt-5.5",
                instructions: "system",
                input: [],
            },
            { activeToolNames: ["read"] },
        );

        assert.ok(getProviderRequestTemplate(sessionId, "gpt-5.5", "responses", ["read"]));
        assert.equal(
            getProviderRequestTemplate(sessionId, "gpt-5.5", "responses", ["write"]),
            undefined,
        );
        assert.equal(getProviderRequestTemplate(sessionId, "gpt-5.6-sol", "responses"), undefined);
        assert.equal(getProviderRequestTemplate(sessionId, "gpt-5.5", "responses-lite"), undefined);
        clearProviderRequestTemplate(sessionId);
        assert.equal(getProviderRequestTemplate(sessionId, "gpt-5.5", "responses"), undefined);
    } finally {
        clearProviderRequestTemplate(sessionId);
    }
});

test("does not traverse conversation items while capturing a Lite prefix", () => {
    const sessionId = "provider-template-bounded-capture";
    const conversationItem: LazyConversationItem = { role: "user" };
    Object.defineProperty(conversationItem, "content", {
        enumerable: true,
        get(): never {
            throw new Error("conversation content was traversed");
        },
    });
    try {
        assert.doesNotThrow(() =>
            captureProviderRequestTemplate(sessionId, {
                model: "gpt-5.6-sol",
                input: [
                    { type: "additional_tools", role: "developer", tools: [] },
                    {
                        type: "message",
                        role: "developer",
                        content: [{ type: "input_text", text: "system" }],
                    },
                    conversationItem,
                ],
            }),
        );
    } finally {
        clearProviderRequestTemplate(sessionId);
    }
});
