import { describe, expect, it } from "vitest";

import {
    cloneJson,
    formatJson,
    isJsonArray,
    isJsonObject,
    isJsonValue,
    parseJson,
} from "../src/json-value.ts";

describe("JSON values", () => {
    it("accepts only finite, plain JSON values", () => {
        expect(isJsonValue(null)).toBe(true);
        expect(isJsonValue(true)).toBe(true);
        expect(isJsonValue("text")).toBe(true);
        expect(isJsonValue(4.5)).toBe(true);
        expect(isJsonValue([1, { nested: false }])).toBe(true);
        expect(isJsonArray([1, 2])).toBe(true);
        expect(isJsonObject({ value: 1 })).toBe(true);

        expect(isJsonValue(Number.NaN)).toBe(false);
        expect(isJsonValue(1n)).toBe(false);
        expect(isJsonValue(Symbol("x"))).toBe(false);
        expect(isJsonValue(undefined)).toBe(false);
        expect(isJsonValue(() => undefined)).toBe(false);
        expect(isJsonValue(new Date())).toBe(false);
        expect(isJsonArray({ 0: "not-array" })).toBe(false);
    });

    it("parses, clones, and formats without sharing mutable state", () => {
        const parsed = parseJson('{"items":[1,2]}');
        expect(parsed).toEqual({ items: [1, 2] });
        expect(parseJson("not json")).toBeUndefined();

        if (!isJsonObject(parsed)) return;
        const cloned = cloneJson(parsed);
        expect(cloned).toEqual(parsed);
        expect(cloned).not.toBe(parsed);
        expect(formatJson(cloned)).toBe('{\n  "items": [\n    1,\n    2\n  ]\n}\n');
    });
});
