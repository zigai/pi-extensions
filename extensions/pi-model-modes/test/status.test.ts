import assert from "node:assert/strict";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

import { applyThinkingLevelStatusPatch } from "../src/status.ts";

type TestInteractiveModePrototype = {
    showStatus(this: void, message: string): void;
};

test("thinking level status patches and restores the public InteractiveMode", async () => {
    const original = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "showStatus");
    const restore = await applyThinkingLevelStatusPatch({
        shouldShowThinkingLevelStatus: () => false,
    });
    assert.notDeepEqual(
        Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "showStatus"),
        original,
    );

    restore();
    assert.deepEqual(
        Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "showStatus"),
        original,
    );
});

test("thinking level status patch uses latest settings reader after reinstall", async () => {
    const messages: string[] = [];
    const prototype: TestInteractiveModePrototype = {
        showStatus(message: string): void {
            messages.push(message);
        },
    };
    const module = { InteractiveMode: { prototype } };

    const restore = await applyThinkingLevelStatusPatch({
        async loadInteractiveModeModule() {
            return module;
        },
        shouldShowThinkingLevelStatus() {
            return false;
        },
    });
    prototype.showStatus("Thinking level: high");
    assert.deepEqual(messages, []);

    await applyThinkingLevelStatusPatch({
        async loadInteractiveModeModule() {
            return module;
        },
        shouldShowThinkingLevelStatus() {
            return true;
        },
    });
    prototype.showStatus("Thinking level: high");
    assert.deepEqual(messages, ["Thinking level: high"]);
    restore();
});

test("thinking level status patch restores its linked predecessor", async () => {
    const messages: string[] = [];
    const prototype: TestInteractiveModePrototype = {
        showStatus(message: string) {
            messages.push(message);
        },
    };
    const original = prototype.showStatus;

    const restore = await applyThinkingLevelStatusPatch({
        async loadInteractiveModeModule() {
            return { InteractiveMode: { prototype } };
        },
        shouldShowThinkingLevelStatus() {
            return false;
        },
    });
    restore();
    assert.equal(prototype.showStatus, original);
    prototype.showStatus("Thinking level: medium");
    assert.deepEqual(messages, ["Thinking level: medium"]);
});
