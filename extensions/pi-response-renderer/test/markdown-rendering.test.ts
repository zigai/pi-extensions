import assert from "node:assert/strict";
import { test } from "vitest";

import { collapseAssistantBlankLines } from "../src/markdown-rendering.ts";

test("keeps boundary blanks while collapsing only interior paragraph gaps", () => {
    assert.deepEqual(collapseAssistantBlankLines([], "", new Set()), []);
    assert.deepEqual(collapseAssistantBlankLines([""], "", new Set()), [""]);
    assert.deepEqual(
        collapseAssistantBlankLines(
            ["", "First paragraph.", "", "Last paragraph.", ""],
            "",
            new Set(),
        ),
        ["", "First paragraph.", "Last paragraph.", ""],
    );
});
