import { type JsonObject } from "./json-value.ts";
/** Remove editor-only metadata from a decoded settings file. */
export declare function settingsLayerFromFile(file: JsonObject): JsonObject;
/** Deep-merge settings objects. Objects merge recursively; arrays and scalars replace. */
export declare function mergeSettings(current: JsonObject, next: JsonObject): JsonObject;
//# sourceMappingURL=settings-merge.d.ts.map