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
