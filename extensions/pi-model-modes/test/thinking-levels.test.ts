import assert from "node:assert/strict";
import { test } from "vitest";

import {
    ALL_THINKING_LEVELS,
    isThinkingLevel,
    normalizeThinkingLevel,
} from "../src/thinking-levels.ts";

test("thinking levels accept every supported value without normalization changes", () => {
    assert.deepEqual(ALL_THINKING_LEVELS, [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]);

    for (const level of ALL_THINKING_LEVELS) {
        assert.equal(isThinkingLevel(level), true);
        assert.equal(normalizeThinkingLevel(level), level);
    }

    assert.equal(normalizeThinkingLevel(undefined), undefined);
});

test("thinking level validation rejects unknown or differently cased values", () => {
    for (const value of ["", "HIGH", " high", "high ", "unlimited"]) {
        assert.equal(isThinkingLevel(value), false);
    }
});
