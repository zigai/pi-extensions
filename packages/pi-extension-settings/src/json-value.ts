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

export function isJsonArray(value: unknown): value is JsonArray {
    return Array.isArray(value) && value.every((item: unknown) => isJsonValue(item));
}

export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
    return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function cloneJson<Value extends JsonValue>(value: Value): Value {
    return structuredClone(value);
}

export function parseJson(text: string): unknown {
    try {
        const value: unknown = JSON.parse(text);
        return value;
    } catch {
        return undefined;
    }
}

export function formatJson(value: JsonValue): string {
    return `${JSON.stringify(value, undefined, 2)}\n`;
}
