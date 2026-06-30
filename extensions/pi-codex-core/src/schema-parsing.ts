import type { Static, TSchema } from "typebox";

export type SchemaValidator<TValue> = {
    readonly Check: (value: unknown) => value is TValue;
    readonly Parse: (value: unknown) => TValue;
};

/** Creates a small runtime validator for the TypeBox schema subset used by this extension. */
export function compileSchema<const T extends TSchema>(schema: T): SchemaValidator<Static<T>> {
    return {
        Check(value: unknown): value is Static<T> {
            return checkSchema(schema, value);
        },
        Parse(value: unknown): Static<T> {
            if (!checkSchema(schema, value)) throw new Error("Value does not match schema.");
            // oxlint-disable-next-line typescript/no-unsafe-return -- SAFETY: checkSchema validated the runtime value against the provided TypeBox schema; TypeBox's Static<T> is opaque to the linter here.
            return value as Static<T>;
        },
    };
}

/** Parses a boundary value with a compiled TypeBox validator. */
export function parseWithSchema<TValue>(
    validator: SchemaValidator<TValue>,
    value: unknown,
): TValue | undefined {
    return validator.Check(value) ? validator.Parse(value) : undefined;
}

type JsonSchemaRecord = {
    readonly type?: string | undefined;
    readonly const?: unknown;
    readonly anyOf?: readonly unknown[] | undefined;
    readonly items?: unknown;
    readonly properties?: Record<string, unknown> | undefined;
    readonly required?: readonly string[] | undefined;
    readonly patternProperties?: Record<string, unknown> | undefined;
};

function checkSchema(schema: unknown, value: unknown): boolean {
    if (!isSchemaRecord(schema)) return true;
    if ("const" in schema) return value === schema.const;
    if (Array.isArray(schema.anyOf))
        return schema.anyOf.some((variant) => checkSchema(variant, value));

    switch (schema.type) {
        case undefined:
            return true;
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "boolean":
            return typeof value === "boolean";
        case "array":
            return Array.isArray(value) && value.every((item) => checkSchema(schema.items, item));
        case "object":
            return checkObjectSchema(schema, value);
        default:
            return true;
    }
}

function checkObjectSchema(schema: JsonSchemaRecord, value: unknown): boolean {
    if (!isPlainRecord(value)) return false;
    for (const key of schema.required ?? []) {
        if (!(key in value)) return false;
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
        if (key in value && !checkSchema(propertySchema, value[key])) return false;
    }
    const patternSchemas = Object.entries(schema.patternProperties ?? {});
    if (patternSchemas.length === 0) return true;
    for (const [key, nested] of Object.entries(value)) {
        for (const [pattern, patternSchema] of patternSchemas) {
            if (new RegExp(pattern).test(key) && !checkSchema(patternSchema, nested)) return false;
        }
    }
    return true;
}

function isSchemaRecord(value: unknown): value is JsonSchemaRecord {
    return isPlainRecord(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
