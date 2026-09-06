import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import { jsonObjectParser, type JsonObject, type JsonValue } from "./json-value.ts";

/** Narrows an already validated JSON value without widening its fields. */
export function isRecord(value: JsonValue | undefined): value is JsonObject {
    return jsonObjectParser.parse(value) !== undefined;
}

export function stringField(value: JsonValue | undefined, key: string): string | undefined {
    if (!isRecord(value)) return undefined;
    const field = value[key];
    return Value.Check(Type.String(), field) ? field : undefined;
}

const diffDetailsSchema = Type.Object({ diff: Type.String() });

/** Other host metadata is opaque and does not affect the diff fallback. */
export const diffDetailsParser = {
    parse(value: unknown): Static<typeof diffDetailsSchema> | undefined {
        try {
            return Value.Parse(diffDetailsSchema, value);
        } catch {
            return undefined;
        }
    },
};
