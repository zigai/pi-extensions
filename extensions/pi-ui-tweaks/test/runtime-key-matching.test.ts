import assert from "node:assert/strict";
import { matchesKey } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { matchesRuntimeKey } from "../src/runtime-key-matching.ts";

test("configured keys retain Pi's installed runtime grammar beyond KeyId autocomplete", () => {
    assert.equal(matchesRuntimeKey("\x03", "CTRL+C"), matchesKey("\x03", "ctrl+c"));
    assert.equal(matchesRuntimeKey("\x03", "ctrl+ctrl+c"), true);
    assert.equal(matchesRuntimeKey("\r", "RETURN"), true);
    assert.equal(matchesRuntimeKey("x", "x"), true);
    assert.equal(matchesRuntimeKey("y", "x"), false);
});

test("malformed configured identifiers retain Pi's non-matching behavior", () => {
    for (const key of ["", "ctrl+", "not-a-key", "ctrl+not-a-key", "+"]) {
        assert.equal(matchesRuntimeKey("\x03", key), false);
    }
});
