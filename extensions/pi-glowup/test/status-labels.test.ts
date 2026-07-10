import { describe, expect, it } from "vitest";
import { isActiveToolCall, toolStatusLabel } from "../src/rendering/status-labels.ts";

const labels = {
    static: "Explore",
    active: "Exploring",
    completed: "Explored",
} as const;

describe("tool status labels", () => {
    it("keeps static vocabulary stable across lifecycle states", () => {
        expect(toolStatusLabel("static", { isPartial: true }, labels)).toBe("Explore");
        expect(toolStatusLabel("static", { isPartial: false }, labels)).toBe("Explore");
    });

    it("uses active and completed vocabulary in lifecycle mode", () => {
        expect(toolStatusLabel("lifecycle", { isPartial: true }, labels)).toBe("Exploring");
        expect(toolStatusLabel("lifecycle", { isPartial: false }, labels)).toBe("Explored");
    });

    it("treats incomplete arguments as active", () => {
        expect(isActiveToolCall({ isPartial: false, argsComplete: false })).toBe(true);
        expect(
            toolStatusLabel("lifecycle", { isPartial: false, argsComplete: false }, labels),
        ).toBe("Exploring");
    });
});
