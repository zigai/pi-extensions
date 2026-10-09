import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { test } from "vitest";

import { registerModeSelectorShortcuts } from "../src/mode-picker.ts";

type ShortcutOptions = Parameters<ExtensionAPI["registerShortcut"]>[1];

test("registers the mode selector without taking Ctrl+K", () => {
    const shortcuts = new Map<string, ShortcutOptions>();
    const registrar: Pick<ExtensionAPI, "registerShortcut"> = {
        registerShortcut(shortcut, options): void {
            shortcuts.set(shortcut, options);
        },
    };
    const selectMode: ShortcutOptions["handler"] = () => {};

    registerModeSelectorShortcuts(registrar, selectMode);
    assert.equal(shortcuts.has("ctrl+k"), false);
    assert.equal(shortcuts.get("ctrl+shift+m")?.description, "Select prompt mode");
    assert.equal(shortcuts.get("ctrl+shift+m")?.handler, selectMode);
});
