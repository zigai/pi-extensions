import { IsSchema, Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const SETTINGS_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SETTINGS_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const NO_DEFAULT = Symbol("no-default");
const SETTINGS_CONTROL_HINTS = [
    "text",
    "textarea",
    "switch",
    "segmented",
    "select",
    "slider",
    "numeric",
    "color",
    "path",
    "combobox",
    "json-editor",
] as const;

const schemaObjectBoundary = Type.Record(Type.String(), Type.Unknown());
const schemaDocumentBoundary = Type.Object(
    {
        $schema: Type.Literal(SETTINGS_SCHEMA_DIALECT),
        $id: Type.String({ minLength: 1 }),
        title: Type.String({ minLength: 1 }),
        description: Type.String({ minLength: 1 }),
        type: Type.Literal("object"),
        additionalProperties: Type.Literal(false),
        properties: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: true },
);

type SchemaObject = Static<typeof schemaObjectBoundary>;
type SchemaDocument = Static<typeof schemaDocumentBoundary>;
type SettingsControlHint = (typeof SETTINGS_CONTROL_HINTS)[number];

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export type SettingsValueNode = {
    readonly label: string;
    readonly description: string;
    readonly constraints: string;
    readonly required: boolean;
    readonly defaultValue: JsonValue | undefined;
    readonly control: SettingsControl;
};

export type SettingsControl =
    | { readonly _tag: "BooleanControl" }
    | {
          readonly _tag: "ChoiceControl";
          readonly choices: readonly JsonPrimitive[];
          readonly presentation: "combobox" | "segmented" | "select";
      }
    | { readonly _tag: "JsonControl"; readonly expected: string }
    | {
          readonly _tag: "ListControl";
          readonly expected: string;
          readonly presentation:
              | { readonly _tag: "GenericListPresentation" }
              | {
                    readonly _tag: "GroupedStringListPresentation";
                    readonly groupKey: string;
                    readonly valuesKey: string;
                }
              | { readonly _tag: "StringListPresentation" };
          readonly item: SettingsValueNode;
          readonly minItems: number;
          readonly maxItems: number | undefined;
      }
    | {
          readonly _tag: "MapControl";
          readonly value: SettingsValueNode;
          readonly keyPattern: string | undefined;
      }
    | { readonly _tag: "NullControl" }
    | {
          readonly _tag: "NumberControl";
          readonly presentation: "numeric" | "slider";
          readonly integer: boolean;
          readonly minimum: number | undefined;
          readonly exclusiveMinimum: number | undefined;
          readonly maximum: number | undefined;
          readonly exclusiveMaximum: number | undefined;
          readonly multipleOf: number | undefined;
      }
    | {
          readonly _tag: "ObjectControl";
          readonly properties: readonly {
              readonly key: string;
              readonly node: SettingsValueNode;
          }[];
      }
    | {
          readonly _tag: "ReadOnlyControl";
          readonly reason: string;
          readonly fixedValue: JsonPrimitive | undefined;
      }
    | {
          readonly _tag: "TextControl";
          readonly editor: "inline" | "multiline";
          readonly presentation: "color" | "combobox" | "path" | "text" | "textarea";
          readonly suggestions: readonly string[];
          readonly minLength: number;
      }
    | {
          readonly _tag: "UnionControl";
          readonly variants: readonly {
              readonly label: string;
              readonly node: SettingsValueNode;
          }[];
      };

export type SettingsField = {
    readonly path: readonly string[];
    readonly label: string;
    readonly description: string;
    readonly constraints: string;
    readonly required: boolean;
    readonly control: SettingsControl;
    readonly choiceDefaults: readonly {
        readonly choice: JsonPrimitive;
        readonly siblingValues: JsonObject;
    }[];
};

export type ExtensionSettingsSchema = {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly schemaPath: string;
    readonly schemaText: string;
    readonly schemaReference: string;
    readonly schema: TSchema;
    readonly defaultDocument: JsonObject;
    readonly fields: readonly SettingsField[];
};

export type ParseExtensionSchemaOutcome =
    | { readonly _tag: "InvalidSchema"; readonly message: string }
    | { readonly _tag: "ParsedSchema"; readonly schema: ExtensionSettingsSchema };

export type ParseSettingsDocumentOutcome =
    | {
          readonly _tag: "InvalidDocument";
          readonly message: string;
          readonly issues: readonly string[];
      }
    | { readonly _tag: "ParsedDocument"; readonly document: JsonObject };

export type ParseSettingsValueOutcome =
    | { readonly _tag: "InvalidValue"; readonly message: string }
    | { readonly _tag: "ParsedValue"; readonly value: JsonValue };

function parseSchemaObject(value: unknown): SchemaObject | undefined {
    if (!Value.Check(schemaObjectBoundary, value)) return undefined;
    return Value.Decode(schemaObjectBoundary, value);
}

function isJsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return true;
    }
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    if (value === null || typeof value !== "object") return false;
    return Object.values(value).every(isJsonValue);
}

