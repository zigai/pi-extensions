export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export function isJsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === "boolean" || typeof value === "string") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    if (typeof value !== "object") return false;
    return Object.values(value).every(isJsonValue);
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isJsonObjectBoundary(value: unknown): value is JsonObject {
    return isJsonValue(value) && isJsonObject(value);
}

export function isJsonPrimitive(value: unknown): value is JsonPrimitive {
    return (
        value === null ||
        typeof value === "boolean" ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))
    );
}

export function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
    return Array.isArray(value);
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
    return typeof value === "boolean";
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
    return typeof value === "number";
}

export function isJsonString(value: JsonValue | undefined): value is string {
    return typeof value === "string";
}

export function parseJsonText(text: string): JsonValue | undefined {
    try {
        const value: unknown = JSON.parse(text);
        return isJsonValue(value) ? value : undefined;
    } catch {
        return undefined;
    }
}
