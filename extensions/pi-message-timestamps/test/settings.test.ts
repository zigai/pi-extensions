import { defineExtensionSettings } from "@zigai/pi-extension-settings";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import input, { settingsSchema } from "../src/settings-input.ts";

describe("message timestamp settings", () => {
    it("defines a valid settings contract with automatic formatting enabled by default", () => {
        const definition = defineExtensionSettings(input);
        expect(definition.id).toBe("pi-message-timestamps");
        expect(definition.defaultSettings).toEqual({
            enabled: true,
            format: "auto",
            assistantPlacement: "first-line",
        });
    });

    it("accepts each format and rejects invalid options and unknown properties", () => {
        const base = { enabled: true, format: "auto", assistantPlacement: "first-line" };
        for (const format of ["auto", "time-only", "date-time", "relative"]) {
            expect(Value.Check(settingsSchema, { ...base, format })).toBe(true);
        }

        for (const assistantPlacement of ["first-line", "last-line", "below"]) {
            expect(Value.Check(settingsSchema, { ...base, assistantPlacement })).toBe(true);
        }

        expect(Value.Check(settingsSchema, { ...base, enabled: false, format: "relative" })).toBe(
            true,
        );

        expect(Value.Check(settingsSchema, { ...base, format: "custom" })).toBe(false);
        expect(Value.Check(settingsSchema, { ...base, assistantPlacement: "top" })).toBe(false);
        expect(Value.Check(settingsSchema, { ...base, extra: true })).toBe(false);
        expect(Value.Check(settingsSchema, { ...base, enabled: "yes" })).toBe(false);
    });
});
