export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getString(record: UnknownRecord, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

export function stringField(value: unknown, key: string): string | undefined {
    return isRecord(value) ? getString(value, key) : undefined;
}
