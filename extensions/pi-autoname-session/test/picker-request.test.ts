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

        expect(preparePickerPayload(createModel("gpt-5.6-sol"), payload)).toBe(payload);
    });
});
