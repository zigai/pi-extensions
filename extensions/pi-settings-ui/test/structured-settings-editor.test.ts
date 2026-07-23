import { describe, expect, it } from "vitest";

import {
    parseExtensionSettingsSchema,
    type SettingsField,
    type SettingsValueNode,
} from "../src/settings-schema.ts";
import {
    addStructuredEntry,
    buildStructuredRows,
    cycleStructuredVariant,
    removeStructuredEntry,
    renameStructuredMapEntry,
} from "../src/structured-settings-editor.ts";
import { generatedSchemaText } from "./fixture.ts";

function structuredSchema() {
    const parsed = parseExtensionSettingsSchema(
        "pi-structured-edit",
        "/schemas/pi-structured-edit.schema.json",
        generatedSchemaText("pi-structured-edit", {
            entries: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["provider", "models"],
                    properties: {
                        provider: { type: "string", minLength: 1 },
                        models: {
                            type: "array",
                            items: { type: "string", minLength: 1 },
                            minItems: 1,
                        },
                    },
                },
                default: [{ provider: "openai", models: ["gpt-5.6*"] }],
                description: "Provider and model rules.",
            },
            modes: {
                type: "object",
                patternProperties: {
                    "^[a-z][a-z0-9_-]*$": {
                        type: "object",
                        additionalProperties: false,
                        required: ["provider"],
                        properties: {
                            provider: { type: "string", minLength: 1 },
                            enabled: { type: "boolean", default: true },
                        },
                    },
                },
                default: { luna: { provider: "openai", enabled: true } },
                description: "Named modes.",
            },
            flexible: {
                anyOf: [
                    { type: "string", minLength: 1 },
                    { type: "array", items: { type: "string", minLength: 1 } },
                ],
                default: [],
                description: "One value or a list.",
            },
        }),
    );
    if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);
    return parsed.schema;
}

function nodeForField(
    field: SettingsField,
    value: SettingsValueNode["defaultValue"],
): SettingsValueNode {
    return {
        label: field.label,
        description: field.description,
        constraints: field.constraints,
        required: field.required,
        defaultValue: value,
        control: field.control,
    };
}

describe("structured settings editor", () => {
    it("recurses through record lists and adds schema-shaped entries", () => {
        const schema = structuredSchema();
        const field = schema.fields.find((candidate) => candidate.path[0] === "entries");
        if (field === undefined) throw new Error("entries field missing");
        const initial = schema.defaultDocument.entries;
        const rows = buildStructuredRows(nodeForField(field, initial), initial);

        expect(rows.map((row) => row._tag)).toEqual([
            "GroupRow",
            "ValueRow",
            "GroupRow",
            "ValueRow",
            "AddRow",
            "AddRow",
        ]);
        expect(rows.map((row) => row.label)).toContain("Provider");
        expect(rows.map((row) => row.label)).toContain("Models");
        expect(rows[0]).toMatchObject({ _tag: "GroupRow", label: "openai" });

        const add = rows.find((row) => row._tag === "AddRow" && row.containerPath.length === 0);
        if (add?._tag !== "AddRow") throw new Error("outer add row missing");
        const added = addStructuredEntry(initial, add);
        expect(added).toEqual({
            _tag: "StructuredValueChanged",
            value: [
                { provider: "openai", models: ["gpt-5.6*"] },
                { provider: "value", models: ["value"] },
            ],
        });

        if (added._tag !== "StructuredValueChanged") return;
        const addedRows = buildStructuredRows(nodeForField(field, added.value), added.value);
        const removable = addedRows.find((row) => row._tag === "GroupRow" && row.path[0] === 1);
        if (removable?._tag !== "GroupRow") throw new Error("added entry missing");
        expect(removeStructuredEntry(added.value, removable)).toEqual({
            _tag: "StructuredValueChanged",
            value: [{ provider: "openai", models: ["gpt-5.6*"] }],
        });
    });

    it("adds, renames, and removes typed map entries", () => {
        const schema = structuredSchema();
        const field = schema.fields.find((candidate) => candidate.path[0] === "modes");
        if (field === undefined) throw new Error("modes field missing");
        const initial = schema.defaultDocument.modes;
        const rows = buildStructuredRows(nodeForField(field, initial), initial);
        const add = rows.find((row) => row._tag === "AddRow");
        if (add?._tag !== "AddRow") throw new Error("map add row missing");

        const added = addStructuredEntry(initial, add);
        expect(added).toMatchObject({
            _tag: "StructuredValueChanged",
            value: { entry_1: { provider: "value", enabled: true } },
        });
        if (added._tag !== "StructuredValueChanged") return;
        const addedRows = buildStructuredRows(nodeForField(field, added.value), added.value);
        const entry = addedRows.find((row) => row._tag === "GroupRow" && row.label === "entry_1");
        if (entry?._tag !== "GroupRow") throw new Error("map entry missing");
        expect(renameStructuredMapEntry(added.value, entry, "nightly")).toMatchObject({
            _tag: "StructuredValueChanged",
            value: { nightly: { provider: "value", enabled: true } },
        });
    });

    it("switches union variants without exposing the whole field as JSON", () => {
        const schema = structuredSchema();
        const field = schema.fields.find((candidate) => candidate.path[0] === "flexible");
        if (field === undefined) throw new Error("flexible field missing");
        const initial = schema.defaultDocument.flexible;
        const node = nodeForField(field, initial);
        const rows = buildStructuredRows(node, initial);
        const variant = rows.find((row) => row._tag === "VariantRow");
        if (variant?._tag !== "VariantRow") throw new Error("variant row missing");
        expect(variant.variantIndex).toBe(1);
        expect(cycleStructuredVariant(initial, variant, 1)).toEqual({
            _tag: "StructuredValueChanged",
            value: "value",
        });
    });
});
