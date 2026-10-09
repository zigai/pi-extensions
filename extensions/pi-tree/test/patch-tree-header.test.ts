import assert from "node:assert/strict";
import { test } from "vitest";

import { Text } from "@earendil-works/pi-tui";

import {
    patchTreeHeaderText,
    restoreTreeHeaderText,
    type TreeHeaderPatchTarget,
} from "../src/patch-tree-header.ts";

type TestComponent = {
    text?: string;
    invalidate(): void;
    render(width: number): string[];
};

function component(text: string): TestComponent {
    return {
        text,
        invalidate(): void {},
        render(): string[] {
            return [this.text ?? ""];
        },
    };
}

test("tree header patch is selector-scoped and reversible", () => {
    restoreTreeHeaderText();
    const originalTextRender = Object.getOwnPropertyDescriptor(Text.prototype, "render");
    const added: unknown[] = [];
    const prototype: TreeHeaderPatchTarget = {
        addChild(child): void {
            added.push(child);
        },
    };
    const title = component("\u001b[1m  Session Tree\u001b[22m");
    const legacyHelp = component("  ↑/↓: move. left/right: page");
    const ordinary = component("ordinary text");

    try {
        patchTreeHeaderText(prototype);
        prototype.addChild(title);
        prototype.addChild(legacyHelp);
        prototype.addChild(ordinary);
        assert.deepEqual(added, [legacyHelp, ordinary]);
        assert.equal(legacyHelp.text?.includes("shift+p: preview"), true);
        assert.deepEqual(
            Object.getOwnPropertyDescriptor(Text.prototype, "render"),
            originalTextRender,
        );

        restoreTreeHeaderText();
        prototype.addChild(title);
        assert.deepEqual(added, [legacyHelp, ordinary, title]);
    } finally {
        restoreTreeHeaderText();
    }
});
