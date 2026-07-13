import { describe, expect, it } from "vitest";
import { Decode, Type } from "typebox";

import {
    defineExtensionSettings,
    InvalidSettingsDefinition,
    isExtensionSettingsDefinition,
} from "../src/definition.ts";
import { isJsonObject } from "../src/json-value.ts";
import { createDefaultSettingsDocument, createSettingsFileSchema } from "../src/schema-document.ts";
import { testDefinition } from "./fixture.ts";

type MetadataOverride = {
    readonly id?: string;
    readonly title?: string;
    readonly description?: string;
    readonly schemaId?: string;
};

const invalidMetadataCases: ReadonlyArray<readonly [string, MetadataOverride, string]> = [
    ["invalid id", { id: "Bad ID" }, "id must be"],
    ["blank title", { title: "  " }, "title must not be blank"],
    ["blank description", { description: "" }, "description must not be blank"],
    ["relative schema id", { schemaId: "config.schema.json" }, "absolute URI"],
];

describe("defineExtensionSettings", () => {
    it("derives and validates nested defaults", () => {
        const definition = testDefinition();

        expect(definition.defaultSettings).toEqual({
            enabled: true,
            mode: "compact",
            appearance: { color: "blue", opacity: 0.8 },
            tools: ["read"],
        });
        expect(isExtensionSettingsDefinition(definition)).toBe(true);
        expect(isExtensionSettingsDefinition({ id: "pi-example" })).toBe(false);
        expect(Object.isFrozen(definition)).toBe(true);
        expect(Object.isFrozen(definition.schema)).toBe(true);
        expect(Object.isFrozen(definition.schema.properties.appearance)).toBe(true);
        expect(Object.isFrozen(definition.defaultSettings.appearance)).toBe(true);
    });

    it("rejects structurally invalid marked definition values", () => {
        const valid = testDefinition();
        const marker = Object.getOwnPropertySymbols(valid)[0];
        if (marker === undefined) throw new Error("definition marker is missing");
        const definitionMarker = marker;

        function marked(fields: Record<string, unknown>): Record<string | symbol, unknown> {
            return { ...fields, [definitionMarker]: true };
        }

        expect(isExtensionSettingsDefinition(marked({}))).toBe(false);
        expect(isExtensionSettingsDefinition(marked({ id: "Bad ID" }))).toBe(false);
        expect(isExtensionSettingsDefinition(marked({ id: "pi-fake" }))).toBe(false);
        expect(isExtensionSettingsDefinition(marked({ id: "pi-fake", title: "Fake" }))).toBe(false);
        expect(
            isExtensionSettingsDefinition(
                marked({ id: "pi-fake", title: "Fake", description: "Fake settings." }),
            ),
        ).toBe(false);
        expect(
            isExtensionSettingsDefinition(
                marked({
                    id: "pi-fake",
                    title: "Fake",
                    description: "Fake settings.",
                    schemaId: "urn:fake",
                    schema: {},
                    defaultSettings: {},
                }),
            ),
        ).toBe(false);
        expect(
            isExtensionSettingsDefinition(
                marked({
                    id: "pi-fake",
                    title: "Fake",
                    description: "Fake settings.",
                    schemaId: "urn:fake",
                    schema: valid.schema,
                    defaultSettings: "invalid",
                }),
            ),
        ).toBe(false);
    });

    it("snapshots the caller-owned TypeBox schema before freezing it", () => {
        const schema = Type.Object(
            {
                enabled: Type.Boolean({ default: true, description: "Enable it." }),
            },
            { additionalProperties: false },
        );
        const definition = defineExtensionSettings({
            id: "pi-owned",
            title: "Owned",
            description: "Ownership settings.",
            schema,
        });

        expect(definition.schema).not.toBe(schema);
        expect(Object.isFrozen(schema)).toBe(false);
        expect(Object.isFrozen(definition.schema)).toBe(true);
    });

    it.each(invalidMetadataCases)("rejects %s", (_label, override, expected) => {
        const valid = testDefinition();
        expect(() =>
            defineExtensionSettings({
                id: override.id ?? valid.id,
                title: override.title ?? valid.title,
                description: override.description ?? valid.description,
                schemaId: override.schemaId ?? valid.schemaId,
                schema: valid.schema,
            }),
        ).toThrowError(expected);
    });

    it("rejects permissive nested objects", () => {
        expect(() =>
            defineExtensionSettings({
                id: "pi-invalid",
                title: "Invalid",
                description: "Invalid settings.",
                schema: Type.Object({
                    nested: Type.Object(
                        {
                            value: Type.String({ default: "x", description: "A value." }),
                        },
                        { default: {} },
                    ),
                }),
            }),
        ).toThrowError(/additionalProperties/);
    });

    it("rejects a user setting that collides with $schema metadata", () => {
        expect(() =>
            defineExtensionSettings({
                id: "pi-invalid",
                title: "Invalid",
                description: "Invalid settings.",
                schema: Type.Object(
                    {
                        $schema: Type.String({
                            default: "custom",
                            description: "Invalid reserved setting.",
                        }),
                    },
                    { additionalProperties: false },
                ),
            }),
        ).toThrowError(/reserved/);
    });

    it("rejects undocumented settings", () => {
        expect(() =>
            defineExtensionSettings({
                id: "pi-invalid",
                title: "Invalid",
                description: "Invalid settings.",
                schema: Type.Object(
                    { value: Type.String({ default: "x" }) },
                    { additionalProperties: false },
                ),
            }),
        ).toThrowError(/descriptions: value/);
    });

    it("rejects required settings without defaults", () => {
        expect(() =>
            defineExtensionSettings({
                id: "pi-invalid",
                title: "Invalid",
                description: "Invalid settings.",
                schema: Type.Object(
                    { value: Type.String({ description: "A value." }) },
                    { additionalProperties: false },
                ),
            }),
        ).toThrowError(InvalidSettingsDefinition);
    });

    it("rejects defaults that are not JSON data", () => {
        expect(() =>
            defineExtensionSettings({
                id: "pi-invalid",
                title: "Invalid",
                description: "Invalid settings.",
                schema: Type.Object(
                    {
                        value: Type.Any({
                            default: new Date("2026-01-01T00:00:00Z"),
                            description: "A non-JSON value.",
                        }),
                    },
                    { additionalProperties: false },
                ),
            }),
        ).toThrowError(/JSON object/);
    });

    it("rejects defaults that a codec cannot decode", () => {
        expect(() =>
            defineExtensionSettings({
                id: "pi-invalid",
                title: "Invalid",
                description: "Invalid settings.",
                schema: Type.Object(
                    {
                        value: Decode(
                            Type.String({ default: "x", description: "A decoded value." }),
                            () => {
                                throw new Error("decode failed");
                            },
                        ),
                    },
                    { additionalProperties: false },
                ),
            }),
        ).toThrowError(/could not be decoded/);
    });
});

