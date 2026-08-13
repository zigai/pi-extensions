import assert from "node:assert/strict";
import { test } from "vitest";

import extension from "../src/index.ts";
import {
    NATIVE_COMPACTION_MESSAGE_TEXT,
    NATIVE_COMPACTION_MESSAGE_TYPE,
} from "../src/compaction/messages.ts";
import { makeExtensionHarness } from "./helpers.ts";

test("native compaction renderer displays checkpoint details at normal and narrow widths", () => {
    const harness = makeExtensionHarness();
    extension(harness.api);
    const component = harness.renderMessage(NATIVE_COMPACTION_MESSAGE_TYPE, {});

    assert.deepEqual(component.render(200), NATIVE_COMPACTION_MESSAGE_TEXT.split("\n"));
    assert.deepEqual(
        component.render(12),
        NATIVE_COMPACTION_MESSAGE_TEXT.split("\n").map((line) => line.slice(0, 12)),
    );
});

test("native compaction renderer reflects message updates after invalidation", () => {
    const harness = makeExtensionHarness();
    extension(harness.api);
    const message: { content: unknown } = { content: "Initial checkpoint\nSecond line" };
    const component = harness.renderMessage(NATIVE_COMPACTION_MESSAGE_TYPE, message);

    assert.deepEqual(component.render(80), ["Initial checkpoint", "Second line"]);

    message.content = "Updated checkpoint";
    assert.doesNotThrow(() => component.invalidate());
    assert.deepEqual(component.render(8), ["Updated "]);

    message.content = { unsupported: true };
    component.invalidate();
    assert.deepEqual(component.render(200), NATIVE_COMPACTION_MESSAGE_TEXT.split("\n"));
});
