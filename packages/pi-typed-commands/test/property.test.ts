import assert from "node:assert/strict";
import { describe, it } from "vitest";
import fc from "fast-check";
import {
    compileTypedCommandDefinition,
    defineTypedCommand,
    parseTypedCommandArgs,
    serializeTypedCommandArgs,
} from "../src/index.js";
import { renderTypedSkillInvocation } from "../src/skills.js";

const PROPERTY_RUNS = 300;

const roundTripArgs = {
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
} as const;

const roundTripCommandDefinition = {
    name: "property-demo",
    description: "Command used by property tests",
    args: roundTripArgs,
    run() {},
};

const roundTripCommand = defineTypedCommand(roundTripCommandDefinition);

const compiledRoundTripCommand = (() => {
    const compiled = compileTypedCommandDefinition(roundTripCommandDefinition);
    assert.equal(compiled.ok, true);

    if (!compiled.ok) {
        throw new Error("property command did not compile");
    }

    return { ...roundTripCommandDefinition, compiled: compiled.command };
})();

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

const collectionCommand = defineTypedCommand({
    name: "collection-property-demo",
    description: "Collection round-trip property",
    args: {
        item: { type: "string-list" },
        setting: { type: "key-value" },
    },
    run() {},
});

const collectionValues = fc.record({
    item: fc.array(fc.constantFrom("alpha", "beta", "path\\to", "x=y"), { maxLength: 12 }),
    setting: fc.dictionary(
        fc.constantFrom("alpha", "beta", "path\\to", "__proto__", "constructor"),
        fc.constantFrom("plain", "x=y", " leading", "trailing ", "path\\to"),
        { maxKeys: 3 },
    ),
});

const finiteNumber = fc.double({ noNaN: true, noDefaultInfinity: true });
const boundedString = fc.string({ maxLength: 120 });
const nonEmptyBoundedString = boundedString.map((value) => `x${value}`);

describe("parser and serializer properties", () => {
    it("round-trips generated valid values through serialize and parse", () => {
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

    it("round-trips generated canonical string-list and key-value values", () => {
        fc.assert(
            fc.property(collectionValues, (values) => {
                const raw = collectionCommand.serialize(values);
                const parsed = collectionCommand.parse(raw);
                assert.equal(parsed.status, "success");
                if (parsed.status !== "success") return;

                assert.deepEqual(parsed.value, {
                    item: values.item,
                    setting: { ...values.setting },
                });
            }),
            { numRuns: PROPERTY_RUNS },
        );
    });

    it("round-trips every generated finite number including signed zero", () => {
        const numberCommand = defineTypedCommand({
            name: "number-property-demo",
            description: "Number round-trip property",
            args: { value: { type: "number", required: true } },
            run() {},
        });
        fc.assert(
            fc.property(finiteNumber, (value) => {
                const raw = numberCommand.serialize({ value });
                const parsed = numberCommand.parse(raw);
                assert.equal(parsed.status, "success");
                if (parsed.status !== "success") return;

                assert.equal(Object.is(parsed.value.value, value), true);
            }),
            { numRuns: PROPERTY_RUNS },
        );
    });

    it("does not throw for arbitrary raw argument text", () => {
        fc.assert(
            fc.property(boundedString, (raw) => {
                assert.doesNotThrow(() => {
                    roundTripCommand.parse(raw);
                });
            }),
            { numRuns: PROPERTY_RUNS },
        );
    });

    it("keeps compiled and uncompiled grammar behavior equivalent", () => {
        fc.assert(
            fc.property(boundedString, roundTripValues, (raw, values) => {
                assert.deepEqual(
                    parseTypedCommandArgs(compiledRoundTripCommand, raw),
                    parseTypedCommandArgs(roundTripCommandDefinition, raw),
                );
                assert.equal(
                    serializeTypedCommandArgs(compiledRoundTripCommand, values),
                    serializeTypedCommandArgs(roundTripCommandDefinition, values),
                );
            }),
            { numRuns: PROPERTY_RUNS },
        );
    });
});

describe("typed skill prompt escaping properties", () => {
    it("does not let arbitrary user data add skill closing tags or Markdown fences", () => {
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
