import assert from "node:assert/strict";
import { test } from "vitest";

import { resolveModeShortcuts } from "../src/settings.ts";
import { isShortcutId } from "../src/shortcut-id.ts";

test("leaves mode cycling unbound when no shortcut is configured", () => {
    assert.deepEqual(resolveModeShortcuts(undefined), {});
});

test("preserves explicit mode shortcut overrides", () => {
    assert.deepEqual(
        resolveModeShortcuts({ forward: "ctrl+space", backward: "ctrl+shift+space" }),
        { forward: "ctrl+space", backward: "ctrl+shift+space" },
    );
});

test("accepts plus as a shortcut base key", () => {
    assert.equal(isShortcutId("+"), true);
    assert.equal(isShortcutId("ctrl++"), true);
    assert.equal(isShortcutId("ctrl+shift++"), true);
});

test("rejects malformed plus shortcuts", () => {
    assert.equal(isShortcutId("++"), false);
    assert.equal(isShortcutId("ctrl+++"), false);
    assert.equal(isShortcutId("ctrl+ctrl++"), false);
});
