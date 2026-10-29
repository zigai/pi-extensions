import assert from "node:assert/strict";
import { PHYSICAL_MODEL_ID } from "@zigai/pi-extension-internals";
import { test } from "vitest";
import { installModelSelectorPinsPatch } from "../src/model-selector-pins.ts";

class Text {
    constructor(public text: string) {}
    setText(text: string): void {
        this.text = text;
    }
}
test("matching pins lead search results in configured order and are marked", () => {
    const target = {
        filteredModels: [
            { provider: "a", id: "one", model: { provider: "a", id: "one" } },
            { provider: "b", id: "two", model: { provider: "b", id: "two" } },
            { provider: "c", id: "three", model: { provider: "c", id: "three" } },
        ],
        selectedIndex: 0,
        listContainer: { children: new Array<Text>() },
        filterModels(_query: string): void {
            this.selectedIndex = 0;
            this.updateList();
        },
        updateList(): void {
            this.listContainer.children = this.filteredModels.map((item) => new Text(item.id));
        },
    };
    const original = target.updateList;
    const handle = installModelSelectorPinsPatch(
        {
            pinnedModels: ["c/three", "a/one", "missing/model"],
            highlightSelectedModelProvider: true,
        },
        () => ({ fg: (color, text) => `<${color}>${text}</${color}>` }),
        target,
    );
    target.filterModels("o");
    assert.deepEqual(
        target.filteredModels.map((model) => model.id),
        ["three", "one", "two"],
    );
    assert.deepEqual(
        target.listContainer.children.map((child) => child.text),
        ["three <warning>*</warning>", "one <warning>*</warning>", "two"],
    );
    assert.equal(target.selectedIndex, 0);
    handle.dispose();
    assert.equal(target.updateList, original);
});

test("pins retain native physical and virtual identities when display names are aliased", () => {
    const target = {
        filteredModels: [
            {
                provider: "Pretty",
                id: "Quick",
                model: { provider: "physical", id: "quick", [PHYSICAL_MODEL_ID]: "native" },
            },
            {
                provider: "Router",
                id: "Automatic",
                model: { provider: "router", id: "alias", [PHYSICAL_MODEL_ID]: "auto" },
            },
        ],
        selectedIndex: 0,
        listContainer: { children: new Array<Text>() },
        filterModels(_query: string): void {
            this.selectedIndex = 0;
            this.updateList();
        },
        updateList(): void {
            this.listContainer.children = this.filteredModels.map((item) => new Text(item.id));
        },
    };
    const handle = installModelSelectorPinsPatch(
        { pinnedModels: ["router/auto", "physical/native"], highlightSelectedModelProvider: false },
        () => ({ fg: (_color, text) => text }),
        target,
    );
    target.filterModels("a");
    assert.deepEqual(
        target.filteredModels.map((item) => item.id),
        ["Automatic", "Quick"],
    );
    assert.deepEqual(
        target.listContainer.children.map((child) => child.text),
        ["Automatic *", "Quick *"],
    );
    handle.dispose();
});

test("pin markers occupy a shared column without moving cursor and current indicators", async () => {
    const {
        Text: PiText,
        stripTerminalSequences,
        visibleWidth,
    } = await import("@earendil-works/pi-tui");
    const target = {
        filteredModels: [
            { provider: "a", id: "short", model: { provider: "a", id: "short" } },
            { provider: "b", id: "long-name", model: { provider: "b", id: "long-name" } },
            { provider: "c", id: "other", model: { provider: "c", id: "other" } },
        ],
        selectedIndex: 0,
        listContainer: { children: new Array<InstanceType<typeof PiText>>() },
        filterModels(): void {
            this.updateList();
        },
        updateList(): void {
            this.listContainer.children = [
                new PiText("→ ✓ short [a]", 0, 0),
                new PiText("    long-name [b]", 0, 0),
                new PiText("    other [c]", 0, 0),
            ];
        },
    };
    const handle = installModelSelectorPinsPatch(
        { pinnedModels: ["a/short", "b/long-name"], highlightSelectedModelProvider: false },
        () => ({ fg: (_color, text) => `\x1b[33m${text}\x1b[39m` }),
        target,
    );
    target.updateList();
    const lines = target.listContainer.children.map((child) =>
        stripTerminalSequences(child.render(40)[0] ?? ""),
    );
    assert.deepEqual(
        target.listContainer.children.map((child) =>
            stripTerminalSequences(child.render(40)[0] ?? ""),
        ),
        lines,
    );
    assert.equal(lines[0]?.slice(0, 6), "→ ✓ * ");
    assert.equal(lines[1]?.slice(0, 6), "    * ");
    assert.equal(lines[2]?.slice(0, 6), "      ");
    assert.ok(
        target.listContainer.children.every((child) =>
            child.render(12).every((line) => visibleWidth(line) <= 12),
        ),
    );
    handle.dispose();
});

test("pin column stays reserved when scrolling away from matching pins", async () => {
    const { Text: PiText, stripTerminalSequences } = await import("@earendil-works/pi-tui");
    const models = Array.from({ length: 16 }, (_, index) => ({
        provider: "a",
        id: `model-${index}`,
        model: { provider: "a", id: `model-${index}` },
    }));
    const target = {
        filteredModels: models,
        selectedIndex: 0,
        listContainer: { children: new Array<InstanceType<typeof PiText>>() },
        filterModels(): void {
            this.updateList();
        },
        updateList(): void {
            const start = Math.max(
                0,
                Math.min(this.selectedIndex - 5, this.filteredModels.length - 10),
            );
            this.listContainer.children = this.filteredModels
                .slice(start, start + 10)
                .map((item) => new PiText(`    ${item.id} [a]`, 0, 0));
        },
    };
    const handle = installModelSelectorPinsPatch(
        { pinnedModels: ["a/model-0"], highlightSelectedModelProvider: false },
        () => ({ fg: (_color, text) => text }),
        target,
    );
    target.updateList();
    assert.equal(
        stripTerminalSequences(target.listContainer.children[1]?.render(40)[0] ?? "").indexOf(
            "model-1",
        ),
        6,
    );
    target.selectedIndex = 12;
    target.updateList();
    assert.equal(
        stripTerminalSequences(target.listContainer.children[0]?.render(40)[0] ?? "").indexOf(
            "model-6",
        ),
        6,
    );
    handle.dispose();
});