function isJsonObjectValue(value: unknown): value is JsonObject {
    return (
        isJsonValue(value) && value !== null && typeof value === "object" && !Array.isArray(value)
    );
}

function parseJsonObject(value: unknown): JsonObject | undefined {
    if (!Value.Check(schemaObjectBoundary, value)) return undefined;
    const decoded: unknown = Value.Decode(schemaObjectBoundary, value);
    return isJsonObjectValue(decoded) ? decoded : undefined;
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
    return (
        value === null ||
        typeof value === "boolean" ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))
    );
}

function parseJsonText(text: string): unknown {
    try {
        const parsed: unknown = JSON.parse(text);
        return parsed;
    } catch {
        return undefined;
    }
}

function schemaDescription(schema: SchemaObject, fallback: string): string {
    return typeof schema.description === "string" && schema.description.trim() !== ""
        ? schema.description
        : fallback;
}

const SETTING_LABEL_ACRONYMS: Readonly<Record<string, string>> = {
    api: "API",
    cpu: "CPU",
    cwd: "CWD",
    gpu: "GPU",
    html: "HTML",
    http: "HTTP",
    https: "HTTPS",
    id: "ID",
    ids: "IDs",
    json: "JSON",
    llm: "LLM",
    mcp: "MCP",
    npm: "npm",
    oauth: "OAuth",
    rgb: "RGB",
    sdk: "SDK",
    ssh: "SSH",
    ssl: "SSL",
    tls: "TLS",
    tui: "TUI",
    ui: "UI",
    uri: "URI",
    url: "URL",
    urls: "URLs",
    yaml: "YAML",
};

/** Turn a JSON property name into the sentence-style labels used by Pi settings. */
export function formatSettingLabel(value: string): string {
    const words = value
        .trim()
        .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replaceAll(/[-_.]+/g, " ")
        .split(/\s+/)
        .filter((word) => word !== "");
    return words
        .map((word, index) => {
            const lower = word.toLowerCase();
            const acronym = SETTING_LABEL_ACRONYMS[lower];
            if (acronym !== undefined) return acronym;
            return index === 0 ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : lower;
        })
        .join(" ");
}

function schemaTitle(schema: SchemaObject, key: string): string {
    if (typeof schema.title === "string" && schema.title.trim() !== "") {
        const title = schema.title.trim();
        return title === key || !title.includes(" ") ? formatSettingLabel(title) : title;
    }
    return formatSettingLabel(key);
}

function schemaArray(schema: SchemaObject, key: string): readonly unknown[] | undefined {
    const value = schema[key];
    return Array.isArray(value) ? value : undefined;
}

function resolveJsonPointer(root: SchemaObject, reference: string): unknown {
    if (!reference.startsWith("#/")) return undefined;
    let current: unknown = root;
    for (const encodedSegment of reference.slice(2).split("/")) {
        const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
        const object = parseSchemaObject(current);
        if (object === undefined || !(segment in object)) return undefined;
        current = object[segment];
    }
    return current;
}

function findSchemaById(value: unknown, id: string, depth = 0): unknown {
    if (depth > 64) return undefined;
    if (Array.isArray(value)) {
        for (const child of value) {
            const match = findSchemaById(child, id, depth + 1);
            if (match !== undefined) return match;
        }
        return undefined;
    }
    const object = parseSchemaObject(value);
    if (object === undefined) return undefined;
    if (object.$id === id) return object;
    for (const child of Object.values(object)) {
        const match = findSchemaById(child, id, depth + 1);
        if (match !== undefined) return match;
    }
    return undefined;
}

function resolveSchemaReference(root: SchemaObject, reference: string): unknown {
    return reference.startsWith("#/")
        ? resolveJsonPointer(root, reference)
        : findSchemaById(root, reference);
}

function resolveSchemaNode(
    root: SchemaObject,
    value: unknown,
    references: ReadonlySet<string> = new Set(),
): unknown {
    const schema = parseSchemaObject(value);
    if (schema === undefined) return typeof value === "boolean" ? value : undefined;
    if (typeof schema.$ref !== "string") return schema;
    if (references.has(schema.$ref)) return undefined;
    const target = resolveSchemaReference(root, schema.$ref);
    if (target === undefined) return undefined;
    return resolveSchemaNode(root, target, new Set([...references, schema.$ref]));
}

