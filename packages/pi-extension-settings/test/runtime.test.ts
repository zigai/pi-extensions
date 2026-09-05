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

    it.each([false, true])(
        "leaves caller-owned codecs mutable (custom prototypes: %s)",
        (customPrototypes) => {
            class CodecOwner {
                label = "original";
            }
            const owner = new CodecOwner();
            const decode = Object.assign((value: string) => value.toUpperCase(), {
                metadata: { calls: 0 },
            });
            const encode = (value: string) => value.toLowerCase();
            const codecInput = {
                id: "codec-ownership",
                title: "Codec Ownership",
                description: "Caller-owned codec functions.",
                schema: Type.Object(
                    {
                        value: Type.Codec(Type.String({ default: "hello", description: "Value." }))
                            .Decode(decode)
                            .Encode(encode),
                    },
                    { additionalProperties: false },
                ),
            };
            Object.defineProperty(codecInput.schema, "~owner", { value: owner });
            const artifact = createPrevalidatedExtensionSettingsArtifact(
                defineExtensionSettings(codecInput),
            );
            // Function identity, not its prototype, determines whether the clone owns it.
            if (customPrototypes) {
                Object.setPrototypeOf(decode, null);
                Object.setPrototypeOf(encode, Object.prototype);
            }
            const hydrated = definePrevalidatedExtensionSettings(codecInput, artifact);

            expect(Object.isFrozen(decode)).toBe(false);
            expect(Object.isFrozen(encode)).toBe(false);
            expect(Object.isFrozen(decode.metadata)).toBe(false);
            expect(Object.getOwnPropertyDescriptor(hydrated.schema, "~owner")?.value).toBe(owner);
            expect(Object.isFrozen(owner)).toBe(false);
            owner.label = "updated";
            expect(owner.label).toBe("updated");
            decode.metadata.calls += 1;
            expect(decode.metadata.calls).toBe(1);
            expect(Object.isFrozen(hydrated.schema)).toBe(true);
            expect(Object.isFrozen(hydrated.schema.properties.value)).toBe(true);
            expect(Object.isFrozen(hydrated.defaultSettings)).toBe(true);
            expect(Value.Decode(hydrated.schema, hydrated.defaultSettings)).toEqual({
                value: "HELLO",
            });
            expect(Value.Encode(hydrated.schema, { value: "HELLO" })).toEqual({ value: "hello" });
        },
    );

    it("freezes copied arrays and their shared records without freezing artifact data", () => {
        const authoringInput = {
            id: "array-ownership",
            title: "Array Ownership",
            description: "Copied JSON settings.",
            schema: Type.Object(
                {
                    labels: Type.Array(
                        Type.Object(
                            { value: Type.String() },
                            { additionalProperties: false, title: "Label" },
                        ),
                        {
                            default: [{ value: "label" }, { value: "label" }],
                            description: "Labels.",
                        },
                    ),
                },
                { additionalProperties: false },
            ),
        };
        const generated = createPrevalidatedExtensionSettingsArtifact(
            defineExtensionSettings(authoringInput),
        );
        const label = { value: "label" };
        const artifact = { ...generated, defaultSettings: { labels: [label, label] } };
        const hydrated = definePrevalidatedExtensionSettings(authoringInput, artifact);
        const defaults = hydrated.defaultSettings;
        if (!Value.Check(authoringInput.schema, defaults))
            throw new Error("Invalid hydrated defaults");
        expect(Object.isFrozen(defaults.labels)).toBe(true);
        expect(defaults.labels[0]).toBe(defaults.labels[1]);
        for (const entry of defaults.labels) {
            expect(Object.isFrozen(entry)).toBe(true);
            expect(Reflect.set(entry, "value", "changed")).toBe(false);
        }
        expect(Reflect.set(defaults.labels, "0", { value: "changed" })).toBe(false);
        expect(Object.isFrozen(artifact.defaultSettings.labels)).toBe(false);
        expect(Object.isFrozen(label)).toBe(false);
        expect(defaults).toEqual({ labels: [{ value: "label" }, { value: "label" }] });
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

    it("uses current codecs without comparing function text at runtime", () => {
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
        // The runtime uses the supplied codecs; source-text drift belongs to artifact checking.
        const hydratedB = definePrevalidatedExtensionSettings(inputB, artifactA);
        expect(Value.Decode(hydratedB.schema, hydratedB.defaultSettings)).toEqual({
            value: "value-b",
        });
        expect(Value.Decode(inputA.schema, defaults)).toEqual({ value: "value-a" });
        const hydrated = definePrevalidatedExtensionSettings(inputA, artifactA);
        expect(Value.Decode(hydrated.schema, hydrated.defaultSettings)).toEqual({
            value: "value-a",
        });
    });
});
