import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { preparePickerPayload } from "../src/picker-request.ts";

function createModel(id: string): Model<Api> {
    return {
        id,
        name: id,
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://example.test",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 10_000,
    };
}

describe("picker request", () => {
    it("applies the request shape required by Codex Luna", () => {
        const payload = {
            model: "gpt-5.6-luna",
            parallel_tool_calls: true,
            reasoning: { effort: "low", summary: "auto" },
        };

        expect(preparePickerPayload(createModel("gpt-5.6-luna"), payload)).toEqual({
            model: "gpt-5.6-luna",
            parallel_tool_calls: false,
            reasoning: { effort: "low", summary: "auto", context: "all_turns" },
        });

        expect(payload.parallel_tool_calls).toBe(true);
    });

    it("leaves ordinary picker model payloads unchanged", () => {
        const payload = { model: "gpt-5.6-sol", parallel_tool_calls: true };

        expect(preparePickerPayload(createModel("gpt-5.6-sol"), payload)).toBeUndefined();
    });

    it("rewrites payloads that carry undefined property values", () => {
        // pi-ai omits the session id when none is configured, so the built
        // request body contains prompt_cache_key: undefined. JSON.stringify
        // drops it on the wire, so validation must apply the same semantics
        // instead of discarding the rewrite.
        const payload = {
            model: "gpt-5.6-luna",
            prompt_cache_key: undefined,
            parallel_tool_calls: true,
            reasoning: { effort: "low", summary: "auto" },
        };

        const result = preparePickerPayload(createModel("gpt-5.6-luna"), payload);

        // The undefined key survives like pi-ai's own in-memory bodies;
        // serialization drops it before the request is sent.
        expect(result).toEqual({
            model: "gpt-5.6-luna",
            prompt_cache_key: undefined,
            parallel_tool_calls: false,
            reasoning: { effort: "low", summary: "auto", context: "all_turns" },
        });
    });

    it("rewrites payloads when request headers opt the model into Responses Lite", () => {
        const payload = { model: "gpt-5.6-sol", parallel_tool_calls: true };

        expect(
            preparePickerPayload(createModel("gpt-5.6-sol"), payload, {
                "X-OpenAI-Internal-Codex-Responses-Lite": "true",
            }),
        ).toEqual({
            model: "gpt-5.6-sol",
            parallel_tool_calls: false,
            reasoning: { context: "all_turns" },
        });

        expect(
            preparePickerPayload(createModel("gpt-5.6-sol"), payload, {
                authorization: "Bearer token",
            }),
        ).toBeUndefined();
    });

    it("does not replace non-JSON objects returned by a provider", () => {
        const payload = new Date(0);

        expect(preparePickerPayload(createModel("gpt-5.6-luna"), payload)).toBeUndefined();
    });
});
