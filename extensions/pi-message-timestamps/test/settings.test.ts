import { defineExtensionSettings } from "@zigai/pi-extension-settings";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import input, { settingsSchema } from "../src/settings-input.ts";

describe("message timestamp settings", () => {
    it("defines a valid settings contract with automatic formatting enabled by default", () => {
        const definition = defineExtensionSettings(input);
        expect(definition.id).toBe("pi-message-timestamps");
        expect(definition.defaultSettings).toEqual({ enabled: true, format: "auto" });
    });

    it("accepts each format and rejects invalid options and unknown properties", () => {
        for (const format of ["auto", "time-only", "date-time", "relative"]) {
            expect(Value.Check(settingsSchema, { enabled: true, format })).toBe(true);
        }

        expect(Value.Check(settingsSchema, { enabled: false, format: "relative" })).toBe(true);
        expect(Value.Check(settingsSchema, { enabled: true, format: "custom" })).toBe(false);
        expect(Value.Check(settingsSchema, { enabled: true, format: "auto", extra: true })).toBe(
            false,
        );

        expect(Value.Check(settingsSchema, { enabled: "yes", format: "auto" })).toBe(false);
    });
});
