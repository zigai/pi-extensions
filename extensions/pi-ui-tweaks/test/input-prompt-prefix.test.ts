import assert from "node:assert/strict";
import { Input } from "@earendil-works/pi-tui";
import { test } from "vitest";

import { installInputPromptPrefixPatch } from "../src/input-prompt-prefix.ts";

type InputPrototypeView = {
    readonly render: (width: number) => string[];
};

test("input prompt prefix updates and disposes the single-line marker", () => {
    const prototype: InputPrototypeView = Input.prototype;
    const original = prototype.render;
    const handle = installInputPromptPrefixPatch({ inputPromptPrefix: "❯" });
    assert.equal((new Input().render(10)[0] ?? "").startsWith("❯ \u001b[7m"), true);
    handle.update({ inputPromptPrefix: "> " });
    assert.equal((new Input().render(10)[0] ?? "").startsWith("> \u001b[7m"), true);
    handle.dispose();
    assert.equal(prototype.render, original);
});

for (const state of [
    {},
    { value: 1, cursor: 0, focused: true },
    { value: "text", cursor: "0", focused: true },
    { value: "text", cursor: Number.NaN, focused: true },
    { value: "text", cursor: Number.POSITIVE_INFINITY, focused: true },
    { value: "text", cursor: 0, focused: "yes" },
]) {
    test(`incompatible input state preserves predecessor rendering: ${JSON.stringify(state)}`, () => {
        const target = {
            ...state,
            render(width: number): string[] {
                return [`native:${width}`];
            },
        };
        const handle = installInputPromptPrefixPatch({ inputPromptPrefix: "❯" }, target);
        try {
            assert.deepEqual(target.render(10), ["native:10"]);
        } finally {
            handle.dispose();
        }
    });
}
