import { getString, type UnknownRecord } from "../unknown-values.ts";

export { getString, isRecord } from "../unknown-values.ts";
export type { UnknownRecord } from "../unknown-values.ts";

const NAMESPACED_TOOL_PREFIX_PATTERN = /^[A-Za-z0-9_-]+__(?<name>.+)$/;

export function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

export function isNonEmptyString(value: string | undefined): value is string {
    return value !== undefined && value.length > 0;
}

export function getNonEmptyString(record: UnknownRecord, key: string): string | undefined {
    const value = getString(record, key);
    return isNonEmptyString(value) ? value : undefined;
}

export function getNumber(record: UnknownRecord, key: string): number | undefined {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function getBoolean(record: UnknownRecord, key: string): boolean | undefined {
    const value = record[key];
    return typeof value === "boolean" ? value : undefined;
}

export function getArray(record: UnknownRecord, key: string): ReadonlyArray<unknown> | undefined {
    const value = record[key];
    return Array.isArray(value) ? value : undefined;
}

export function displayToolName(toolName: string): string {
    return toolName.length > 0 ? toolName : "tool";
}

export function baseToolName(toolName: string): string {
    const match = NAMESPACED_TOOL_PREFIX_PATTERN.exec(toolName);
    return match?.groups?.name ?? toolName;
}

export function compactInteger(value: number): string {
    const normalized = Math.max(0, Math.trunc(value));
    if (normalized < 100_000) {
        return normalized.toLocaleString("en-US");
    }
    if (normalized < 1_000_000) {
        return `${(normalized / 1_000).toLocaleString("en-US", { maximumFractionDigits: 0 })}K`;
    }
    return `${(normalized / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
}
