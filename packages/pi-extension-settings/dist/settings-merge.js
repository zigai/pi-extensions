import { cloneJson, isJsonObject } from "./json-value.js";
function mergeValue(current, next) {
    if (!isJsonObject(current) || !isJsonObject(next))
        return cloneJson(next);
    const merged = {};
    for (const [key, value] of Object.entries(current))
        merged[key] = cloneJson(value);
    for (const [key, value] of Object.entries(next)) {
        merged[key] = mergeValue(merged[key], value);
    }
    return merged;
}
/** Remove editor-only metadata from a decoded settings file. */
export function settingsLayerFromFile(file) {
    const settings = {};
    for (const [key, value] of Object.entries(file)) {
        if (key === "$schema")
            continue;
        settings[key] = cloneJson(value);
    }
    return settings;
}
/** Deep-merge settings objects. Objects merge recursively; arrays and scalars replace. */
export function mergeSettings(current, next) {
    const merged = mergeValue(current, next);
    if (!isJsonObject(merged)) {
        throw new TypeError("Settings merge unexpectedly produced a non-object value.");
    }
    return merged;
}
//# sourceMappingURL=settings-merge.js.map