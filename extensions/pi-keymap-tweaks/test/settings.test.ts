import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { resolveKeymapTweaksConfig } from "../src/settings.ts";

describe("resolveKeymapTweaksConfig", () => {
    it("uses default null key when settings sources are empty or invalid", () => {
        assert.deepEqual(resolveKeymapTweaksConfig([]).config, {
            cycleThinkingBackwardKey: null,
        });
        assert.deepEqual(
            resolveKeymapTweaksConfig([
                { label: "test", settings: { cycleThinkingBackwardKey: 123 } },
            ]).config,
            {
                cycleThinkingBackwardKey: null,
            },
        );
    });

    it("resolves valid cycleThinkingBackwardKey string", () => {
        const loaded = resolveKeymapTweaksConfig([
            { label: "test", settings: { cycleThinkingBackwardKey: "alt+shift+tab" } },
        ]);
        assert.deepEqual(loaded.config, {
            cycleThinkingBackwardKey: "alt+shift+tab",
        });
        assert.deepEqual(loaded.errors, []);
    });
});