function choiceValues(root: SchemaObject, value: unknown): readonly JsonPrimitive[] | undefined {
    const resolved = resolveSchemaNode(root, value);
    const schema = parseSchemaObject(resolved);
    if (schema === undefined) return undefined;
    if (isJsonPrimitive(schema.const)) return [schema.const];

    const enumeration = schemaArray(schema, "enum");
    if (enumeration !== undefined && enumeration.every(isJsonPrimitive)) {
        return enumeration;
    }

    const branches = schemaArray(schema, "anyOf") ?? schemaArray(schema, "oneOf");
    if (branches === undefined || branches.length === 0) return undefined;
    const choices: JsonPrimitive[] = [];
    for (const branch of branches) {
        const branchChoices = choiceValues(root, branch);
        if (branchChoices === undefined) return undefined;
        for (const choice of branchChoices) {
            if (!choices.some((candidate) => Object.is(candidate, choice))) choices.push(choice);
        }
    }
    return choices;
}

function constraintSummary(schema: SchemaObject): string {
    const constraints: string[] = [];
    const labels: ReadonlyArray<readonly [string, string]> = [
        ["minimum", "min"],
        ["exclusiveMinimum", ">"],
        ["maximum", "max"],
        ["exclusiveMaximum", "<"],
        ["multipleOf", "step"],
        ["minLength", "min length"],
        ["maxLength", "max length"],
        ["minItems", "min items"],
        ["maxItems", "max items"],
        ["format", "format"],
    ];
    for (const [key, label] of labels) {
        const value = schema[key];
        if (typeof value === "number" || typeof value === "string") {
            constraints.push(`${label}: ${String(value)}`);
        }
    }
    if (typeof schema.pattern === "string") constraints.push(`pattern: ${schema.pattern}`);
    if (schema.uniqueItems === true) constraints.push("unique items");
    return constraints.join(" • ");
}

function resolvedSchemaObject(root: SchemaObject, value: unknown): SchemaObject | undefined {
    return parseSchemaObject(resolveSchemaNode(root, value));
}

function isStringValueSchema(root: SchemaObject, value: unknown): boolean {
    if (resolvedSchemaObject(root, value)?.type === "string") return true;
    const choices = choiceValues(root, value);
    return (
        choices !== undefined &&
        choices.length > 0 &&
        choices.every((choice) => typeof choice === "string")
    );
}

function isStringArraySchema(root: SchemaObject, value: unknown): boolean {
    const schema = resolvedSchemaObject(root, value);
    return schema?.type === "array" && isStringValueSchema(root, schema.items);
}

function fixedObjectProperties(
    root: SchemaObject,
    value: unknown,
): Readonly<Record<string, unknown>> | undefined {
    const resolved = resolveSchemaNode(root, value);
    const schema = parseSchemaObject(resolved);
    if (schema === undefined || schema.type !== "object") return undefined;
    if (parseSchemaObject(schema.patternProperties) !== undefined) return undefined;
    const properties = parseSchemaObject(schema.properties);
    return properties;
}

function conditionalChoiceDefaults(
    root: SchemaObject,
    parentSchema: SchemaObject,
    propertyKey: string,
): SettingsField["choiceDefaults"] {
    const defaults = new Map<JsonPrimitive, Record<string, JsonValue>>();
    for (const rawBranch of schemaArray(parentSchema, "allOf") ?? []) {
        const branch = resolvedSchemaObject(root, rawBranch);
        const condition = resolvedSchemaObject(root, branch?.if);
        const conditionProperties = parseSchemaObject(condition?.properties);
        const conditionProperty = resolvedSchemaObject(root, conditionProperties?.[propertyKey]);
        if (conditionProperty === undefined || !isJsonPrimitive(conditionProperty.const)) continue;

        const consequence = resolvedSchemaObject(root, branch?.then);
        const consequenceProperties = parseSchemaObject(consequence?.properties);
        if (consequenceProperties === undefined) continue;
        const siblingValues = defaults.get(conditionProperty.const) ?? {};
        for (const [key, rawProperty] of Object.entries(consequenceProperties)) {
            if (key === propertyKey) continue;
            const property = resolvedSchemaObject(root, rawProperty);
            if (property !== undefined && isJsonValue(property.default)) {
                siblingValues[key] = structuredClone(property.default);
            }
        }
        if (Object.keys(siblingValues).length > 0) {
            defaults.set(conditionProperty.const, siblingValues);
        }
    }
    return [...defaults].map(([choice, siblingValues]) => ({ choice, siblingValues }));
}

