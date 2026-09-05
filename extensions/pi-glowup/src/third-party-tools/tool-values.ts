import { jsonArrayParser, numberParser, stringParser, booleanParser } from "../json-scalar.ts";
import type { JsonObject, JsonValue } from "../json-value.ts";

export { jsonObjectParser } from "../json-value.ts";
export { isRecord } from "../unknown-values.ts";
export type { JsonObject, JsonValue } from "../json-value.ts";

const NAMESPACED_TOOL_PREFIX_PATTERN = /^[A-Za-z0-9_-]+__(?<name>.+)$/;

export function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

export function isNonEmptyString(value: string | undefined): value is string {
    return value !== undefined && value.length > 0;
}

export function getString(record: JsonObject, key: string): string | undefined {
    return stringParser.parse(record[key]);
}

export function getNonEmptyString(record: JsonObject, key: string): string | undefined {
    const value = getString(record, key);
    return isNonEmptyString(value) ? value : undefined;
}

export function getNumber(record: JsonObject, key: string): number | undefined {
    return numberParser.parse(record[key]);
}

export function getBoolean(record: JsonObject, key: string): boolean | undefined {
    return booleanParser.parse(record[key]);
}

export function getArray(record: JsonObject, key: string): ReadonlyArray<JsonValue> | undefined {
    return jsonArrayParser.parse(record[key]);
}

export function displayToolName(toolName: string): string {
    return toolName.length > 0 ? toolName : "tool";
}

export function baseToolName(toolName: string): string {
    const match = NAMESPACED_TOOL_PREFIX_PATTERN.exec(toolName);
    return match?.groups?.name ?? toolName;
}
