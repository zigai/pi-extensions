import { IsSchema, type StaticDecode, type TObject } from "typebox";
import { Value } from "typebox/value";

import { cloneJson, isJsonObject, type JsonObject, parseJson } from "./json-value.ts";
import {
    createSettingsFileSchema,
    findNonStrictObjectSchemas,
    findUndocumentedSettings,
    hasReservedSchemaProperty,
    isJsonSettingsDefault,
} from "./schema-document.ts";

const definitionMarker = Symbol.for("@zigai/pi-extension-settings/definition");
const SETTINGS_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

function isSettingsSchema(value: unknown): value is TObject {
    if (!IsSchema(value)) return false;
    let serialized: string | undefined;
    try {
        serialized = JSON.stringify(value);
    } catch {
        return false;
    }
    if (serialized === undefined) return false;
    const parsed = parseJson(serialized);
    return isJsonObject(parsed) && parsed.type === "object" && isJsonObject(parsed.properties);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freezeRecursively(value: unknown): void {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
    if (Array.isArray(value)) {
        for (const item of value) freezeRecursively(item);
    } else if (isObjectRecord(value)) {
        for (const child of Object.values(value)) freezeRecursively(child);
    }
    Object.freeze(value);
}

export class InvalidSettingsDefinition extends Error {
    override readonly name = "InvalidSettingsDefinition";
    readonly reason: string;

    constructor(reason: string) {
        super(reason);
        this.reason = reason;
    }
}

/**
 * An immutable settings contract created by {@link defineExtensionSettings}.
 *
 * The schema and derived defaults are cloned and recursively frozen. Resolved runtime values retain
 * the schema's decoded TypeBox type, while `defaultSettings` remains JSON data suitable for writing
 * to disk.
 *
 * @template Schema The TypeBox object schema that defines persisted and resolved settings.
 */
export type ExtensionSettingsDefinition<Schema extends TObject = TObject> = {
    readonly [definitionMarker]: true;
    /** The stable identifier used in settings and schema filenames. */
    readonly id: string;
    /** The display name used in generated schema and README content. */
    readonly title: string;
    /** The summary used in generated schema and README content. */
    readonly description: string;
    /** The absolute URI written to the generated JSON Schema `$id` field. */
    readonly schemaId: string;
    /** A validated, recursively frozen clone of the supplied TypeBox schema. */
    readonly schema: Schema;
    /** The schema defaults as recursively frozen JSON data, before TypeBox decoding. */
    readonly defaultSettings: JsonObject;
};

/**
 * Input accepted by {@link defineExtensionSettings}.
 *
 * @template Schema The TypeBox object schema that determines the returned settings type.
 */
export type ExtensionSettingsDefinitionInput<Schema extends TObject> = {
    /**
     * Stable identity used in settings filenames.
     *
     * Must contain 1–128 lowercase letters, digits, dots, underscores, or hyphens; the first and
     * last characters must be alphanumeric. Changing this value moves the extension to different
     * settings files.
     */
    readonly id: string;
    /** Non-blank display name for generated documentation and JSON Schema metadata. */
    readonly title: string;
    /** Non-blank summary for generated documentation and JSON Schema metadata. */
    readonly description: string;
    /**
     * Absolute URI for the generated JSON Schema `$id`.
     *
     * Defaults to `urn:pi-extension-settings:<id>`.
     */
    readonly schemaId?: string;
    /**
     * TypeBox object schema for resolved settings.
     *
     * Every object must set `additionalProperties: false`, every user-facing leaf must have a
     * non-blank description, and every required property must resolve to a valid JSON default.
     * `$schema` is reserved for editor metadata and cannot be declared as a setting.
     */
    readonly schema: Schema;
};

/**
 * Defines and validates an extension's settings contract.
 *
 * Validation is eager so invalid schemas fail while the extension is loading, before any settings
 * files are read or written. The input schema is cloned; this function does not mutate caller-owned
 * data.
 *
 * @template Schema The TypeBox object schema used to infer resolved settings.
 * @param input Identity, documentation metadata, and the TypeBox settings schema.
 * @returns An immutable definition with validated JSON defaults.
 * @throws {InvalidSettingsDefinition} If metadata, schema structure, descriptions, or defaults do
 * not satisfy the settings contract.
 *
 * @example
 * ```ts
 * import { defineExtensionSettings } from "@zigai/pi-extension-settings";
 * import { Type } from "typebox";
 *
 * export default defineExtensionSettings({
 *   id: "pi-example",
 *   title: "Pi Example",
 *   description: "Settings for Pi Example.",
 *   schema: Type.Object(
 *     {
 *       enabled: Type.Boolean({
 *         default: true,
 *         description: "Enable the extension.",
 *       }),
 *     },
 *     { additionalProperties: false },
 *   ),
 * });
 * ```
 */
export function defineExtensionSettings<const Schema extends TObject>(
    input: ExtensionSettingsDefinitionInput<Schema>,
): ExtensionSettingsDefinition<Schema> {
    if (!SETTINGS_ID_PATTERN.test(input.id)) {
        throw new InvalidSettingsDefinition(
            "id must be 1-128 lowercase filename-safe characters and cannot end with punctuation",
        );
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
    } catch {
        throw new InvalidSettingsDefinition("schemaId must be an absolute URI");
    }

    const schema = Value.Clone(input.schema);
    if (hasReservedSchemaProperty(schema)) {
        throw new InvalidSettingsDefinition("$schema is reserved for editor metadata");
    }

    const nonStrictObjects = findNonStrictObjectSchemas(schema);
    if (nonStrictObjects.length > 0) {
        throw new InvalidSettingsDefinition(
            `object schemas must set additionalProperties to false: ${nonStrictObjects.join(", ")}`,
        );
    }
    const undocumentedSettings = findUndocumentedSettings(schema);
    if (undocumentedSettings.length > 0) {
        throw new InvalidSettingsDefinition(
            `user-facing settings must have descriptions: ${undocumentedSettings.join(", ")}`,
        );
    }

    const rawDefaults: unknown = Value.Default(schema, {});
    if (!Value.Check(schema, rawDefaults)) {
        const issues = [...Value.Errors(schema, rawDefaults)]
            .map((issue) => `${issue.instancePath || "/"}: ${issue.message}`)
            .join("; ");
        throw new InvalidSettingsDefinition(
            `required settings must have valid defaults${issues === "" ? "" : `: ${issues}`}`,
        );
    }
    if (!isJsonSettingsDefault(rawDefaults)) {
        throw new InvalidSettingsDefinition("schema defaults must produce a JSON object");
    }

    try {
        Value.Decode(schema, rawDefaults);
    } catch {
        throw new InvalidSettingsDefinition("schema defaults could not be decoded");
    }

    const defaultSettings = cloneJson(rawDefaults);
    freezeRecursively(schema);
    freezeRecursively(defaultSettings);

    const definition: ExtensionSettingsDefinition<Schema> = Object.freeze({
        [definitionMarker]: true as const,
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

export function isExtensionSettingsDefinition(
    value: unknown,
): value is ExtensionSettingsDefinition {
    if (value === null || typeof value !== "object") return false;
    if (!(definitionMarker in value) || value[definitionMarker] !== true) return false;
    if (!("id" in value) || typeof value.id !== "string" || !SETTINGS_ID_PATTERN.test(value.id)) {
        return false;
    }
    if (!("title" in value) || typeof value.title !== "string") return false;
    if (!("description" in value) || typeof value.description !== "string") return false;
    if (!("schemaId" in value) || typeof value.schemaId !== "string") return false;
    if (!("schema" in value) || !isSettingsSchema(value.schema)) return false;
    return "defaultSettings" in value && isJsonObject(value.defaultSettings);
}

/**
 * The decoded runtime settings type produced by an extension definition.
 *
 * This preserves TypeBox transforms: it represents values after decoding, not the JSON shape stored
 * in settings files.
 *
 * @template Definition A definition returned by {@link defineExtensionSettings}.
 *
 * @example
 * ```ts
 * import type { ResolvedSettings } from "@zigai/pi-extension-settings";
 * import settingsDefinition from "./settings.ts";
 *
 * export type Settings = ResolvedSettings<typeof settingsDefinition>;
 * ```
 */
export type ResolvedSettings<Definition extends ExtensionSettingsDefinition> = StaticDecode<
    Definition["schema"]
>;
