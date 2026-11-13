import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { jsonObjectParser, type JsonObject, type JsonValue } from "./json-value.ts";
import { stringParser } from "./json-scalar.ts";

/** Accepts any non-array object, so parse results can be memoized by identity. */
export const objectValidator = Compile(Type.Unsafe<object>(Type.Object({})));

/** Narrows an already validated JSON value without widening its fields. */
export function isRecord(value: JsonValue | undefined): value is JsonObject {
    return jsonObjectParser.parse(value) !== undefined;
}

export function stringField(value: JsonValue | undefined, key: string): string | undefined {
    if (!isRecord(value)) return undefined;

    const field = value[key];
    return stringParser.parse(field);
}

const diffDetailsSchema = Type.Object({
    diff: Type.String(),
    patch: Type.Optional(Type.String()),
});

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
