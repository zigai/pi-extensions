import Type from "typebox";
import { Value } from "typebox/value";

export const jsonValueSchema = Type.Cyclic(
    {
        JsonValue: Type.Union([
            Type.Null(),
            Type.Boolean(),
            Type.Number(),
            Type.String(),
            Type.Array(Type.Ref("JsonValue")),
            Type.Record(Type.String(), Type.Ref("JsonValue")),
        ]),
    },
    "JsonValue",
);

export const jsonObjectSchema = Type.Record(Type.String(), jsonValueSchema);

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = ReadonlyArray<JsonValue>;
export interface JsonObject {
    readonly [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export function isJsonArray(value: JsonValue | undefined): value is JsonArray {
    return Array.isArray(value);
}

export const jsonValueParser = {
    parse(value: unknown): JsonValue | undefined {
        try {
            if (value === undefined || value === null || !Value.Check(jsonValueSchema, value))
                return undefined;
            return value;
        } catch {
            return undefined;
        }
    },
};

export const jsonObjectParser = {
    parse(value: unknown): JsonObject | undefined {
        if (value === undefined || value === null || !Value.Check(jsonObjectSchema, value))
            return undefined;
        return value;
    },
};
