import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
    defineExtensionSettings,
    isExtensionSettingsDefinition,
    type ExtensionSettingsDefinitionInput,
} from "../src/definition.ts";
import {
    createPrevalidatedExtensionSettingsArtifact,
    definePrevalidatedExtensionSettings,
    InvalidPrevalidatedSettingsArtifact,
    prevalidatedExtensionSettingsFingerprint,
} from "../src/runtime.ts";

function input() {
    return {
        id: "runtime-test",
        title: "Runtime Test",
        description: "Runtime fast-path settings.",
        schema: Type.Object(
            {
                enabled: Type.Boolean({ default: true, description: "Enable the feature." }),
                nested: Type.Object(
                    {
                        label: Type.String({ default: "default", description: "Display label." }),
                    },
                    { additionalProperties: false, default: {} },
                ),
            },
            { additionalProperties: false },
        ),
        exampleSettings: { enabled: false },
    } as const satisfies ExtensionSettingsDefinitionInput<ReturnType<typeof Type.Object>>;
}

describe("prevalidated settings runtime", () => {
    it("hydrates the same immutable contract without mutating authoring inputs", () => {
        const authoringInput = input();
        const validated = defineExtensionSettings(authoringInput);
        const artifact = createPrevalidatedExtensionSettingsArtifact(validated);
        const hydrated = definePrevalidatedExtensionSettings(authoringInput, artifact);

        expect(hydrated).toEqual(validated);
        expect(hydrated).not.toBe(validated);
        expect(hydrated.schema).not.toBe(authoringInput.schema);
        expect(hydrated.defaultSettings).not.toBe(artifact.defaultSettings);
        expect(isExtensionSettingsDefinition(hydrated)).toBe(true);
        expect(Object.isFrozen(authoringInput.schema)).toBe(false);
        expect(Object.isFrozen(artifact.defaultSettings)).toBe(false);
        expect(Object.isFrozen(hydrated)).toBe(true);
        expect(Object.isFrozen(hydrated.schema)).toBe(true);
        expect(Object.isFrozen(hydrated.schema.properties.nested)).toBe(true);
        expect(Object.isFrozen(hydrated.defaultSettings)).toBe(true);
        expect(Object.isFrozen(hydrated.exampleSettings)).toBe(true);
    });

    it("creates deterministic artifacts and detects source, data, and format drift", () => {
        const authoringInput = input();
        const validated = defineExtensionSettings(authoringInput);
        const first = createPrevalidatedExtensionSettingsArtifact(validated);
        const second = createPrevalidatedExtensionSettingsArtifact(validated);
        expect(second).toEqual(first);

        expect(() =>
            definePrevalidatedExtensionSettings(
                { ...authoringInput, title: "Changed title" },
                first,
            ),
        ).toThrowError(InvalidPrevalidatedSettingsArtifact);
        expect(() =>
            definePrevalidatedExtensionSettings(authoringInput, {
                ...first,
                defaultSettings: { ...first.defaultSettings, enabled: false },
            }),
        ).toThrowError("artifact is stale");
        expect(() =>
            definePrevalidatedExtensionSettings(authoringInput, {
                ...first,
                // @ts-expect-error Deliberately exercise a future/invalid generated format.
                formatVersion: 2,
            }),
        ).toThrowError("unsupported prevalidation format version");
    });

    it("rejects generated JSON objects with invalid or unreadable prototypes", () => {
        const authoringInput = input();
        const artifact = createPrevalidatedExtensionSettingsArtifact(
            defineExtensionSettings(authoringInput),
        );
        const invalidDefault = { ...artifact.defaultSettings };
        Object.setPrototypeOf(invalidDefault, Array.prototype);
        expect(() =>
            definePrevalidatedExtensionSettings(authoringInput, {
                ...artifact,
                defaultSettings: invalidDefault,
            }),
        ).toThrowError("defaultSettings must be a JSON object");

        const invalidExample = { ...artifact.exampleSettings };
        Object.setPrototypeOf(invalidExample, Date.prototype);
        expect(() =>
            definePrevalidatedExtensionSettings(authoringInput, {
                ...artifact,
                exampleSettings: invalidExample,
            }),
        ).toThrowError("exampleSettings must be a JSON object");

        const unreadableDefault = new Proxy(
            { ...artifact.defaultSettings },
            {
                getPrototypeOf() {
                    throw new Error("unreadable prototype");
                },
            },
        );
        expect(() =>
            definePrevalidatedExtensionSettings(authoringInput, {
                ...artifact,
                defaultSettings: unreadableDefault,
            }),
        ).toThrowError("defaultSettings must be a JSON object");
    });

    it("fingerprints TypeBox codec behavior rather than JSON shape alone", () => {
        const codecA = Type.Codec(Type.String({ default: "value", description: "Codec value." }))
            .Decode((value) => `${value}-a`)
            .Encode((value) => value.slice(0, -2));
        const codecB = Type.Codec(Type.String({ default: "value", description: "Codec value." }))
            .Decode((value) => `${value}-b`)
            .Encode((value) => value.slice(0, -2));
        const inputA = {
            id: "codec-test",
            title: "Codec Test",
            description: "Codec settings.",
            schema: Type.Object({ value: codecA }, { additionalProperties: false }),
        } as const;
        const inputB = {
            ...inputA,
            schema: Type.Object({ value: codecB }, { additionalProperties: false }),
        } as const;
        const defaults = { value: "value" };

        expect(JSON.stringify(inputA.schema)).toBe(JSON.stringify(inputB.schema));
        expect(prevalidatedExtensionSettingsFingerprint(inputA, defaults, undefined)).toBe(
            prevalidatedExtensionSettingsFingerprint(inputB, defaults, undefined),
        );
        const validated = defineExtensionSettings(inputA);
        const validatedB = defineExtensionSettings(inputB);
        const artifactA = createPrevalidatedExtensionSettingsArtifact(validated);
        const artifactB = createPrevalidatedExtensionSettingsArtifact(validatedB);
        expect(artifactA.semanticFingerprint).not.toBe(artifactB.semanticFingerprint);
        expect(() => definePrevalidatedExtensionSettings(inputB, artifactA)).toThrowError(
            "artifact is stale",
        );
        expect(() =>
            definePrevalidatedExtensionSettings(inputA, {
                ...artifactA,
                semanticFingerprint: artifactB.semanticFingerprint,
            }),
        ).toThrowError("artifact is stale");
        expect(Value.Decode(inputA.schema, defaults)).toEqual({ value: "value-a" });
        const hydrated = definePrevalidatedExtensionSettings(inputA, artifactA);
        expect(Value.Decode(hydrated.schema, hydrated.defaultSettings)).toEqual({
            value: "value-a",
        });
    });
});
