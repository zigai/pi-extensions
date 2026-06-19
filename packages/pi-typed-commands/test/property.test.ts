import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { defineTypedCommand } from "../src/index.js";
import { renderTypedSkillInvocation } from "../src/skills.js";

const PROPERTY_RUNS = 300;

const roundTripCommand = defineTypedCommand({
    name: "property-demo",
    description: "Command used by property tests",
    args: {
        action: {
            type: "enum",
            values: ["deploy", "rollback"],
            required: true,
            position: 0,
        },
        path: {
            type: "string",
            required: true,
            position: 1,
        },
        ref: {
            type: "string",
            required: true,
        },
        dryRun: {
            type: "boolean",
            required: true,
        },
        count: {
            type: "number",
            integer: true,
            min: -1000,
            max: 1000,
            required: true,
        },
        target: {
            type: "enum",
            values: ["dev", "staging", "prod"],
            required: true,
        },
        tags: {
            type: "multi-enum",
            values: ["api", "web", "worker"],
            required: true,
            minItems: 1,
        },
    },
});

const roundTripValues = fc.record({
    action: fc.constantFrom("deploy", "rollback"),
    path: fc.string({ maxLength: 40 }),
    ref: fc.string({ maxLength: 40 }),
    dryRun: fc.boolean(),
    count: fc.integer({ min: -1000, max: 1000 }),
    target: fc.constantFrom("dev", "staging", "prod"),
    tags: fc.uniqueArray(fc.constantFrom("api", "web", "worker"), {
        minLength: 1,
        maxLength: 3,
    }),
});

const boundedString = fc.string({ maxLength: 120 });
const nonEmptyBoundedString = boundedString.map((value) => `x${value}`);

void describe("parser and serializer properties", () => {
    void it("round-trips generated valid values through serialize and parse", () => {
        fc.assert(
            fc.property(roundTripValues, (values) => {
                const raw = roundTripCommand.serialize(values);
                const parsed = roundTripCommand.parse(raw);

                assert.equal(parsed.status, "success");
                if (parsed.status !== "success") {
                    return;
                }
                assert.deepEqual(parsed.value, { ...values });
            }),
            { numRuns: PROPERTY_RUNS },
        );
    });

    void it("does not throw for arbitrary raw argument text", () => {
        fc.assert(
            fc.property(boundedString, (raw) => {
                assert.doesNotThrow(() => {
                    roundTripCommand.parse(raw);
                });
            }),
            { numRuns: PROPERTY_RUNS },
        );
    });
});

void describe("typed skill prompt escaping properties", () => {
    void it("does not let arbitrary user data add skill closing tags or Markdown fences", () => {
        fc.assert(
            fc.property(nonEmptyBoundedString, nonEmptyBoundedString, (path, additionalInput) => {
                const rendered = renderTypedSkillInvocation({
                    skill: {
                        name: "demo",
                        filePath: "/tmp/SKILL.md",
                        baseDir: "/tmp",
                        body: "Process the provided data.",
                    },
                    values: { path },
                    additionalInput,
                });

                const closingTags = rendered.match(/<\/skill>/g) ?? [];
                const codeFences = rendered.match(/```/g) ?? [];

                assert.equal(closingTags.length, 1);
                assert.equal(codeFences.length, 4);
            }),
            { numRuns: PROPERTY_RUNS },
        );
    });
});
