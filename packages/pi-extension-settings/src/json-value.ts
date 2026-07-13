export type JsonPrimitive = boolean | null | number | string;

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export interface JsonArray extends ReadonlyArray<JsonValue> {
    readonly [index: number]: JsonValue;
}

export interface JsonObject {
    readonly [key: string]: JsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.prototype.toString.call(value) === "[object Object]"
    );
}

/** Return whether a value can be represented losslessly in JSON. */
export function isJsonValue(value: unknown): value is JsonValue {
    if (value === null) return true;

    switch (typeof value) {
        case "boolean":
        case "string":
            return true;
        case "number":
            return Number.isFinite(value);
        case "object":
            if (Array.isArray(value)) return value.every(isJsonValue);
            return isRecord(value) && Object.values(value).every(isJsonValue);
        case "bigint":
        case "function":
        case "symbol":
        case "undefined":
            return false;
    }
    return false;
}

/** Return whether a value is a JSON array. */
export function isJsonArray(value: unknown): value is JsonArray {
    return Array.isArray(value) && value.every((item: unknown) => isJsonValue(item));
}

/** Return whether a value is a JSON object rather than an array or null. */
export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
    return isRecord(value) && Object.values(value).every(isJsonValue);
}

/** Clone a JSON value so callers never receive mutable internal state. */
export function cloneJson<Value extends JsonValue>(value: Value): Value {
    return structuredClone(value);
}

/** Parse text as a JSON value without trusting the result of `JSON.parse`. */
export function parseJson(text: string): JsonValue | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return undefined;
    }

    return isJsonValue(parsed) ? parsed : undefined;
}

/** Serialize JSON deterministically with a trailing newline. */
export function formatJson(value: JsonValue): string {
    return `${JSON.stringify(value, undefined, 2)}\n`;
}
