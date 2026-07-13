import { describe, expect, it } from "vitest";
import {
    isActiveToolCall,
    shouldDeferSimpleToolCall,
    toolStatusLabel,
} from "../src/rendering/status-labels.ts";

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

    it("treats persisted results as completed despite stale partial flags", () => {
        expect(
            isActiveToolCall({ isPartial: true, argsComplete: false, result: { details: {} } }),
        ).toBe(false);
    });

    it("defers simple calls until arguments are complete", () => {
        expect(shouldDeferSimpleToolCall({ isPartial: true, argsComplete: false })).toBe(true);
        expect(shouldDeferSimpleToolCall({ isPartial: false, argsComplete: false })).toBe(true);
        expect(shouldDeferSimpleToolCall({ isPartial: false, argsComplete: true })).toBe(false);
    });
});