function listPresentation(
    root: SchemaObject,
    schema: SchemaObject,
): Extract<SettingsControl, { readonly _tag: "ListControl" }>["presentation"] {
    const itemSchema = resolvedSchemaObject(root, schema.items);
    if (itemSchema !== undefined && isStringValueSchema(root, itemSchema)) {
        return { _tag: "StringListPresentation" };
    }
    if (itemSchema?.type !== "object") return { _tag: "GenericListPresentation" };

    const properties = fixedObjectProperties(root, itemSchema);
    if (properties === undefined || Object.keys(properties).length !== 2) {
        return { _tag: "GenericListPresentation" };
    }
    const groupKeys = Object.entries(properties)
        .filter(([, property]) => resolvedSchemaObject(root, property)?.type === "string")
        .map(([key]) => key);
    const valuesKeys = Object.entries(properties)
        .filter(([, property]) => isStringArraySchema(root, property))
        .map(([key]) => key);
    const groupKey = groupKeys[0];
    const valuesKey = valuesKeys[0];
    if (
        groupKeys.length !== 1 ||
        valuesKeys.length !== 1 ||
        groupKey === undefined ||
        valuesKey === undefined
    ) {
        return { _tag: "GenericListPresentation" };
    }
    return { _tag: "GroupedStringListPresentation", groupKey, valuesKey };
}

