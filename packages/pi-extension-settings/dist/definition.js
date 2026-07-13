import { IsSchema } from "typebox";
import { Value } from "typebox/value";
import { cloneJson, isJsonObject, parseJson } from "./json-value.js";
import { createSettingsFileSchema, findNonStrictObjectSchemas, findUndocumentedSettings, hasReservedSchemaProperty, isJsonSettingsDefault, } from "./schema-document.js";
const definitionMarker = Symbol.for("@zigai/pi-extension-settings/definition");
const SETTINGS_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
function isSettingsSchema(value) {
    if (!IsSchema(value))
        return false;
    let serialized;
    try {
        serialized = JSON.stringify(value);
    }
    catch {
        return false;
    }
    if (serialized === undefined)
        return false;
    const parsed = parseJson(serialized);
    return isJsonObject(parsed) && parsed.type === "object" && isJsonObject(parsed.properties);
}
function isObjectRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function freezeRecursively(value) {
    if (value === null || typeof value !== "object" || Object.isFrozen(value))
        return;
    if (Array.isArray(value)) {
        for (const item of value)
            freezeRecursively(item);
    }
    else if (isObjectRecord(value)) {
        for (const child of Object.values(value))
            freezeRecursively(child);
    }
    Object.freeze(value);
}
export class InvalidSettingsDefinition extends Error {
    name = "InvalidSettingsDefinition";
    reason;
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
/** Define an extension's settings contract and verify its defaults immediately. */
export function defineExtensionSettings(input) {
    if (!SETTINGS_ID_PATTERN.test(input.id)) {
        throw new InvalidSettingsDefinition("id must be 1-128 lowercase filename-safe characters and cannot end with punctuation");
    }
    if (input.title.trim() === "") {
        throw new InvalidSettingsDefinition("title must not be blank");
    }
    if (input.description.trim() === "") {
        throw new InvalidSettingsDefinition("description must not be blank");
    }
    const schemaId = input.schemaId ?? `urn:pi-extension-settings:${input.id}`;
    try {
        new URL(schemaId);
    }
    catch {
        throw new InvalidSettingsDefinition("schemaId must be an absolute URI");
    }
    const schema = Value.Clone(input.schema);
    if (hasReservedSchemaProperty(schema)) {
        throw new InvalidSettingsDefinition("$schema is reserved for editor metadata");
    }
    const nonStrictObjects = findNonStrictObjectSchemas(schema);
    if (nonStrictObjects.length > 0) {
        throw new InvalidSettingsDefinition(`object schemas must set additionalProperties to false: ${nonStrictObjects.join(", ")}`);
    }
    const undocumentedSettings = findUndocumentedSettings(schema);
    if (undocumentedSettings.length > 0) {
        throw new InvalidSettingsDefinition(`user-facing settings must have descriptions: ${undocumentedSettings.join(", ")}`);
    }
    const rawDefaults = Value.Default(schema, {});
    if (!Value.Check(schema, rawDefaults)) {
        const issues = [...Value.Errors(schema, rawDefaults)]
            .map((issue) => `${issue.instancePath || "/"}: ${issue.message}`)
            .join("; ");
        throw new InvalidSettingsDefinition(`required settings must have valid defaults${issues === "" ? "" : `: ${issues}`}`);
    }
    if (!isJsonSettingsDefault(rawDefaults)) {
        throw new InvalidSettingsDefinition("schema defaults must produce a JSON object");
    }
    try {
        Value.Decode(schema, rawDefaults);
    }
    catch {
        throw new InvalidSettingsDefinition("schema defaults could not be decoded");
    }
    const defaultSettings = cloneJson(rawDefaults);
    freezeRecursively(schema);
    freezeRecursively(defaultSettings);
    const definition = Object.freeze({
        [definitionMarker]: true,
        id: input.id,
        title: input.title,
        description: input.description,
        schemaId,
        schema,
        defaultSettings,
    });
    // Build once during definition so malformed schema structures fail at startup.
    createSettingsFileSchema(definition);
    return definition;
}
/** Return whether a dynamically imported value was created by `defineExtensionSettings`. */
export function isExtensionSettingsDefinition(value) {
    if (value === null || typeof value !== "object")
        return false;
    if (!(definitionMarker in value) || value[definitionMarker] !== true)
        return false;
    if (!("id" in value) || typeof value.id !== "string" || !SETTINGS_ID_PATTERN.test(value.id)) {
        return false;
    }
    if (!("title" in value) || typeof value.title !== "string")
        return false;
    if (!("description" in value) || typeof value.description !== "string")
        return false;
    if (!("schemaId" in value) || typeof value.schemaId !== "string")
        return false;
    if (!("schema" in value) || !isSettingsSchema(value.schema))
        return false;
    return "defaultSettings" in value && isJsonObject(value.defaultSettings);
}
//# sourceMappingURL=definition.js.map