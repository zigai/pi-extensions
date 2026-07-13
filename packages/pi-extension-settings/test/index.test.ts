import { describe, expect, it } from "vitest";

import { createGreeting } from "../src/index.ts";

describe("createGreeting", () => {
    it("creates a normalized greeting", () => {
        expect(createGreeting({ name: " Ada " })).toBe("Hello, Ada!");
        expect(createGreeting({ name: "   " })).toBe("Hello, world!");
    });

    it("creates an excited greeting", () => {
        expect(createGreeting({ name: "Ada", excited: true })).toBe("HELLO, ADA!");
    });
});
