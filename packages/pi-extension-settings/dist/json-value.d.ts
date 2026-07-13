export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export interface JsonArray extends ReadonlyArray<JsonValue> {
    readonly [index: number]: JsonValue;
}
export interface JsonObject {
    readonly [key: string]: JsonValue;
}
/** Return whether a value can be represented losslessly in JSON. */
export declare function isJsonValue(value: unknown): value is JsonValue;
/** Return whether a value is a JSON array. */
export declare function isJsonArray(value: unknown): value is JsonArray;
/** Return whether a value is a JSON object rather than an array or null. */
export declare function isJsonObject(value: unknown): value is Record<string, JsonValue>;
/** Clone a JSON value so callers never receive mutable internal state. */
export declare function cloneJson<Value extends JsonValue>(value: Value): Value;
/** Parse text as a JSON value without trusting the result of `JSON.parse`. */
export declare function parseJson(text: string): JsonValue | undefined;
/** Serialize JSON deterministically with a trailing newline. */
export declare function formatJson(value: JsonValue): string;
//# sourceMappingURL=json-value.d.ts.map