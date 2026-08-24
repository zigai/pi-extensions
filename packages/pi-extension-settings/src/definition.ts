import { isDeepStrictEqual } from "node:util";

import type { Static, StaticDecode, StaticEncode, TObject, TSchema } from "typebox";

import { IsSchema, Type, Value } from "./typebox-runtime.ts";

import {
    cloneJson,
    isJsonObject,
    JsonValueSchema,
    type JsonArray,
    type JsonObject,
    parseJson,
} from "./json-value.ts";
import { extensionSettingsDefinitionMarker as definitionMarker } from "./definition-marker.ts";
import {
    createSettingsFileSchema,
    findNonStrictObjectSchemas,
    findUndocumentedSettings,
    hasReservedSchemaProperty,
} from "./schema-document.ts";
import { mergeSettings } from "./settings-merge.ts";

const SETTINGS_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const StringValueSchema = Type.String();

export const ExtensionSettingsDefinitionCandidateSchema = Type.Object(
    {
        id: Type.Optional(Type.Unknown()),
        title: Type.Optional(Type.Unknown()),
        description: Type.Optional(Type.Unknown()),
        schemaId: Type.Optional(Type.Unknown()),
        schema: Type.Optional(Type.Unknown()),
        defaultSettings: Type.Optional(Type.Unknown()),
        exampleSettings: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);

export type ExtensionSettingsDefinitionCandidate = Static<
    typeof ExtensionSettingsDefinitionCandidateSchema
> & {
    readonly [definitionMarker]?: unknown;
};

function isSettingsSchema(value: TSchema): value is TObject {
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

function freezeRecursively(value: JsonArray | JsonObject | TSchema): void {
    if (Object.isFrozen(value)) return;
    for (const child of Object.values(value)) {
        if (Value.Check(JsonValueSchema, child)) {
            if (Array.isArray(child) || isJsonObject(child)) freezeRecursively(child);
        } else if (IsSchema(child)) {
            freezeRecursively(child);
        }
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
    /** An optional validated example settings layer rendered in generated documentation. */
    readonly exampleSettings: JsonObject | undefined;
};

/** Deeply optional object properties with replacement arrays, matching settings-layer merging. */
type SettingsLayerValue<Value> = Value extends readonly unknown[]
    ? Value
    : Value extends object
      ? string extends keyof Value
          ? Value
          : { [Key in keyof Value]?: SettingsLayerValue<Value[Key]> }
      : Value;

/**
 * Encoded JSON layer persisted for an extension's global or project settings.
 *
 * Object properties are recursively optional because layers merge over schema defaults. Arrays and
 * scalar values remain complete replacements. Values use the schema's encoded representation, not
 * the decoded runtime representation returned by `loadPiExtensionSettings`.
 *
 * @template Schema The TypeBox object schema from an extension settings definition.
 */
export type ExtensionSettingsLayer<Schema extends TObject> = SettingsLayerValue<
    StaticEncode<Schema>
>;

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
    /**
     * A realistic, non-default settings layer rendered after the default configuration.
     *
     * Use this only when complex settings—such as structured arrays, nested objects, maps, or
     * unions—benefit from a realistic advanced setup. The value must be valid JSON, must match the
     * generated settings-file schema, and must resolve to valid settings when merged over the
     * defaults. Nested object properties may be partial; arrays remain complete replacement values.
     * Omit it for simple or self-explanatory settings.
     */
    readonly exampleSettings?: ExtensionSettingsLayer<Schema>;
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
): ExtensionSettingsDefinition<Schema>;
export function defineExtensionSettings(
    input: ExtensionSettingsDefinitionCandidate,
): ExtensionSettingsDefinition;
export function defineExtensionSettings(
    input: ExtensionSettingsDefinitionCandidate,
): ExtensionSettingsDefinition {
    let id: string;
    try {
        id = Value.Parse(StringValueSchema, input.id);
    } catch {
        throw new InvalidSettingsDefinition(
            "id must be 1-128 lowercase filename-safe characters and cannot end with punctuation",
        );
    }
    if (!SETTINGS_ID_PATTERN.test(id)) {
        throw new InvalidSettingsDefinition(
            "id must be 1-128 lowercase filename-safe characters and cannot end with punctuation",
        );
    }

    let title: string;
    try {
        title = Value.Parse(StringValueSchema, input.title);
    } catch {
        throw new InvalidSettingsDefinition("title must not be blank");
    }
    if (title.trim() === "") throw new InvalidSettingsDefinition("title must not be blank");

    let description: string;
    try {
        description = Value.Parse(StringValueSchema, input.description);
    } catch {
        throw new InvalidSettingsDefinition("description must not be blank");
    }
    if (description.trim() === "") {
        throw new InvalidSettingsDefinition("description must not be blank");
    }

    let schemaId = `urn:pi-extension-settings:${id}`;
    if (input.schemaId !== undefined) {
        try {
            schemaId = Value.Parse(StringValueSchema, input.schemaId);
        } catch {
            throw new InvalidSettingsDefinition("schemaId must be an absolute URI");
        }
    }
    try {
        new URL(schemaId);
    } catch {
        throw new InvalidSettingsDefinition("schemaId must be an absolute URI");
    }

    if (!IsSchema(input.schema) || !isSettingsSchema(input.schema)) {
        throw new InvalidSettingsDefinition("schema must be a TypeBox object schema");
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
    let serializedDefaults: string;
    try {
        serializedDefaults = JSON.stringify(rawDefaults);
    } catch {
        throw new InvalidSettingsDefinition("schema defaults must produce a JSON object");
    }
    const parsedDefaults = parseJson(serializedDefaults);
    if (!isJsonObject(parsedDefaults) || !isDeepStrictEqual(rawDefaults, parsedDefaults)) {
        throw new InvalidSettingsDefinition("schema defaults must produce a JSON object");
    }

    try {
        Value.Decode(schema, rawDefaults);
    } catch {
        throw new InvalidSettingsDefinition("schema defaults could not be decoded");
    }

    const defaultSettings = cloneJson(parsedDefaults);
    let exampleSettings: JsonObject | undefined;
    if (input.exampleSettings !== undefined) {
        let serializedExample: string;
        try {
            serializedExample = JSON.stringify(input.exampleSettings);
        } catch {
            throw new InvalidSettingsDefinition("exampleSettings must be a JSON object");
        }
        const parsedExample = parseJson(serializedExample);
        if (
            !isJsonObject(parsedExample) ||
            !isDeepStrictEqual(input.exampleSettings, parsedExample)
        ) {
            throw new InvalidSettingsDefinition("exampleSettings must be a JSON object");
        }

        const fileSchema = createSettingsFileSchema({
            id,
            title,
            description,
            schemaId,
            schema,
        });
        if (!Value.Check(fileSchema, parsedExample)) {
            const issues = [...Value.Errors(fileSchema, parsedExample)]
                .map((issue) => `${issue.instancePath || "/"}: ${issue.message}`)
                .join("; ");
            throw new InvalidSettingsDefinition(
                `exampleSettings must match the settings-file schema${issues === "" ? "" : `: ${issues}`}`,
            );
        }

        const mergedExample = mergeSettings(defaultSettings, parsedExample);
        if (!Value.Check(schema, mergedExample)) {
            throw new InvalidSettingsDefinition(
                "exampleSettings must resolve to valid settings when merged with defaults",
            );
        }
        try {
            Value.Decode(schema, mergedExample);
        } catch {
            throw new InvalidSettingsDefinition("exampleSettings could not be decoded");
        }
        if (isDeepStrictEqual(mergedExample, defaultSettings)) {
            throw new InvalidSettingsDefinition(
                "exampleSettings must demonstrate configuration that differs from the defaults",
            );
        }
        exampleSettings = cloneJson(parsedExample);
    }

    freezeRecursively(schema);
    freezeRecursively(defaultSettings);
    if (exampleSettings !== undefined) freezeRecursively(exampleSettings);

    const definition: ExtensionSettingsDefinition = Object.freeze({
        [definitionMarker]: true as const,
        id,
        title,
        description,
        schemaId,
        schema,
        defaultSettings,
        exampleSettings,
    });

    // Build once during definition so malformed schema structures fail at startup.
    createSettingsFileSchema(definition);
    return definition;
}

export function isExtensionSettingsDefinition(
    value: ExtensionSettingsDefinitionCandidate,
): value is ExtensionSettingsDefinition {
    if (!(definitionMarker in value) || value[definitionMarker] !== true) return false;
    if (
        !("id" in value) ||
        !Value.Check(StringValueSchema, value.id) ||
        !SETTINGS_ID_PATTERN.test(value.id)
    ) {
        return false;
    }
    if (!("title" in value) || !Value.Check(StringValueSchema, value.title)) return false;
    if (!("description" in value) || !Value.Check(StringValueSchema, value.description)) {
        return false;
    }
    if (!("schemaId" in value) || !Value.Check(StringValueSchema, value.schemaId)) return false;
    if (!("schema" in value) || !IsSchema(value.schema) || !isSettingsSchema(value.schema)) {
        return false;
    }
    if (!("defaultSettings" in value)) return false;
    const exampleSettings = "exampleSettings" in value ? value.exampleSettings : undefined;
    let serializedDefaults: string;
    try {
        serializedDefaults = JSON.stringify(value.defaultSettings);
    } catch {
        return false;
    }
    const parsedDefaults = parseJson(serializedDefaults);
    if (
        !isJsonObject(parsedDefaults) ||
        !isDeepStrictEqual(value.defaultSettings, parsedDefaults)
    ) {
        return false;
    }
    if (exampleSettings !== undefined) {
        let serializedExample: string;
        try {
            serializedExample = JSON.stringify(exampleSettings);
        } catch {
            return false;
        }
        const parsedExample = parseJson(serializedExample);
        if (!isJsonObject(parsedExample) || !isDeepStrictEqual(exampleSettings, parsedExample)) {
            return false;
        }
    }
    return true;
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
