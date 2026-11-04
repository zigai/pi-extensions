import { Type, type StaticDecode } from "typebox";

export const jsonValueSchema = Type.Cyclic(
    {
        Json: Type.Union([
            Type.Null(),
            Type.Boolean(),
            Type.Number(),
            Type.String(),
            Type.Array(Type.Ref("Json")),
            Type.Record(Type.String(), Type.Ref("Json")),
        ]),
    },
    "Json",
    { title: "JsonValue" },
);

export const jsonObjectSchema = Type.Record(Type.String(), jsonValueSchema, {
    title: "JsonObject",
});

export type JsonObject = StaticDecode<typeof jsonObjectSchema>;
export type JsonValue = JsonObject[string];

// Values from a JSON parser are JSON by construction. Walking them against the recursive schemas above
// costs seconds on the megabyte payloads MCP servers can send.
export const parsedJsonObjectSchema = Type.Unsafe<JsonObject>({ type: "object" });
export const parsedJsonValueSchema = Type.Unsafe<JsonValue>({});

export function isJsonObject(value: JsonValue): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonString(value: JsonValue): value is string {
    return typeof value === "string";
}
