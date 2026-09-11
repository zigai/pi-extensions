import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
    colorSwatch,
    completeSettingsPath,
    formatSliderValue,
    stepSettingsNumber,
} from "../src/settings-controls.ts";

const integerSlider = {
    _tag: "NumberControl" as const,
    presentation: "slider" as const,
    integer: true,
    minimum: 1,
    exclusiveMinimum: undefined,
    maximum: 5,
    exclusiveMaximum: undefined,
    multipleOf: undefined,
};

describe("settings control behavior", () => {
    it("steps and renders bounded numeric sliders", () => {
        expect(stepSettingsNumber(integerSlider, 3, 1)).toBe(4);
        expect(stepSettingsNumber(integerSlider, undefined, 1)).toBe(1);
        expect(stepSettingsNumber(integerSlider, 5, 1)).toBe(5);
        expect(stepSettingsNumber(integerSlider, 1, -1)).toBe(1);
        expect(formatSliderValue(integerSlider, 3)).toBe("3 [████░░░░]");
    });

    it("renders hexadecimal colors as terminal swatches", () => {
        expect(colorSwatch("#123")).toContain("48;2;17;34;51m");
        expect(colorSwatch("#112233")).toContain("48;2;17;34;51m");
        expect(colorSwatch("accent")).toBeUndefined();
    });

    it("completes filesystem paths without changing the filesystem", () => {
        const cwd = mkdtempSync(join(tmpdir(), "pi-settings-ui-"));
        try {
            mkdirSync(join(cwd, "alpha"));
            mkdirSync(join(cwd, "alpine"));
            mkdirSync(join(cwd, "beta"));
            mkdirSync(join(cwd, ".hidden"));

            expect(completeSettingsPath("a", cwd)).toEqual({
                _tag: "PathMatches",
                value: "alp",
                matches: ["alpha/", "alpine/"],
            });

            expect(completeSettingsPath("alph", cwd)).toEqual({
                _tag: "PathCompleted",
                value: "alpha/",
            });

            expect(completeSettingsPath("z", cwd)).toEqual({
                _tag: "PathUnavailable",
                message: "No matching paths.",
            });
            const visibleEntries = completeSettingsPath("", cwd);
            expect(visibleEntries._tag).toBe("PathMatches");

            if (visibleEntries._tag === "PathMatches") {
                expect(visibleEntries.matches).not.toContain(".hidden/");
            }
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
