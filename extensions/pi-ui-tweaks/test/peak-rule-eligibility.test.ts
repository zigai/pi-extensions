import { describe, expect, it } from "vitest";
import { eligiblePeakRule } from "../src/peak-rule-eligibility.ts";

describe("off-peak offer eligibility", () => {
    it("requires the explicit OpenRouter billing assertion", () => {
        expect(
            eligiblePeakRule({
                provider: "openrouter",
                model: "deepseek/deepseek-v4-pro-0813",
                schedule: "or",
            }),
        ).toBe(false);

        expect(
            eligiblePeakRule({
                provider: "openrouter",
                model: "deepseek/deepseek-v4-pro-0813",
                schedule: "or",
                openRouterBillingConfirmed: true,
            }),
        ).toBe(true);
    });

    it("limits OpenCode Go to its two documented DeepSeek models", () => {
        expect(
            eligiblePeakRule({
                provider: "opencode-go",
                model: "deepseek-v4.1-flash",
                schedule: "deepseek-reseller",
            }),
        ).toBe(true);

        expect(
            eligiblePeakRule({
                provider: "opencode-go",
                model: "deepseek-v4-flash",
                schedule: "deepseek-reseller",
            }),
        ).toBe(false);

        expect(
            eligiblePeakRule({
                provider: "openrouter",
                model: "deepseek-v4.1-flash",
                schedule: "deepseek-reseller",
            }),
        ).toBe(false);
    });

    it("rejects unconfirmed models and reseller inheritance", () => {
        expect(eligiblePeakRule({ provider: "zai", model: "glm-5.3", schedule: "glm" })).toBe(true);
        expect(eligiblePeakRule({ provider: "zai", model: "glm-5.2", schedule: "glm" })).toBe(
            false,
        );

        expect(
            eligiblePeakRule({ provider: "opencode-go", model: "glm-5.3", schedule: "glm" }),
        ).toBe(false);

        expect(
            eligiblePeakRule({ provider: "openrouter", model: "glm-5.3", schedule: "glm" }),
        ).toBe(false);

        expect(
            eligiblePeakRule({
                provider: "mimo",
                model: "mimo-v2.6-pro-ultraspeed",
                schedule: "mimo",
            }),
        ).toBe(false);
    });

    it("excludes the disputed MiMo speech model from the night benefit", () => {
        expect(
            eligiblePeakRule({ provider: "mimo", model: "mimo-v2.6-pro", schedule: "mimo" }),
        ).toBe(true);

        expect(
            eligiblePeakRule({ provider: "mimo", model: "mimo-v2.6-flash", schedule: "mimo" }),
        ).toBe(true);

        expect(
            eligiblePeakRule({ provider: "mimo", model: "mimo-v2.5-asr", schedule: "mimo" }),
        ).toBe(false);
    });

    it.each([
        "deepseek-v4-pro-0813",
        "deepseek-v4-flash-0731",
        "deepseek-v4.1-flash",
        "deepseek-v4.1-flash-1017",
    ])(
        "allows Alibaba hosted DeepSeek %s when the billing route and region are asserted",
        (model) => {
            expect(eligiblePeakRule({ provider: "alibaba", model, schedule: "ali-deepseek" })).toBe(
                true,
            );
        },
    );

    it("rejects unlisted Alibaba DeepSeek versions", () => {
        expect(
            eligiblePeakRule({
                provider: "alibaba",
                model: "deepseek-v4-flash-fast",
                schedule: "ali-deepseek",
            }),
        ).toBe(false);
    });

    it("distinguishes Alibaba API, token-plan Qwen and token-plan DeepSeek models", () => {
        expect(
            eligiblePeakRule({ provider: "alibaba", model: "qwen3.7-plus", schedule: "qwen" }),
        ).toBe(true);

        expect(
            eligiblePeakRule({ provider: "alibaba", model: "qwen3.8-max", schedule: "qwen" }),
        ).toBe(false);

        expect(
            eligiblePeakRule({
                provider: "alibaba",
                model: "qwen3.8-max",
                schedule: "ali-qwen",
            }),
        ).toBe(true);

        expect(
            eligiblePeakRule({
                provider: "alibaba",
                model: "deepseek-v4.1-flash",
                schedule: "ali-deepseek",
            }),
        ).toBe(true);
    });
});
