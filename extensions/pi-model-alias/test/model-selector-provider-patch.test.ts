import { AliasPolicy } from "../src/alias-policy.ts";
import assert from "node:assert/strict";
import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

import { installModelSelectorProviderPatch } from "../src/model-selector-patch.ts";
import {
    installScopedModelsProviderPatch,
    installScopedModelsProviderPatchFromPi,
} from "../src/scoped-model-selector-patch.ts";

import type { LoadedModelAliasSettings } from "../src/settings.ts";

type ModelSelectorPrototype = NonNullable<Parameters<typeof installModelSelectorProviderPatch>[1]>;
type ScopedModelsPrototype = Parameters<typeof installScopedModelsProviderPatch>[1];

type ModelSelectorItem = ModelSelectorPrototype["allModels"][number];
type ScopedModelsItem = ScopedModelsPrototype["filteredItems"][number];

function loadedConfig(providerName: string): LoadedModelAliasSettings {
    return {
        path: "/tmp/pi-model-alias/config.json",
        mtimeMs: 1,
        settings: {
            aliases: [],
            providerAliases: [{ provider: "openai", name: providerName }],
            stableProviderColumn: true,
        },
    };
}

function runtimeState(providerName: string): AliasPolicy {
    return new AliasPolicy({
        loadSettings() {
            return loadedConfig(providerName);
        },
    });
}

function modelItem(): ModelSelectorItem {
    return {
        provider: "openai",
        id: "gpt-5",
        model: { provider: "openai", id: "gpt-5" },
    };
}

function scopedItem(): ScopedModelsItem {
    return {
        fullId: "openai/gpt-5",
        model: { provider: "openai", id: "gpt-5" },
        enabled: true,
    };
}

test("explicit null does not patch Pi's default model selector", () => {
    const original = Object.getOwnPropertyDescriptor(
        ModelSelectorComponent.prototype,
        "updateList",
    );
    installModelSelectorProviderPatch(runtimeState("Provider"), null);

    assert.deepEqual(
        Object.getOwnPropertyDescriptor(ModelSelectorComponent.prototype, "updateList"),
        original,
    );
});

test("model selector provider patch uses the latest runtime state after reinstall", () => {
    const prototype: ModelSelectorPrototype = {
        loadModelsFromSnapshot() {},
        filterModels() {},
        updateList() {},
        allModels: [],
        scopedModelItems: [],
        activeModels: [],
        filteredModels: [],
        selectedIndex: 0,
        scope: "all",
    };
    installModelSelectorProviderPatch(runtimeState("Old Provider"), prototype);
    installModelSelectorProviderPatch(runtimeState("New Provider"), prototype);

    const target: ModelSelectorPrototype = { ...prototype };
    target.allModels = [modelItem()];
    target.scopedModelItems = [];
    target.activeModels = [];
    target.filteredModels = [];
    target.selectedIndex = 0;
    target.scope = "all";
    target.loadModelsFromSnapshot();
    assert.equal(target.allModels[0]?.provider, "New Provider");
    assert.equal(target.filteredModels[0]?.provider, "New Provider");
});

test("scoped models provider patch uses the latest runtime state after reinstall", () => {
    let renderedProviders: string[] = [];
    const prototype: ScopedModelsPrototype = {
        updateList() {
            renderedProviders = this.filteredItems.map(
                (item) => item.model?.provider ?? "unavailable",
            );
        },
        filteredItems: [],
    };
    installScopedModelsProviderPatch(runtimeState("Old Provider"), prototype);
    installScopedModelsProviderPatch(runtimeState("New Provider"), prototype);

    const target: ScopedModelsPrototype = { ...prototype };
    target.filteredItems = [scopedItem()];
    target.selectedIndex = 0;
    target.updateList();
    assert.deepEqual(renderedProviders, ["New Provider"]);
    assert.equal(target.filteredItems[0]?.model?.provider, "openai");
});

test("unavailable scoped IDs retain their native identity alongside provider aliases", () => {
    const rendered: string[][] = [];
    const missing: ScopedModelsItem = { fullId: "missing/model", enabled: true };
    const prototype: ScopedModelsPrototype = {
        filteredItems: [],
        updateList() {
            rendered.push(this.filteredItems.map((item) => item.model?.provider ?? item.fullId));
        },
    };
    installScopedModelsProviderPatch(runtimeState("Alias"), prototype);
    const instance: ScopedModelsPrototype = {
        ...prototype,
        filteredItems: [missing, scopedItem()],
    };
    instance.updateList();
    assert.deepEqual(rendered, [["missing/model", "Alias"]]);
    assert.equal(instance.filteredItems[0], missing);
    assert.equal(instance.filteredItems[1]?.model?.provider, "openai");
});

