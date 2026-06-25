/** Return whether a value is a non-array object suitable for skill metadata inspection. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return a string value when present, otherwise `undefined`. */
export function optionalString(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value;
    }
    return undefined;
}

/** Return a boolean value when present, otherwise `undefined`. */
export function optionalBoolean(value: unknown): boolean | undefined {
    if (typeof value === "boolean") {
        return value;
    }
    return undefined;
}

/** Return a finite number value when present, otherwise `undefined`. */
export function optionalNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    return undefined;
}

/** Return a non-negative integer value when present, otherwise `undefined`. */
export function optionalNonNegativeInteger(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
    }
    return undefined;
}

/** Return a string array when every element is a string, otherwise `undefined`. */
export function optionalStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const items = value.filter((item): item is string => typeof item === "string");
    if (items.length !== value.length) {
        return undefined;
    }
    return items;
}

/** Create a null-prototype record for user-controlled dotted skill argument paths. */
export function createSafeRecord(): Record<string, unknown> {
    return Object.create(null) as Record<string, unknown>;
}
