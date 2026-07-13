import { cloneJson, isJsonArray, isJsonObject, isJsonValue, parseJson, } from "./json-value.js";
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_MAP_KEYWORDS = new Set([
    "$defs",
    "definitions",
    "dependentSchemas",
    "patternProperties",
    "properties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_VALUE_KEYWORDS = new Set([
    "additionalProperties",
    "contains",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties",
]);
function makeSettingsObjectPartial(schema) {
    const transformed = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === "required")
            continue;
        if (key === "properties" && isJsonObject(value)) {
            const properties = {};
            for (const [name, child] of Object.entries(value)) {
                properties[name] =
                    isJsonObject(child) && child.type === "object" && isJsonObject(child.properties)
                        ? makeSettingsObjectPartial(child)
                        : cloneJson(child);
            }
            transformed[key] = properties;
            continue;
        }
        transformed[key] = cloneJson(value);
    }
    return transformed;
}
function stripTypeBoxMetadata(value) {
    if (Array.isArray(value))
        return value.map(stripTypeBoxMetadata);
    if (!isJsonObject(value))
        return value;
    const sanitized = {};
    for (const [key, child] of Object.entries(value)) {
        if (key.startsWith("~"))
            continue;
        sanitized[key] = stripTypeBoxMetadata(child);
    }
    return sanitized;
}
function schemaRecord(schema) {
    const serialized = JSON.stringify(schema);
    if (serialized === undefined) {
        throw new TypeError("The TypeBox schema is not JSON serializable.");
    }
    const parsed = parseJson(serialized);
    if (!isJsonObject(parsed)) {
        throw new TypeError("The TypeBox settings schema must serialize to a JSON object.");
    }
    return stripTypeBoxMetadata(parsed);
}
function visitChildSchemas(schema, path, visit) {
    for (const [key, value] of Object.entries(schema)) {
        if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
            for (const [name, child] of Object.entries(value)) {
                if (isJsonObject(child))
                    visit(child, `${path}/${key}/${name}`);
            }
            continue;
        }
        if (SCHEMA_ARRAY_KEYWORDS.has(key) && isJsonArray(value)) {
            for (const [index, child] of value.entries()) {
                if (isJsonObject(child))
                    visit(child, `${path}/${key}/${index}`);
            }
            continue;
        }
        if (SCHEMA_VALUE_KEYWORDS.has(key) && isJsonObject(value)) {
            visit(value, `${path}/${key}`);
        }
    }
}
/** Return whether the user schema collides with editor metadata owned by this package. */
export function hasReservedSchemaProperty(schema) {
    const root = schemaRecord(schema);
    return isJsonObject(root.properties) && "$schema" in root.properties;
}
/** Return user-editable leaf settings that do not have descriptions. */
export function findUndocumentedSettings(schema) {
    const root = schemaRecord(schema);
    if (!isJsonObject(root.properties))
        return ["<root>"];
    const issues = [];
    function visit(properties, prefix) {
        for (const [key, value] of Object.entries(properties)) {
            const path = prefix === "" ? key : `${prefix}.${key}`;
            if (isJsonObject(value) && value.type === "object" && isJsonObject(value.properties)) {
                visit(value.properties, path);
                continue;
            }
            if (!isJsonObject(value) ||
                typeof value.description !== "string" ||
                value.description.trim() === "") {
                issues.push(path);
            }
        }
    }
    visit(root.properties, "");
    return issues;
}
/** Return paths of object schemas that permit unrecognized properties. */
export function findNonStrictObjectSchemas(schema) {
    const issues = [];
    function visit(value, path) {
        if (value.type === "object" && isJsonObject(value.properties)) {
            if (value.additionalProperties !== false)
                issues.push(path);
        }
        visitChildSchemas(value, path, visit);
    }
    visit(schemaRecord(schema), "#");
    return issues;
}
/** Convert a resolved settings schema into a deeply partial persisted-file schema. */
export function createSettingsFileSchema(input) {
    const partial = makeSettingsObjectPartial(schemaRecord(input.schema));
    if (!isJsonObject(partial.properties)) {
        throw new TypeError("The TypeBox settings schema must be an object with properties.");
    }
    const properties = {
        $schema: {
            type: "string",
            default: `./schemas/${input.id}.schema.json`,
            description: "JSON Schema used by editors for this settings file.",
        },
    };
    for (const [key, value] of Object.entries(partial.properties)) {
        properties[key] = cloneJson(value);
    }
    const document = {
        $schema: JSON_SCHEMA_DIALECT,
        $id: input.schemaId,
        title: `${input.title} settings`,
        description: input.description,
    };
    for (const [key, value] of Object.entries(partial)) {
        if (["$schema", "$id", "title", "description", "properties", "required"].includes(key)) {
            continue;
        }
        document[key] = cloneJson(value);
    }
    document.type = "object";
    document.properties = properties;
    document.additionalProperties = false;
    return document;
}
/** Create the exact global settings document scaffolded for users. */
export function createDefaultSettingsDocument(input) {
    const document = {
        $schema: `./schemas/${input.id}.schema.json`,
    };
    for (const [key, value] of Object.entries(input.defaultSettings)) {
        document[key] = cloneJson(value);
    }
    return document;
}
/** Return a TypeBox-compatible schema for decoding persisted partial settings layers. */
export function createSettingsLayerSchema(input) {
    return createSettingsFileSchema(input);
}
/** Return whether the schema's defaults are ordinary JSON data. */
export function isJsonSettingsDefault(value) {
    return isJsonObject(value) && isJsonValue(value);
}
//# sourceMappingURL=schema-document.js.map