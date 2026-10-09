import assert from "node:assert/strict";
import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

import { installModelSelectorProviderBadgePatch } from "../src/model-selector-provider-badge.ts";

class MutableText {
    constructor(public text: string) {}

    setText(text: string): void {
        this.text = text;
    }
}

function selector() {
    return {
        filteredModels: [
            { id: "gpt-5", provider: "openai" },
            { id: "claude-sonnet-4", provider: "anthropic" },
        ],
        listContainer: { children: new Array<MutableText>() },
        selectedIndex: 1,
        updateList(): void {
            this.listContainer.children = [
                new MutableText("  gpt-5 <muted>[openai]</muted>"),
                new MutableText(
                    "<accent>→ </accent><accent>claude-sonnet-4</accent> <muted>[anthropic]</muted>",
                ),
            ];
        },
    };
}

const theme = { fg: (color: string, text: string): string => `<${color}>${text}</${color}>` };

test("explicit null does not patch Pi's default model selector", async () => {
    const original = Object.getOwnPropertyDescriptor(
        ModelSelectorComponent.prototype,
        "updateList",
    );
    const handle = await installModelSelectorProviderBadgePatch(
        { highlightSelectedModelProvider: true },
        null,
        theme,
    );

    assert.deepEqual(
        Object.getOwnPropertyDescriptor(ModelSelectorComponent.prototype, "updateList"),
        original,
    );

    handle.dispose();
});

test("selected model provider badge defers active theme access until rendering", async () => {
    const target = selector();
    const original = target.updateList;
    const handle = await installModelSelectorProviderBadgePatch(
        { highlightSelectedModelProvider: true },
        target,
        () => {
            throw new Error("theme not ready");
        },
    );
    assert.notEqual(target.updateList, original);
    handle.dispose();
    assert.equal(target.updateList, original);
});

test("selected model provider badge uses the active theme after a theme change", async () => {
    const target = selector();
    let activeTheme = theme;
    const handle = await installModelSelectorProviderBadgePatch(
        { highlightSelectedModelProvider: true },
        target,
        () => activeTheme,
    );
    target.updateList();
    assert.equal(
        target.listContainer.children[1]?.text.includes("<accent>[anthropic]</accent>"),
        true,
    );

    activeTheme = { fg: (_color, text) => text };
    target.updateList();
    assert.equal(
        target.listContainer.children[1]?.text.includes("<muted>[anthropic]</muted>"),
        true,
    );

    handle.dispose();
});

test("selected model provider badge follows live configuration", async () => {
    const target = selector();
    const handle = await installModelSelectorProviderBadgePatch(
        { highlightSelectedModelProvider: true },
        target,
        theme,
    );
    target.updateList();
    assert.equal(
        target.listContainer.children[1]?.text.includes("<accent>[anthropic]</accent>"),
        true,
    );

    handle.update({ highlightSelectedModelProvider: false });
    target.updateList();
    assert.equal(
        target.listContainer.children[1]?.text.includes("<muted>[anthropic]</muted>"),
        true,
    );

    handle.dispose();
});
