import assert from "node:assert/strict";
import { Theme } from "@earendil-works/pi-coding-agent";
import { SelectList } from "@earendil-works/pi-tui";
import { test } from "vitest";

import {
    installSelectedOptionPrefixSelectListPatch,
    installSelectedOptionPrefixThemePatch,
} from "../src/selected-option-prefix.ts";
import { captureConsoleWarnings } from "./capture-console-warnings.ts";

function createList(): SelectList {
    return new SelectList(
        [{ value: "settings", label: "settings", description: "Open settings menu" }],
        5,
        {
            selectedPrefix: (text) => text,
            selectedText: (text) => text,
            description: (text) => text,
            scrollInfo: (text) => text,
            noMatch: (text) => text,
        },
    );
}

test("explicit null does not patch Pi's default select-list prototype", async () => {
    const warnings = await captureConsoleWarnings(() => {
        const originalRender = Object.getOwnPropertyDescriptor(SelectList.prototype, "render");
        const handle = installSelectedOptionPrefixSelectListPatch(
            { selectedOptionPrefix: "▌" },
            null,
        );

        assert.deepEqual(
            Object.getOwnPropertyDescriptor(SelectList.prototype, "render"),
            originalRender,
        );

        handle.dispose();
    });

    assert.deepEqual(warnings, [
        "[pi-ui-tweaks] selected option prefix patch unavailable; Pi internals may have changed",
    ]);
});

test("selected option prefix updates generic select-list markers", () => {
    const handle = installSelectedOptionPrefixSelectListPatch({ selectedOptionPrefix: "▌" });
    assert.equal(
        createList().render(80)[0],
        "▌ settings                        Open settings menu",
    );

    handle.update({ selectedOptionPrefix: "→ " });
    assert.equal(createList().render(80)[0]?.startsWith("→ settings"), true);
    handle.dispose();
});

test("selected option prefix patches the public live Theme prototype and restores it", async () => {
    const original = Theme.prototype.fg;
    const handle = await installSelectedOptionPrefixThemePatch({ selectedOptionPrefix: "▌" });
    const patched = Theme.prototype.fg;
    assert.notEqual(patched, original);
    assert.equal(
        await installSelectedOptionPrefixThemePatch({ selectedOptionPrefix: "→ " }),
        handle,
    );
    assert.equal(Theme.prototype.fg, patched);
    handle.dispose();
    assert.equal(Theme.prototype.fg, original);
});
