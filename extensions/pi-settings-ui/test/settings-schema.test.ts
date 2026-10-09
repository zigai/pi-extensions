import { describe, expect, it } from "vitest";

import {
    formatSettingLabel,
    materializeSettingsValue,
    parseExtensionSettingsSchema,
    parseSettingsDocument,
    parseSettingsValue,
} from "../src/settings-schema.ts";
import { generatedSchemaText, richSchemaText } from "./fixture.ts";

describe("extension settings schemas", () => {
    it("turns machine property names into native-style labels", () => {
        expect(formatSettingLabel("initialNaming")).toBe("Initial naming");
        expect(formatSettingLabel("httpIdleTimeoutMs")).toBe("HTTP idle timeout ms");
        expect(formatSettingLabel("provider_ids")).toBe("Provider IDs");
        expect(formatSettingLabel("mcp")).toBe("MCP");
        expect(formatSettingLabel("showUIHints")).toBe("Show UI hints");
    });

    it("maps rich generated schemas to reusable controls", () => {
        const schemaText = richSchemaText();
        const parsed = parseExtensionSettingsSchema(
            "pi-fixture",
            "/agent/extension-settings/schemas/pi-fixture.schema.json",
            schemaText,
        );
        expect(parsed._tag).toBe("ParsedSchema");

        if (parsed._tag === "InvalidSchema") return;

        const controlsByPath = new Map(
            parsed.schema.fields.map((field) => [field.path.join("."), field.control._tag]),
        );
        expect(controlsByPath).toEqual(
            new Map([
                ["enabled", "BooleanControl"],
                ["mode", "ChoiceControl"],
                ["threshold", "NumberControl"],
                ["nested.label", "TextControl"],
                ["nested.visible", "BooleanControl"],
                ["names", "ListControl"],
                ["aliases", "MapControl"],
                ["flexible", "UnionControl"],
                ["fixed", "ReadOnlyControl"],
                ["locked", "ReadOnlyControl"],
            ]),
        );

        expect(
            parsed.schema.fields.find((field) => field.path[0] === "names")?.control,
        ).toMatchObject({
            _tag: "ListControl",
            presentation: { _tag: "StringListPresentation" },
            item: { control: { _tag: "TextControl" } },
        });

        expect(
            parsed.schema.fields.find((field) => field.path[0] === "aliases")?.control,
        ).toMatchObject({
            _tag: "MapControl",
            value: { control: { _tag: "TextControl" } },
        });

        expect(
            parsed.schema.fields.find((field) => field.path[0] === "flexible")?.control,
        ).toMatchObject({
            _tag: "UnionControl",
            variants: [
                { label: "Text", node: { control: { _tag: "TextControl" } } },
                { label: "List", node: { control: { _tag: "ListControl" } } },
            ],
        });

        expect(parsed.schema.defaultDocument).toMatchObject({
            $schema: "./schemas/pi-fixture.schema.json",
            enabled: true,
            mode: "safe",
            threshold: 2,
        });
    });

    it("recognizes grouped string lists for reusable structured presentation", () => {
        const schemaText = generatedSchemaText("pi-grouped", {
            include: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["provider", "models"],
                    properties: {
                        provider: { type: "string" },
                        models: { type: "array", items: { type: "string" } },
                    },
                },
                default: [],
                description: "Provider and model rules.",
            },
        });
        const parsed = parseExtensionSettingsSchema(
            "pi-grouped",
            "/schemas/pi-grouped.schema.json",
            schemaText,
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        expect(parsed.schema.fields[0]?.control).toMatchObject({
            _tag: "ListControl",
            presentation: {
                _tag: "GroupedStringListPresentation",
                groupKey: "provider",
                valuesKey: "models",
            },
        });
    });

    it("recognizes enum-backed string arrays as readable string lists", () => {
        const schemaText = generatedSchemaText("pi-slots", {
            slots: {
                type: "array",
                items: {
                    anyOf: [
                        { const: "cwd", type: "string" },
                        { const: "branch", type: "string" },
                    ],
                },
                default: ["cwd", "branch"],
                description: "Footer slots shown in order.",
            },
        });
        const parsed = parseExtensionSettingsSchema(
            "pi-slots",
            "/schemas/pi-slots.schema.json",
            schemaText,
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        expect(parsed.schema.fields[0]?.control).toMatchObject({
            _tag: "ListControl",
            presentation: { _tag: "StringListPresentation" },
        });
    });

    it("derives useful labels for object-shaped union variants", () => {
        const schemaText = generatedSchemaText("pi-conditions", {
            condition: {
                anyOf: [
                    {
                        type: "object",
                        required: ["all"],
                        properties: {
                            all: { type: "array", items: { type: "boolean" } },
                        },
                        additionalProperties: false,
                    },
                    {
                        type: "object",
                        required: ["fact", "notEquals"],
                        properties: {
                            fact: { type: "string" },
                            notEquals: { type: "string" },
                        },
                        additionalProperties: false,
                    },
                ],
                default: { all: [true] },
                description: "A declarative condition.",
            },
        });
        const parsed = parseExtensionSettingsSchema(
            "pi-conditions",
            "/schemas/pi-conditions.schema.json",
            schemaText,
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        expect(parsed.schema.fields[0]?.control).toMatchObject({
            _tag: "UnionControl",
            variants: [{ label: "All" }, { label: "Not equals" }],
        });
    });

    it("distinguishes inline strings from multiline text areas", () => {
        const schemaText = generatedSchemaText("pi-text-controls", {
            name: { type: "string", description: "A short name." },
            prompt: {
                type: "string",
                default: "First line\nSecond line",
                description: "A multiline prompt.",
            },
            notes: {
                type: "string",
                maxLength: 500,
                description: "Long-form notes.",
            },
            forcedInline: {
                type: "string",
                maxLength: 500,
                "x-control": "text",
                description: "A deliberately single-line value.",
            },
            forcedMultiline: {
                type: "string",
                "x-control": "textarea",
                description: "A deliberately multiline value.",
            },
        });
        const parsed = parseExtensionSettingsSchema(
            "pi-text-controls",
            "/schemas/pi-text-controls.schema.json",
            schemaText,
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        const editors = new Map(
            parsed.schema.fields.map((field) => [
                field.path[0],
                field.control._tag === "TextControl" ? field.control.editor : undefined,
            ]),
        );
        expect(editors).toEqual(
            new Map([
                ["name", "inline"],
                ["prompt", "multiline"],
                ["notes", "multiline"],
                ["forcedInline", "inline"],
                ["forcedMultiline", "multiline"],
            ]),
        );
    });

    it("normalizes every supported x-control hint into a compatible TUI control", () => {
        const schemaText = generatedSchemaText("pi-control-hints", {
            text: { type: "string", "x-control": "text" },
            textarea: { type: "string", "x-control": "textarea" },
            switch: { type: "boolean", "x-control": "switch", default: true },
            segmented: {
                type: "string",
                enum: ["one", "two"],
                "x-control": "segmented",
                default: "one",
            },
            select: {
                type: "string",
                enum: ["one", "two"],
                "x-control": "select",
                default: "one",
            },
            slider: {
                type: "integer",
                minimum: 1,
                maximum: 10,
                "x-control": "slider",
                default: 5,
            },
            numeric: { type: "number", "x-control": "numeric", default: 1.5 },
            color: { type: "string", "x-control": "color", default: "#112233" },
            path: { type: "string", "x-control": "path", default: "./settings.json" },
            combobox: {
                type: "string",
                "x-control": "combobox",
                examples: ["accent", "warning"],
                default: "accent",
            },
            jsonEditor: {
                type: "object",
                "x-control": "json-editor",
                additionalProperties: false,
                default: {},
                properties: { name: { type: "string" } },
            },
        });
        const parsed = parseExtensionSettingsSchema(
            "pi-control-hints",
            "/schemas/pi-control-hints.schema.json",
            schemaText,
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        const controls = new Map(
            parsed.schema.fields.map((field) => [field.path.join("."), field.control]),
        );
        expect(controls.get("text")).toMatchObject({
            _tag: "TextControl",
            editor: "inline",
            presentation: "text",
        });

        expect(controls.get("textarea")).toMatchObject({
            _tag: "TextControl",
            editor: "multiline",
            presentation: "textarea",
        });

        expect(controls.get("switch")).toMatchObject({ _tag: "BooleanControl" });
        expect(controls.get("segmented")).toMatchObject({
            _tag: "ChoiceControl",
            presentation: "segmented",
        });

        expect(controls.get("select")).toMatchObject({
            _tag: "ChoiceControl",
            presentation: "select",
        });

        expect(controls.get("slider")).toMatchObject({
            _tag: "NumberControl",
            presentation: "slider",
            minimum: 1,
            maximum: 10,
        });

        expect(controls.get("numeric")).toMatchObject({
            _tag: "NumberControl",
            presentation: "numeric",
        });

        expect(controls.get("color")).toMatchObject({
            _tag: "TextControl",
            presentation: "color",
        });

        expect(controls.get("path")).toMatchObject({
            _tag: "TextControl",
            presentation: "path",
        });

        expect(controls.get("combobox")).toMatchObject({
            _tag: "TextControl",
            presentation: "combobox",
            suggestions: ["accent", "warning"],
        });

        expect(controls.get("jsonEditor")).toMatchObject({ _tag: "JsonControl" });
        expect(controls.has("jsonEditor.name")).toBe(false);
    });

    it("uses combobox metadata for string-only unions with known and custom values", () => {
        const schemaText = generatedSchemaText("pi-combobox-union", {
            slot: {
                anyOf: [
                    {
                        anyOf: [
                            { type: "string", const: "path" },
                            { type: "string", const: "branch" },
                        ],
                    },
                    { type: "string", pattern: "^[a-z]+\\.[a-z]+$" },
                ],
                "x-control": "combobox",
                examples: ["path", "branch"],
                default: "path",
                description: "Built-in or custom slot ID.",
            },
        });
        const parsed = parseExtensionSettingsSchema(
            "pi-combobox-union",
            "/schemas/pi-combobox-union.schema.json",
            schemaText,
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        expect(parsed.schema.fields[0]?.control).toMatchObject({
            _tag: "TextControl",
            editor: "inline",
            presentation: "combobox",
            suggestions: ["path", "branch"],
        });
        const field = parsed.schema.fields[0];
        if (field === undefined) throw new Error("Missing combobox union field.");

        expect(
            materializeSettingsValue({
                label: field.label,
                description: field.description,
                constraints: field.constraints,
                required: field.required,
                defaultValue: undefined,
                control: field.control,
            }),
        ).toBe("path");
    });

    it("infers segmented choices, searchable selects, and bounded sliders", () => {
        const schemaText = generatedSchemaText("pi-inferred-controls", {
            compactChoice: { type: "string", enum: ["one", "two"], default: "one" },
            longChoice: {
                type: "string",
                enum: ["one", "two", "three", "four", "five", "six", "seven"],
                default: "one",
            },
            boundedNumber: {
                type: "number",
                minimum: 0,
                maximum: 1,
                default: 0.5,
            },
        });
        const parsed = parseExtensionSettingsSchema(
            "pi-inferred-controls",
            "/schemas/pi-inferred-controls.schema.json",
            schemaText,
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        expect(parsed.schema.fields[0]?.control).toMatchObject({ presentation: "segmented" });
        expect(parsed.schema.fields[1]?.control).toMatchObject({ presentation: "select" });
        expect(parsed.schema.fields[2]?.control).toMatchObject({ presentation: "slider" });
    });

    it("preserves titled x-controls inside mixed union variants", () => {
        const schemaText = generatedSchemaText("pi-color-union", {
            color: {
                anyOf: [
                    {
                        title: "Theme color",
                        "x-control": "select",
                        anyOf: [
                            { type: "string", const: "accent" },
                            { type: "string", const: "warning" },
                        ],
                    },
                    {
                        title: "ANSI 256 color",
                        type: "integer",
                        minimum: 0,
                        maximum: 255,
                        "x-control": "slider",
                    },
                    {
                        title: "Hex color",
                        type: "string",
                        pattern: "^#[0-9a-fA-F]{6}$",
                        "x-control": "color",
                    },
                ],
                default: 117,
                description: "A color in one of several representations.",
            },
        });
        const parsed = parseExtensionSettingsSchema(
            "pi-color-union",
            "/schemas/pi-color-union.schema.json",
            schemaText,
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        expect(parsed.schema.fields[0]?.control).toMatchObject({
            _tag: "UnionControl",
            variants: [
                {
                    label: "Theme color",
                    node: { control: { _tag: "ChoiceControl", presentation: "select" } },
                },
                {
                    label: "ANSI 256 color",
                    node: { control: { _tag: "NumberControl", presentation: "slider" } },
                },
                {
                    label: "Hex color",
                    node: { control: { _tag: "TextControl", presentation: "color" } },
                },
            ],
        });
    });

    it("removes a redundant extension-name prefix from field labels", () => {
        const schemaText = generatedSchemaText(
            "pi-tree",
            {
                treeTimestampMode: {
                    type: "string",
                    default: "relative",
                    description: "Timestamp style shown in tree entries.",
                },
            },
            "Pi Tree settings",
        );
        const parsed = parseExtensionSettingsSchema(
            "pi-tree",
            "/schemas/pi-tree.schema.json",
            schemaText,
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        expect(parsed.schema.fields[0]?.label).toBe("Timestamp mode");
    });

    it("extracts conditional sibling defaults from JSON Schema", () => {
        // oxlint-disable-next-line unicorn/no-thenable -- This is the JSON Schema consequence keyword.
        const consequenceKeyword = "then";
        const schemaText = generatedSchemaText("pi-dependent", {
            naming: {
                type: "object",
                additionalProperties: false,
                default: { trigger: "messages", threshold: 1 },
                properties: {
                    trigger: {
                        type: "string",
                        enum: ["messages", "tokens"],
                        default: "messages",
                        description: "Activity trigger.",
                    },
                    threshold: {
                        type: "number",
                        minimum: 1,
                        default: 1,
                        description: "Activity threshold.",
                    },
                },
                allOf: [
                    {
                        if: {
                            properties: { trigger: { const: "messages" } },
                            required: ["trigger"],
                        },
                        [consequenceKeyword]: { properties: { threshold: { default: 1 } } },
                    },
                    {
                        if: {
                            properties: { trigger: { const: "tokens" } },
                            required: ["trigger"],
                        },
                        [consequenceKeyword]: { properties: { threshold: { default: 1000 } } },
                    },
                ],
            },
        });
        const parsed = parseExtensionSettingsSchema(
            "pi-dependent",
            "/schemas/pi-dependent.schema.json",
            schemaText,
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        expect(
            parsed.schema.fields.find((field) => field.path.join(".") === "naming.trigger")
                ?.choiceDefaults,
        ).toEqual([
            { choice: "messages", siblingValues: { threshold: 1 } },
            { choice: "tokens", siblingValues: { threshold: 1000 } },
        ]);
    });

    it("requires the generated extension-settings marker", () => {
        const schemaText = generatedSchemaText("pi-fixture", {}).replace(
            "JSON Schema used by editors for this settings file.",
            "Different metadata.",
        );
        const parsed = parseExtensionSettingsSchema(
            "pi-fixture",
            "/schemas/pi-fixture.schema.json",
            schemaText,
        );
        expect(parsed).toMatchObject({ _tag: "InvalidSchema" });
    });

    it("retains required versus optional field state when a schema declares it", () => {
        const schemaText = generatedSchemaText(
            "pi-required",
            {
                enabled: {
                    type: "boolean",
                    default: true,
                    description: "Enable the required fixture.",
                },
                label: { type: "string", description: "Optional fixture label." },
            },
            "Required Fixture settings",
            ["enabled"],
        );
        const parsed = parseExtensionSettingsSchema(
            "pi-required",
            "/schemas/pi-required.schema.json",
            schemaText,
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        expect(parsed.schema.fields.map((field) => [field.path[0], field.required])).toEqual([
            ["enabled", true],
            ["label", false],
        ]);
    });

    it("validates persisted documents without trusting JSON.parse output", () => {
        const parsedSchema = parseExtensionSettingsSchema(
            "pi-fixture",
            "/schemas/pi-fixture.schema.json",
            richSchemaText(),
        );
        if (parsedSchema._tag === "InvalidSchema") throw new Error(parsedSchema.message);

        expect(
            parseSettingsDocument(
                parsedSchema.schema,
                '{"$schema":"./schemas/pi-fixture.schema.json","threshold":3}',
            ),
        ).toMatchObject({ _tag: "ParsedDocument" });

        expect(parseSettingsDocument(parsedSchema.schema, '{"threshold":0}')).toMatchObject({
            _tag: "InvalidDocument",
            issues: [expect.stringContaining("/threshold")],
        });

        expect(parseSettingsDocument(parsedSchema.schema, "{")).toMatchObject({
            _tag: "InvalidDocument",
            message: "Settings contain malformed JSON.",
        });
    });

    it("accepts only JSON values from structured controls", () => {
        expect(parseSettingsValue('{"name":"value"}')).toEqual({
            _tag: "ParsedValue",
            value: { name: "value" },
        });

        expect(parseSettingsValue("undefined")).toEqual({
            _tag: "InvalidValue",
            message: "Enter a valid JSON value.",
        });
    });
});
