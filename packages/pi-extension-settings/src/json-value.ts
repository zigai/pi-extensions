import { Typebox, Value } from "./typebox-runtime.ts";

const {
    Array: ArrayType,
    Boolean: BooleanType,
    Cyclic,
    Null,
    Number: NumberType,
    Record: RecordType,
    Ref,
    Refine,
    String: StringType,
    Union,
    Unknown,
    Unsafe,
} = Typebox;

export type JsonPrimitive = boolean | null | number | string;

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export interface JsonArray extends ReadonlyArray<JsonValue> {
    readonly [index: number]: JsonValue;
}

export interface JsonObject {
    readonly [key: string]: JsonValue;
}

const JsonObjectCandidateSchema = RecordType(StringType(), Unknown());

function isPlainJsonObject(value: JsonValue): value is JsonObject {
    if (!Value.Check(JsonObjectCandidateSchema, value)) return false;
    const prototype = Reflect.getPrototypeOf(value);
    return (
        (prototype === Object.prototype || prototype === null) &&
        Object.getOwnPropertySymbols(value).length === 0
    );
}

// SAFETY: TypeBox widens deeply recursive Cyclic static types. This schema exactly mirrors the
// JsonValue recursion, rejects non-plain and symbol-keyed objects, and Value.Parse validates every
// nested value before it receives the JsonValue type.
export const JsonValueSchema = Unsafe<JsonValue>(
    Cyclic(
        {
            JsonValue: Union([
                Null(),
                BooleanType(),
                NumberType(),
                StringType(),
                ArrayType(Ref("JsonValue")),
                Refine(RecordType(StringType(), Ref("JsonValue")), isPlainJsonObject),
            ]),
        },
        "JsonValue",
    ),
);

const JsonBooleanSchema = BooleanType();
const JsonNumberSchema = NumberType();
const JsonStringSchema = StringType();

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
    return Value.Check(JsonBooleanSchema, value);
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
    return Value.Check(JsonNumberSchema, value);
}

export function isJsonString(value: JsonValue | undefined): value is string {
    return Value.Check(JsonStringSchema, value);
}

export function isJsonArray(value: JsonValue | undefined): value is JsonArray {
    return Array.isArray(value);
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return value !== undefined && isPlainJsonObject(value);
}

export function cloneJson<Value extends JsonValue>(value: Value): Value {
    return structuredClone(value);
}

export function parseJson(text: string): JsonValue | undefined {
    try {
        return Value.Parse(JsonValueSchema, JSON.parse(text));
    } catch {
        return undefined;
    }
}

export function formatJson(value: JsonValue): string {
    return `${JSON.stringify(value, undefined, 2)}\n`;
}