test("live scoped selector interception refreshes before mounting and preserves model identities", () => {
    const events: string[] = [];

    class ScopedSelector {
        filteredItems = [scopedItem()];
        selectedIndex = 0;
        maxVisible = 8;

        listContainer = {
            children: [
                {
                    text: "gpt-5 [Latest]",
                    setText(text: string) {
                        this.text = text;
                    },
                },
            ],
        };

        constructor() {
            this.updateList();
        }

        searchInput = { getValue: () => "" };
        footerText = { setText(_text: string) {} };
        onChange = (id: string) => events.push(`changed:${id}`);

        buildItems() {
            return [scopedItem()];
        }

        getFooterText() {
            return "footer";
        }

        updateList() {
            events.push(`render:${this.filteredItems[0]?.model?.provider}`);
        }

        refresh() {
            this.filteredItems = this.buildItems();
            this.updateList();
        }
    }

    let mounted: ScopedSelector | undefined;
    const prototype = {
        showSelector: <Result extends object>(create: (done: () => void) => Result): Result => {
            const result = create(() => {
                events.push("done");
            });
            if ("component" in result && result.component instanceof ScopedSelector) {
                mounted = result.component;
                events.push(`mount:${mounted.filteredItems[0]?.fullId}`);
                mounted.onChange(mounted.filteredItems[0]?.fullId ?? "");
            }

            return result;
        },
        showModelsSelector: (): void => {
            prototype.showSelector(() => {
                const component = new ScopedSelector();
                return { component, focus: component };
            });
        },
    };
    const originalShowSelector = prototype.showSelector;
    const oldHandle = installScopedModelsProviderPatchFromPi(runtimeState("First"), prototype);
    const patchedShowSelector = prototype.showSelector;
    const activeHandle = installScopedModelsProviderPatchFromPi(runtimeState("Latest"), prototype);
    oldHandle?.dispose();
    assert.equal(prototype.showSelector, patchedShowSelector);
    assert.notEqual(prototype.showSelector, originalShowSelector);
    const instance = prototype;
    instance.showModelsSelector();
    assert.ok(mounted);
    assert.equal(mounted.filteredItems[0]?.model?.provider, "openai");
    assert.equal(
        Object.hasOwn(
            ScopedSelector.prototype,
            Symbol.for("zigai.pi-model-alias.scoped-models-provider-patched"),
        ),
        false,
    );
    assert.deepEqual(events, [
        "render:openai",
        "render:Latest",
        "mount:openai/gpt-5",
        "changed:openai/gpt-5",
    ]);
    events.length = 0;
    instance.showModelsSelector();
    assert.deepEqual(events, [
        "render:openai",
        "render:Latest",
        "mount:openai/gpt-5",
        "changed:openai/gpt-5",
    ]);

    activeHandle?.dispose();
    activeHandle?.dispose();
    assert.equal(prototype.showSelector, originalShowSelector);
    events.length = 0;
    instance.showModelsSelector();
    assert.deepEqual(events, ["render:openai", "mount:openai/gpt-5", "changed:openai/gpt-5"]);
});

test("unexpected scoped selector shape falls back without altering the mounted component", () => {
    const component = { filteredItems: [scopedItem()] };
    let mounted: typeof component | undefined;
    const prototype = {
        showSelector<Result extends object>(create: (done: () => void) => Result): Result {
            const result = create(() => {});
            if ("component" in result && result.component === component) mounted = component;
            return result;
        },
        showModelsSelector(): void {
            prototype.showSelector(() => ({ component }));
        },
    };
    installScopedModelsProviderPatchFromPi(runtimeState("Alias"), prototype);
    prototype.showModelsSelector();
    assert.equal(mounted, component);
    assert.equal(component.filteredItems[0]?.model?.provider, "openai");
});

test("model selector patch matches the Pi 0.80.9 runtime prototype", () => {
    installModelSelectorProviderPatch(runtimeState("Provider"));

    assert.equal(
        Object.hasOwn(
            ModelSelectorComponent.prototype,
            Symbol.for("zigai.pi-model-alias.model-selector-provider-patched"),
        ),
        true,
    );
});
