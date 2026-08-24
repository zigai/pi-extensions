import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import {
    cloneJson,
    formatJson,
    isJsonArray,
    isJsonObject,
    JsonValueSchema,
    parseJson,
} from "../src/json-value.ts";

describe("JSON values", () => {
    it("parses only finite JSON values", () => {
        expect(parseJson("null")).toBeNull();
        expect(parseJson("true")).toBe(true);
        expect(parseJson('"text"')).toBe("text");
        expect(parseJson("4.5")).toBe(4.5);
        expect(parseJson('[1,{"nested":false}]')).toEqual([1, { nested: false }]);
        expect(isJsonArray([1, 2])).toBe(true);
        expect(isJsonObject({ value: 1 })).toBe(true);

        class JsonCarrier {
            readonly value = 1;
        }
        const symbolKeyed = { value: 1, [Symbol("hidden")]: "not JSON" };
        const spoofedTag = { value: 1, [Symbol.toStringTag]: "Object" };
        const nullPrototype = { value: 1 };
        Reflect.setPrototypeOf(nullPrototype, null);

        expect(parseJson("1e999")).toBeUndefined();
        expect(parseJson("not json")).toBeUndefined();
        expect(Value.Check(JsonValueSchema, { nested: new Date() })).toBe(false);
        expect(Value.Check(JsonValueSchema, { nested: new JsonCarrier() })).toBe(false);
        expect(Value.Check(JsonValueSchema, new JsonCarrier())).toBe(false);
        expect(Value.Check(JsonValueSchema, symbolKeyed)).toBe(false);
        expect(Value.Check(JsonValueSchema, spoofedTag)).toBe(false);
        expect(Value.Check(JsonValueSchema, { nested: Number.NaN })).toBe(false);
        expect(Value.Check(JsonValueSchema, { nested: Number.POSITIVE_INFINITY })).toBe(false);
        expect(Value.Check(JsonValueSchema, nullPrototype)).toBe(true);
        expect(isJsonObject(nullPrototype)).toBe(true);
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
