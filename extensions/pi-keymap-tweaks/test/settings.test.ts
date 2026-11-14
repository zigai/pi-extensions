import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { resolveKeymapTweaksConfig } from "../src/settings.ts";

describe("resolveKeymapTweaksConfig", () => {
    it("uses default null key when settings sources are empty or invalid", () => {
        assert.deepEqual(resolveKeymapTweaksConfig([]).config, {
            continueLists: true,
            cycleThinkingBackwardKey: null,
            undoEarlyCancel: true,
        });
        assert.deepEqual(
            resolveKeymapTweaksConfig([
                { label: "test", settings: { cycleThinkingBackwardKey: 123 } },
            ]).config,
            {
                continueLists: true,
                cycleThinkingBackwardKey: null,
                undoEarlyCancel: true,
            },
        );
    });

    it("resolves valid cycleThinkingBackwardKey string", () => {
        const loaded = resolveKeymapTweaksConfig([
            { label: "test", settings: { cycleThinkingBackwardKey: "alt+shift+tab" } },
        ]);
        assert.deepEqual(loaded.config, {
            continueLists: true,
            cycleThinkingBackwardKey: "alt+shift+tab",
            undoEarlyCancel: true,
        });
        assert.deepEqual(loaded.errors, []);
    });
});
