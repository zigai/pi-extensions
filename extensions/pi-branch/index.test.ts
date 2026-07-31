import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
    BranchConfigFileSchema,
    CONFIG_SCHEMA_ID,
    gridColumnCount,
    parseTypedArgs,
    tmuxGridRowPaneCounts,
    tmuxRemainingRegionPercent,
} from "./index.ts";

describe("branch layouts", () => {
    it.each([
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 2],
        [5, 3],
        [6, 3],
        [9, 3],
        [10, 4],
    ])("uses a balanced column count for %i panes", (paneCount, expectedColumns) => {
        expect(gridColumnCount(paneCount)).toBe(expectedColumns);
    });

    it.each([
        [1, [1]],
        [4, [2, 2]],
        [5, [3, 2]],
        [6, [3, 3]],
        [7, [3, 2, 2]],
        [8, [3, 3, 2]],
        [10, [4, 3, 3]],
    ])("builds a balanced row-first grid for %i panes", (paneCount, expectedRows) => {
        expect(tmuxGridRowPaneCounts(paneCount)).toEqual(expectedRows);
    });

    it.each([
        [2, 50],
        [3, 67],
        [4, 75],
    ])("reserves the expected percentage for %i regions", (regionCount, expectedPercent) => {
        expect(tmuxRemainingRegionPercent(regionCount)).toBe(expectedPercent);
    });

    it.each([
        ["separate", "windows"],
        ["current-tab", "panes"],
        ["new-tab", "pane-window"],
    ] as const)("maps %s to %s launch mode", (layout, expectedMode) => {
        expect(
            parseTypedArgs({
                count: 3,
                layout,
                keepOpen: true,
                worktree: false,
                prompt: "compare approaches",
            }),
        ).toEqual({
            count: 3,
            mode: expectedMode,
            prompt: "compare approaches",
            keepOpen: true,
            worktree: false,
        });
    });
});

describe("configuration schema", () => {
    it("matches the checked-in editor schema", () => {
        const actual: unknown = JSON.parse(readFileSync("config.schema.json", "utf8"));
        expect(actual).toEqual({
            $schema: "https://json-schema.org/draft/2020-12/schema",
            $id: CONFIG_SCHEMA_ID,
            ...BranchConfigFileSchema,
        });
    });
});
