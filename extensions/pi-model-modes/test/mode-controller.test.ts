import assert from "node:assert/strict";
import { test } from "vitest";

import { ModeController } from "../src/mode-controller.ts";

function createController(): ModeController {
    return new ModeController({
        getThinkingLevel: () => "medium",
        setThinkingLevel: () => {},
        setModel: async () => true,
    });
}

test("mode controllers own independent runtime state", () => {
    const first = createController();
    const second = createController();

    first.setEditorRenderRequest(() => {});
    first.setUseThinkingBorderColors(true);
    first.setShowThinkingLevelStatus(true);
    assert.equal(first.currentMode, "default");
    assert.equal(second.currentMode, "default");
    assert.notEqual(first.modes, second.modes);
    assert.equal(first.thinkingBorderColorsEnabled, true);
    assert.equal(second.thinkingBorderColorsEnabled, false);
    assert.equal(first.thinkingLevelStatusEnabled, true);
    assert.equal(second.thinkingLevelStatusEnabled, false);
});

test("mode controller derives settings reads from the explicit extension context", () => {
    const controller = createController();
    assert.deepEqual(
        controller.getSettingsContext({
            cwd: "/workspace/project",
            isProjectTrusted: () => true,
        }),
        { cwd: "/workspace/project", projectTrusted: true },
    );
});