function schemaHasType(schema: SchemaObject, type: string): boolean {
    return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function numericSchemaValue(schema: SchemaObject, key: string): number | undefined {
    const value = schema[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function settingsControlHint(schema: SchemaObject): SettingsControlHint | undefined {
    const hint = schema["x-control"];
    return SETTINGS_CONTROL_HINTS.find((candidate) => candidate === hint);
}

function textPresentationForSchema(
    schema: SchemaObject,
): "color" | "combobox" | "path" | "text" | "textarea" {
    const hint = settingsControlHint(schema);
    if (
        hint === "text" ||
        hint === "textarea" ||
        hint === "color" ||
        hint === "path" ||
        hint === "combobox"
    ) {
        return hint;
    }
    if (schema.format === "color") return "color";
    if (schema.format === "path") return "path";
    if (typeof schema.default === "string" && schema.default.includes("\n")) return "textarea";
    const examples = schemaArray(schema, "examples") ?? [];
    if (examples.some((example) => typeof example === "string" && example.includes("\n"))) {
        return "textarea";
    }
    return (numericSchemaValue(schema, "maxLength") ?? 0) > 200 ? "textarea" : "text";
}

function textSuggestions(schema: SchemaObject): readonly string[] {
    const suggestions: string[] = [];
    for (const example of schemaArray(schema, "examples") ?? []) {
        if (typeof example === "string" && !suggestions.includes(example)) {
            suggestions.push(example);
        }
    }
    return suggestions;
}

function settingsValueNode(
    root: SchemaObject,
    value: unknown,
    key: string,
    required: boolean,
    references: ReadonlySet<string>,
): SettingsValueNode {
    const schema = resolvedSchemaObject(root, value) ?? parseSchemaObject(value) ?? {};
    const fallbackDescription = "No description was provided by the extension.";
    // oxlint-disable-next-line no-use-before-define -- Node and control normalization recurse.
    const nodeDefault = defaultForSchema(root, value);
    return {
        label: schemaTitle(schema, key),
        description: schemaDescription(schema, fallbackDescription),
        constraints: constraintSummary(schema),
        required,
        defaultValue: nodeDefault === NO_DEFAULT ? undefined : nodeDefault,
        // oxlint-disable-next-line no-use-before-define -- Node and control normalization recurse.
        control: controlForSchema(root, value, references),
    };
}

function objectVariantLabel(root: SchemaObject, value: unknown): string | undefined {
    const properties = fixedObjectProperties(root, value);
    if (properties === undefined) return undefined;
    for (const property of Object.values(properties)) {
        const choices = choiceValues(root, property);
        if (choices?.length !== 1) continue;
        const choice = choices[0];
        if (typeof choice === "string") return formatSettingLabel(choice);
        if (choice !== undefined) return String(choice);
    }
    const schema = resolvedSchemaObject(root, value);
    const required = (schemaArray(schema ?? {}, "required") ?? []).filter(
        (entry): entry is string => typeof entry === "string",
    );
    const semanticKeys = required.filter((key) => key !== "args" && key !== "fact");
    const semanticKey = semanticKeys.length === 1 ? semanticKeys[0] : undefined;
    if (semanticKey !== undefined) return formatSettingLabel(semanticKey);
    const onlyKey = required.length === 1 ? required[0] : undefined;
    if (onlyKey !== undefined) return formatSettingLabel(onlyKey);
    return undefined;
}

function unionVariantLabel(root: SchemaObject, value: unknown, index: number): string {
    const schema = resolvedSchemaObject(root, value) ?? parseSchemaObject(value);
    if (typeof schema?.title === "string" && schema.title.trim() !== "") {
        return schema.title.trim();
    }
    const objectLabel = objectVariantLabel(root, value);
    if (objectLabel !== undefined) return objectLabel;
    const choices = choiceValues(root, value);
    if (choices?.length === 1) {
        const choice = choices[0];
        if (choice === null) return "None";
        return typeof choice === "string" ? formatSettingLabel(choice) : String(choice);
    }
    if (schema !== undefined) {
        if (schemaHasType(schema, "null")) return "None";
        if (schemaHasType(schema, "array")) return "List";
        if (schemaHasType(schema, "object")) return "Object";
        if (schemaHasType(schema, "boolean")) return "Boolean";
        if (schemaHasType(schema, "integer")) return "Integer";
        if (schemaHasType(schema, "number")) return "Number";
        if (schemaHasType(schema, "string")) return "Text";
    }
    return `Option ${index + 1}`;
}

function mapControlForSchema(
    root: SchemaObject,
    schema: SchemaObject,
    references: ReadonlySet<string>,
): Extract<SettingsControl, { readonly _tag: "MapControl" }> | undefined {
    const properties = parseSchemaObject(schema.properties);
    if (properties !== undefined && Object.keys(properties).length > 0) return undefined;

    const patterns = parseSchemaObject(schema.patternProperties);
    if (patterns !== undefined) {
        const entries = Object.entries(patterns);
        const entry = entries[0];
        if (entries.length !== 1 || entry === undefined) return undefined;
        return {
            _tag: "MapControl",
            value: settingsValueNode(root, entry[1], "Value", false, references),
            keyPattern: entry[0],
        };
    }

    const additionalProperties = parseSchemaObject(schema.additionalProperties);
    if (additionalProperties === undefined) return undefined;
    return {
        _tag: "MapControl",
        value: settingsValueNode(root, additionalProperties, "Value", false, references),
        keyPattern: undefined,
    };
}

function stringOnlySchema(root: SchemaObject, value: unknown, depth = 0): boolean {
    if (depth > 64) return false;
    const schema = resolvedSchemaObject(root, value);
    if (schema === undefined) return false;
    if (schemaHasType(schema, "string")) return true;
    const choices = choiceValues(root, schema);
    if (choices !== undefined) return choices.every((choice) => typeof choice === "string");
    const branches = schemaArray(schema, "anyOf") ?? schemaArray(schema, "oneOf");
    return (
        branches !== undefined &&
        branches.length > 0 &&
        branches.every((branch) => stringOnlySchema(root, branch, depth + 1))
    );
}

function stringSuggestionsForSchema(root: SchemaObject, value: unknown): readonly string[] {
    const suggestions: string[] = [];
    function visit(candidate: unknown, depth: number): void {
        if (depth > 64) return;
        const schema = resolvedSchemaObject(root, candidate);
        if (schema === undefined) return;
        for (const example of schemaArray(schema, "examples") ?? []) {
            if (typeof example === "string" && !suggestions.includes(example)) {
                suggestions.push(example);
            }
        }
        const choices = choiceValues(root, schema);
        if (choices !== undefined) {
            for (const choice of choices) {
                if (typeof choice === "string" && !suggestions.includes(choice)) {
                    suggestions.push(choice);
                }
            }
            return;
        }
        for (const branch of schemaArray(schema, "anyOf") ?? schemaArray(schema, "oneOf") ?? []) {
            visit(branch, depth + 1);
        }
    }
    visit(value, 0);
    return suggestions;
}

function controlForSchema(
    root: SchemaObject,
    value: unknown,
    references: ReadonlySet<string> = new Set(),
): SettingsControl {
    if (value === false) {
        return {
            _tag: "ReadOnlyControl",
            reason: "This schema does not accept a value.",
            fixedValue: undefined,
        };
    }
    if (value === true) return { _tag: "JsonControl", expected: "JSON value" };

    const incoming = parseSchemaObject(value);
    if (typeof incoming?.$ref === "string") {
        if (references.has(incoming.$ref)) {
            return { _tag: "JsonControl", expected: "recursive JSON value" };
        }
        const target = resolveSchemaReference(root, incoming.$ref);
        if (target === undefined) {
            return { _tag: "JsonControl", expected: "JSON value for an unresolved schema" };
        }
        return controlForSchema(root, target, new Set([...references, incoming.$ref]));
    }

    const resolved = resolveSchemaNode(root, value);
    const schema = parseSchemaObject(resolved);
    if (schema === undefined) {
        return { _tag: "JsonControl", expected: "JSON value matching the extension schema" };
    }
    if (schema.readOnly === true) {
        return {
            _tag: "ReadOnlyControl",
            reason: "The extension marks this setting read-only.",
            fixedValue: undefined,
        };
    }
    if (settingsControlHint(schema) === "json-editor") {
        return { _tag: "JsonControl", expected: "JSON value matching the extension schema" };
    }

    const choices = choiceValues(root, resolved);
    if (choices !== undefined) {
        if (choices.length === 1) {
            return {
                _tag: "ReadOnlyControl",
                reason: "This setting has one fixed value.",
                fixedValue: choices[0],
            };
        }
        const hint = settingsControlHint(schema);
        let presentation: "combobox" | "segmented" | "select";
        if (hint === "combobox" || hint === "segmented" || hint === "select") {
            presentation = hint;
        } else {
            presentation = choices.length <= 6 ? "segmented" : "select";
        }
        return { _tag: "ChoiceControl", choices, presentation };
    }

    const branches = schemaArray(schema, "anyOf") ?? schemaArray(schema, "oneOf");
    if (
        branches !== undefined &&
        branches.length > 0 &&
        settingsControlHint(schema) === "combobox" &&
        stringOnlySchema(root, resolved)
    ) {
        return {
            _tag: "TextControl",
            editor: "inline",
            presentation: "combobox",
            suggestions: stringSuggestionsForSchema(root, resolved),
            minLength: 0,
        };
    }

    if (branches !== undefined && branches.length > 0) {
        return {
            _tag: "UnionControl",
            variants: branches.map((branch, index) => {
                const label = unionVariantLabel(root, branch, index);
                return {
                    label,
                    node: settingsValueNode(root, branch, label, true, references),
                };
            }),
        };
    }

    if (schemaHasType(schema, "boolean")) return { _tag: "BooleanControl" };
    if (schemaHasType(schema, "string")) {
        const presentation = textPresentationForSchema(schema);
        return {
            _tag: "TextControl",
            editor: presentation === "textarea" ? "multiline" : "inline",
            presentation,
            suggestions: textSuggestions(schema),
            minLength: numericSchemaValue(schema, "minLength") ?? 0,
        };
    }
    if (schemaHasType(schema, "integer") || schemaHasType(schema, "number")) {
        const minimum = numericSchemaValue(schema, "minimum");
        const exclusiveMinimum = numericSchemaValue(schema, "exclusiveMinimum");
        const maximum = numericSchemaValue(schema, "maximum");
        const exclusiveMaximum = numericSchemaValue(schema, "exclusiveMaximum");
        const hint = settingsControlHint(schema);
        let presentation: "numeric" | "slider";
        if (hint === "numeric" || hint === "slider") presentation = hint;
        else {
            const hasMinimum = minimum !== undefined || exclusiveMinimum !== undefined;
            const hasMaximum = maximum !== undefined || exclusiveMaximum !== undefined;
            presentation = hasMinimum && hasMaximum ? "slider" : "numeric";
        }
        return {
            _tag: "NumberControl",
            presentation,
            integer: schemaHasType(schema, "integer"),
            minimum,
            exclusiveMinimum,
            maximum,
            exclusiveMaximum,
            multipleOf: numericSchemaValue(schema, "multipleOf"),
        };
    }
    if (schemaHasType(schema, "array")) {
        const itemSchema = schema.items;
        return {
            _tag: "ListControl",
            expected: "JSON array",
            presentation: listPresentation(root, schema),
            item: settingsValueNode(root, itemSchema, "Entry", true, references),
            minItems: Math.max(0, numericSchemaValue(schema, "minItems") ?? 0),
            maxItems: numericSchemaValue(schema, "maxItems"),
        };
    }
    if (schemaHasType(schema, "null")) return { _tag: "NullControl" };
    if (schemaHasType(schema, "object") || parseSchemaObject(schema.properties) !== undefined) {
        const mapControl = mapControlForSchema(root, schema, references);
        if (mapControl !== undefined) return mapControl;
        const properties = parseSchemaObject(schema.properties);
        if (properties !== undefined) {
            const required = new Set(
                (schemaArray(schema, "required") ?? []).filter(
                    (entry): entry is string => typeof entry === "string",
                ),
            );
            return {
                _tag: "ObjectControl",
                properties: Object.entries(properties).map(([key, property]) => ({
                    key,
                    node: settingsValueNode(root, property, key, required.has(key), references),
                })),
            };
        }
        return { _tag: "JsonControl", expected: "JSON object" };
    }
    return { _tag: "JsonControl", expected: "JSON value matching the extension schema" };
}

function defaultForSchema(root: SchemaObject, value: unknown): JsonValue | typeof NO_DEFAULT {
    const resolved = resolveSchemaNode(root, value);
    const schema = parseSchemaObject(resolved);
    if (schema === undefined || !("default" in schema) || !isJsonValue(schema.default)) {
        return NO_DEFAULT;
    }

    const rawDefault = structuredClone(schema.default);
    if (!isJsonObjectValue(rawDefault)) return rawDefault;
    const properties = fixedObjectProperties(root, resolved);
    if (properties === undefined) return rawDefault;

    const defaults: Record<string, JsonValue> = { ...rawDefault };
    for (const [key, childSchema] of Object.entries(properties)) {
        if (key in defaults) continue;
        const childDefault = defaultForSchema(root, childSchema);
        if (childDefault !== NO_DEFAULT) defaults[key] = childDefault;
    }
    return defaults;
}

/** Create the smallest useful value represented by a normalized settings node. */
export function materializeSettingsValue(node: SettingsValueNode): JsonValue | undefined {
    if (node.defaultValue !== undefined) return structuredClone(node.defaultValue);
    switch (node.control._tag) {
        case "BooleanControl":
            return false;
        case "ChoiceControl":
            return node.control.choices[0];
        case "JsonControl":
            return undefined;
        case "ListControl": {
            const values: JsonValue[] = [];
            for (let index = 0; index < node.control.minItems; index += 1) {
                const item = materializeSettingsValue(node.control.item);
                if (item === undefined) return undefined;
                values.push(item);
            }
            return values;
        }
        case "MapControl":
            return {};
        case "NullControl":
            return null;
        case "NumberControl": {
            const minimum = node.control.minimum;
            if (minimum !== undefined) return minimum;
            const exclusiveMinimum = node.control.exclusiveMinimum;
            if (exclusiveMinimum === undefined) return 0;
            return node.control.integer ? Math.floor(exclusiveMinimum) + 1 : exclusiveMinimum + 1;
        }
        case "ObjectControl": {
            const value: Record<string, JsonValue> = {};
            for (const property of node.control.properties) {
                if (!property.node.required && property.node.defaultValue === undefined) continue;
                const child = materializeSettingsValue(property.node);
                if (child === undefined) {
                    if (property.node.required) return undefined;
                    continue;
                }
                value[property.key] = child;
            }
            return value;
        }
        case "ReadOnlyControl":
            return node.control.fixedValue;
        case "TextControl":
            return node.control.suggestions[0] ?? "value".padEnd(node.control.minLength, "x");
        case "UnionControl":
            for (const variant of node.control.variants) {
                const value = materializeSettingsValue(variant.node);
                if (value !== undefined) return value;
            }
            return undefined;
    }
}

function buildDefaultDocument(root: SchemaDocument): JsonObject {
    const defaults: Record<string, JsonValue> = {};
    for (const [key, childSchema] of Object.entries(root.properties)) {
        const childDefault = defaultForSchema(root, childSchema);
        if (childDefault !== NO_DEFAULT) defaults[key] = childDefault;
    }
    return defaults;
}

function compactExtensionTitle(title: string): string {
    return title.replace(/^pi[\s_-]+/i, "").trim() || title;
}

function contextualSettingLabel(label: string, extensionName: string): string {
    const prefix = compactExtensionTitle(extensionName);
    if (!label.toLocaleLowerCase().startsWith(`${prefix.toLocaleLowerCase()} `)) return label;
    return formatSettingLabel(label.slice(prefix.length + 1));
}

function buildFields(root: SchemaDocument, extensionName: string): readonly SettingsField[] {
    const fields: SettingsField[] = [];

    function visit(
        properties: Readonly<Record<string, unknown>>,
        prefix: readonly string[],
        requiredNames: ReadonlySet<string>,
        parentSchema: SchemaObject,
    ): void {
        for (const [key, rawSchema] of Object.entries(properties)) {
            if (prefix.length === 0 && key === "$schema") continue;
            const resolved = resolveSchemaNode(root, rawSchema);
            const schema = parseSchemaObject(resolved) ?? parseSchemaObject(rawSchema);
            const path = [...prefix, key];
            const nestedProperties = fixedObjectProperties(root, rawSchema);
            if (
                nestedProperties !== undefined &&
                settingsControlHint(schema ?? {}) !== "json-editor"
            ) {
                const nestedRequired = new Set(
                    (schemaArray(schema ?? {}, "required") ?? []).filter(
                        (name): name is string => typeof name === "string",
                    ),
                );
                visit(nestedProperties, path, nestedRequired, schema ?? {});
                continue;
            }

            const fallbackDescription = "No description was provided by the extension.";
            const label = schema === undefined ? schemaTitle({}, key) : schemaTitle(schema, key);
            fields.push({
                path,
                label: contextualSettingLabel(label, extensionName),
                description:
                    schema === undefined
                        ? fallbackDescription
                        : schemaDescription(schema, fallbackDescription),
                constraints: schema === undefined ? "" : constraintSummary(schema),
                required: requiredNames.has(key),
                control: controlForSchema(root, rawSchema),
                choiceDefaults: conditionalChoiceDefaults(root, parentSchema, key),
            });
        }
    }

    const rootRequired = new Set(
        (schemaArray(root, "required") ?? []).filter(
            (name): name is string => typeof name === "string",
        ),
    );
    visit(root.properties, [], rootRequired, root);
    return fields;
}

function extensionTitle(schemaTitleValue: string): string {
    const title = schemaTitleValue.replace(/ settings$/i, "").trim();
    return title === "" ? schemaTitleValue : title;
}

/** Parse and verify one generated extension-settings schema document. */
export function parseExtensionSettingsSchema(
    id: string,
    schemaPath: string,
    schemaText: string,
): ParseExtensionSchemaOutcome {
    if (!SETTINGS_ID_PATTERN.test(id)) {
        return {
            _tag: "InvalidSchema",
            message: "The schema filename has an invalid settings ID.",
        };
    }

    const raw = parseJsonText(schemaText);
    if (raw === undefined || !Value.Check(schemaDocumentBoundary, raw)) {
        return {
            _tag: "InvalidSchema",
            message: "The file is not a generated Pi extension settings schema.",
        };
    }
    const document = Value.Decode(schemaDocumentBoundary, raw);
    if (!IsSchema(document)) {
        return { _tag: "InvalidSchema", message: "The schema document is not usable by TypeBox." };
    }

    const metadata = parseSchemaObject(document.properties.$schema);
    const schemaReference = `./schemas/${id}.schema.json`;
    if (
        metadata?.type !== "string" ||
        metadata.default !== schemaReference ||
        metadata.description !== "JSON Schema used by editors for this settings file."
    ) {
        return {
            _tag: "InvalidSchema",
            message: "The schema does not carry the generated extension-settings marker.",
        };
    }

    try {
        const title = extensionTitle(document.title);
        const defaultDocument = buildDefaultDocument(document);
        if (!Value.Check(document, defaultDocument)) {
            return { _tag: "InvalidSchema", message: "The schema defaults are invalid." };
        }
        return {
            _tag: "ParsedSchema",
            schema: {
                id,
                title,
                description: document.description,
                schemaPath,
                schemaText,
                schemaReference,
                schema: document,
                defaultDocument,
                fields: buildFields(document, title),
            },
        };
    } catch {
        return {
            _tag: "InvalidSchema",
            message: "The schema uses constraints that the settings editor cannot validate.",
        };
    }
}

/** Parse a persisted settings document and validate it against its extension schema. */
export function parseSettingsDocument(
    extensionSchema: ExtensionSettingsSchema,
    text: string,
): ParseSettingsDocumentOutcome {
    const raw = parseJsonText(text);
    if (raw === undefined) {
        return {
            _tag: "InvalidDocument",
            message: "Settings contain malformed JSON.",
            issues: [],
        };
    }

    try {
        if (!Value.Check(extensionSchema.schema, raw)) {
            const issues = [...Value.Errors(extensionSchema.schema, raw)].map(
                (issue) =>
                    `${issue.instancePath === "" ? "/" : issue.instancePath}: ${issue.message}`,
            );
            return {
                _tag: "InvalidDocument",
                message: "Settings do not match the extension schema.",
                issues,
            };
        }
        const decoded: unknown = Value.Decode(extensionSchema.schema, raw);
        const document = parseJsonObject(decoded);
        if (document === undefined) {
            return {
                _tag: "InvalidDocument",
                message: "Settings did not decode to a JSON object.",
                issues: [],
            };
        }
        return { _tag: "ParsedDocument", document };
    } catch {
        return {
            _tag: "InvalidDocument",
            message: "Settings could not be validated by TypeBox.",
            issues: [],
        };
    }
}

/** Parse an arbitrary JSON value entered through a structured settings control. */
export function parseSettingsValue(text: string): ParseSettingsValueOutcome {
    const raw = parseJsonText(text);
    if (raw === undefined || !isJsonValue(raw)) {
        return { _tag: "InvalidValue", message: "Enter a valid JSON value." };
    }
    return { _tag: "ParsedValue", value: raw };
}
