import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { registerNativeCompactionDisplay } from "../src/compaction/display.ts";

import extension from "../src/index.ts";
import {
    NATIVE_COMPACTION_MESSAGE_TEXT,
    NATIVE_COMPACTION_MESSAGE_TYPE,
} from "../src/compaction/messages.ts";
import { makeExtensionHarness, testDouble } from "./helpers.ts";

test("native compaction renderer displays checkpoint details at normal and narrow widths", () => {
    const harness = makeExtensionHarness();
    extension(harness.api);
    const component = harness.renderMessage(NATIVE_COMPACTION_MESSAGE_TYPE, {});

    assert.deepEqual(component.render(200), NATIVE_COMPACTION_MESSAGE_TEXT.split("\n"));
    assert.deepEqual(
        component.render(12).map(stripVTControlCharacters),
        NATIVE_COMPACTION_MESSAGE_TEXT.split("\n").map((line) => line.slice(0, 12)),
    );
});

test("native compaction renderer clips colored CJK and emoji by terminal columns", () => {
    type Renderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];
    let renderer: Renderer | undefined;
    registerNativeCompactionDisplay(
        testDouble<ExtensionAPI>()({
            registerMessageRenderer(type: string, callback: Renderer) {
                assert.equal(type, NATIVE_COMPACTION_MESSAGE_TYPE);
                renderer = callback;
            },
        }),
    );
    assert.ok(renderer);
    const theme = testDouble<Theme>()({
        fg(color: string, text: string) {
            assert.equal(color, "dim");
            return `\u001b[38;2;100;120;140m${text}\u001b[39m`;
        },
    });
    const component = renderer(
        {
            role: "custom",
            customType: NATIVE_COMPACTION_MESSAGE_TYPE,
            content: "界🙂Z\nAB界C",
            display: true,
            timestamp: 0,
        },
        { expanded: false, outputPad: 0 },
        theme,
    );
    assert.ok(component);
    for (const [width, expected] of [
        [0, ["", ""]],
        [1, ["", "A"]],
        [2, ["界", "AB"]],
        [3, ["界", "AB"]],
        [4, ["界🙂", "AB界"]],
        [5, ["界🙂Z", "AB界C"]],
    ] as const) {
        const lines = component.render(width);
        assert.deepEqual(lines.map(stripVTControlCharacters), expected);
        for (const line of lines) {
            assert.ok(visibleWidth(line) <= width);
            // Every escape must start a complete SGR sequence, including at the clipped edge.
            for (const segment of line.split("\u001b").slice(1)) {
                assert.match(segment, /^\[[0-9;]*m/);
            }
        }
    }
});

type MutableCompactionMessage = {
    content: string | { readonly unsupported: true };
};

test("native compaction renderer reflects message updates after invalidation", () => {
    const harness = makeExtensionHarness();
    extension(harness.api);
    const message: MutableCompactionMessage = { content: "Initial checkpoint\nSecond line" };
    const component = harness.renderMessage(NATIVE_COMPACTION_MESSAGE_TYPE, message);

    assert.deepEqual(component.render(80), ["Initial checkpoint", "Second line"]);

    message.content = "Updated checkpoint";
    assert.doesNotThrow(() => component.invalidate());
    assert.deepEqual(component.render(8).map(stripVTControlCharacters), ["Updated "]);

    message.content = { unsupported: true };
    component.invalidate();
    assert.deepEqual(component.render(200), NATIVE_COMPACTION_MESSAGE_TEXT.split("\n"));
});