describe("generated schema documents", () => {
    it("creates a deeply partial strict settings-file schema", () => {
        const schema = createSettingsFileSchema(testDefinition());

        expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
        expect(schema.$id).toBe("https://example.test/pi-example/config.schema.json");
        expect(schema.required).toBeUndefined();
        expect(schema.additionalProperties).toBe(false);
        expect(JSON.stringify(schema)).not.toContain('"~kind"');
        expect(JSON.stringify(schema)).not.toContain('"~optional"');
        expect(schema.properties).toMatchObject({
            $schema: { default: "./schemas/pi-example.schema.json" },
            enabled: { default: true },
            appearance: {
                additionalProperties: false,
                properties: {
                    color: { default: "blue" },
                    opacity: { default: 0.8 },
                },
            },
        });
        expect(isJsonObject(schema.properties)).toBe(true);
        if (!isJsonObject(schema.properties)) return;
        expect(isJsonObject(schema.properties.appearance)).toBe(true);
        if (!isJsonObject(schema.properties.appearance)) return;
        expect(schema.properties.appearance.required).toBeUndefined();
    });

    it("preserves required constraints in semantic subschemas", () => {
        const definition = defineExtensionSettings({
            id: "pi-conditional",
            title: "Conditional",
            description: "Conditional settings.",
            schema: Type.Object(
                {
                    current: Type.String({ default: "yes", description: "Current value." }),
                },
                {
                    additionalProperties: false,
                    not: Type.Object({ legacy: Type.String() }, { additionalProperties: false }),
                },
            ),
        });

        const schema = createSettingsFileSchema(definition);
        expect(isJsonObject(schema.not)).toBe(true);
        if (!isJsonObject(schema.not)) return;
        expect(schema.not.required).toEqual(["legacy"]);
    });

    it("creates the exact scaffolded global document", () => {
        expect(createDefaultSettingsDocument(testDefinition())).toEqual({
            $schema: "./schemas/pi-example.schema.json",
            enabled: true,
            mode: "compact",
            appearance: { color: "blue", opacity: 0.8 },
            tools: ["read"],
        });
    });
});
