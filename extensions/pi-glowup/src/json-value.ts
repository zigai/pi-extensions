import Type, { type Static } from "typebox";
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

export type JsonValue = Static<typeof jsonValueSchema>;
export type JsonObject = Static<typeof jsonObjectSchema>;

export const jsonValueParser = {
    parse(value: unknown): JsonValue | undefined {
        try {
            return Value.Parse(jsonValueSchema, value);
        } catch {
            return undefined;
        }
    },
};

export const jsonObjectParser = {
    parse(value: unknown): JsonObject | undefined {
        try {
            return Value.Parse(jsonObjectSchema, value);
        } catch {
            return undefined;
        }
    },
};
