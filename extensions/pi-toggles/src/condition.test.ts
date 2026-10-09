import { describe, expect, it } from "vitest";
import {
    evaluateCondition,
    getReferencedFacts,
    type FactArguments,
    type FactResolution,
} from "./condition.ts";
import type { Condition } from "./settings.ts";

const facts = new Map<string, string | number | boolean | null>([
    ["model.provider", "anthropic"],
    ["project.trusted", true],
    ["count", 3],
]);

function resolveFact(name: string, _args: FactArguments | undefined): FactResolution {
    const value = facts.get(name);
    return value === undefined && !facts.has(name)
        ? { status: "missing", reason: "not set" }
        : { status: "known", value: value ?? null };
}

describe("evaluateCondition", () => {
    it("evaluates nested boolean and comparison nodes", () => {
        const condition: Condition = {
            all: [
                { fact: "model.provider", equals: "anthropic" },
                { fact: "project.trusted", equals: true },
                { not: { fact: "count", lessThan: 3 } },
            ],
        };

        expect(evaluateCondition(condition, resolveFact)).toEqual({ value: true, diagnostics: [] });
    });

    it("keeps unknown distinct from false", () => {
        const condition: Condition = {
            all: [
                { fact: "project.trusted", equals: true },
                { fact: "missing.value", equals: "x" },
            ],
        };

        const result = evaluateCondition(condition, resolveFact);
        expect(result.value).toBe("unknown");
        expect(result.diagnostics[0]).toContain("missing.value");
    });

    it("lets an explicit false short-circuit the truth value while retaining diagnostics", () => {
        const condition: Condition = {
            all: [
                { fact: "project.trusted", equals: false },
                { fact: "missing.value", equals: "x" },
            ],
        };

        const result = evaluateCondition(condition, resolveFact);
        expect(result.value).toBe(false);
        expect(result.diagnostics).toHaveLength(1);
    });

    it("supports defined checks for absent context keys", () => {
        const condition: Condition = { fact: "missing.value", isDefined: false };
        expect(evaluateCondition(condition, resolveFact)).toEqual({ value: true, diagnostics: [] });
    });

    it("extracts referenced facts", () => {
        const condition: Condition = {
            any: [
                { fact: "model.provider", equals: "openai" },
                { not: { fact: "project.trusted", equals: false } },
            ],
        };
        expect([...getReferencedFacts(condition)].sort()).toEqual([
            "model.provider",
            "project.trusted",
        ]);
    });
});
