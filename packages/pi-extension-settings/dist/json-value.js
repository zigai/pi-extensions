function isRecord(value) {
    return (value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.prototype.toString.call(value) === "[object Object]");
}
/** Return whether a value can be represented losslessly in JSON. */
export function isJsonValue(value) {
    if (value === null)
        return true;
    switch (typeof value) {
        case "boolean":
        case "string":
            return true;
        case "number":
            return Number.isFinite(value);
        case "object":
            if (Array.isArray(value))
                return value.every(isJsonValue);
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
export function isJsonArray(value) {
    return Array.isArray(value) && value.every((item) => isJsonValue(item));
}
/** Return whether a value is a JSON object rather than an array or null. */
export function isJsonObject(value) {
    return isRecord(value) && Object.values(value).every(isJsonValue);
}
/** Clone a JSON value so callers never receive mutable internal state. */
export function cloneJson(value) {
    return structuredClone(value);
}
/** Parse text as a JSON value without trusting the result of `JSON.parse`. */
export function parseJson(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    return isJsonValue(parsed) ? parsed : undefined;
}
/** Serialize JSON deterministically with a trailing newline. */
export function formatJson(value) {
    return `${JSON.stringify(value, undefined, 2)}\n`;
}
//# sourceMappingURL=json-value.js.map