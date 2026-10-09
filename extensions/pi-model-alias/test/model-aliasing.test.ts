import { AliasPolicy } from "../src/alias-policy.ts";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PHYSICAL_MODEL_ID } from "@zigai/pi-extension-internals";
import { test } from "vitest";

import {
    aliasModels,
    applyAlias,
    getAliasForLookup,
    getAliasForModel,
    getAliasModelIdCollision,
    type AliasConfig,
    type ModelLike,
    type ProviderAliasConfig,
} from "../src/model-aliasing.ts";
import { getProviderDisplayName } from "../src/provider-aliasing.ts";
import { installModelSelectorProviderPatch } from "../src/model-selector-patch.ts";
import {
    installScopedModelsProviderPatch,
    type ScopedModelsSelectorPatchTarget,
} from "../src/scoped-model-selector-patch.ts";
import {
    aliasForProviderRequest,
    isProviderPayloadObject,
    rewritePayloadModel,
} from "../src/provider-payload.ts";
import type { ProviderRowComponent } from "../src/provider-row.ts";
import {
    installRegistryPatch,
    getNativeModels,
    type PatchedModelRegistry,
} from "../src/registry-patch.ts";
import type { LoadedModelAliasSettings } from "../src/settings.ts";

function loadedConfig(
    aliases: AliasConfig[],
    diagnostic?: string,
    providerAliases: ProviderAliasConfig[] = [],
    stableProviderColumn = true,
): LoadedModelAliasSettings {
    if (diagnostic === undefined) {
        return {
            path: "model-aliases.json",
            mtimeMs: 1,
            settings: { aliases, providerAliases, stableProviderColumn },
        };
    }

    return {
        path: "model-aliases.json",
        mtimeMs: 1,
        settings: { aliases: [], providerAliases: [], stableProviderColumn: true },
        diagnostic,
    };
}

const nativeModels: ModelLike[] = [
    { provider: "openai", id: "gpt-5", name: "GPT-5" },
    { provider: "anthropic", id: "claude-opus", name: "Claude Opus" },
];

const aliases: AliasConfig[] = [
    { provider: "openai", model: "gpt-5", alias: "fast", name: "Fast" },
    { provider: "anthropic", model: "claude-opus", alias: "smart" },
];

type TestTextComponent = {
    text: string;
    setText(text: string): void;
};

type RenderableTestTextComponent = TestTextComponent & {
    render(width: number): string[];
};
type TextFixture = Pick<TestTextComponent, "text">;

type ModelSelectorMockItem = {
    provider: string;
    id: string;
    model: ModelLike;
};

function isTextFixture(value: ProviderRowComponent): value is TextFixture {
    return "text" in value && typeof value.text === "string";
}

function isRenderableTextFixture(
    value: ProviderRowComponent,
): value is RenderableTestTextComponent {
    return (
        isTextFixture(value) &&
        "setText" in value &&
        typeof value.setText === "function" &&
        "render" in value &&
        typeof value.render === "function"
    );
}

function textComponent(text: string): TestTextComponent {
    return {
        text,
        setText(nextText: string) {
            this.text = nextText;
        },
    };
}

function renderableTextComponent(text: string): RenderableTestTextComponent {
    return {
        ...textComponent(text),
        render() {
            return [this.text];
        },
    };
}

function textValues(children: ProviderRowComponent[]): string[] {
    return children.flatMap((child) => {
        if (isTextFixture(child)) return [child.text];

        return [];
    });
}

test("aliases models without mutating unrelated models", () => {
    const loaded = loadedConfig(aliases);
    const aliased = aliasModels(nativeModels, loaded.settings);
    assert.equal(aliased[0]?.[PHYSICAL_MODEL_ID], "gpt-5");
    assert.equal(aliased[1]?.[PHYSICAL_MODEL_ID], "claude-opus");
    assert.deepEqual(aliased, [
        { provider: "openai", id: "fast", name: "Fast" },
        { provider: "anthropic", id: "smart", name: "Claude Opus" },
    ]);
    assert.equal(nativeModels.at(0)?.id, "gpt-5");
});

test("does not apply aliases when config has a load error", () => {
    const loaded = loadedConfig(aliases, "invalid config");
    assert.deepEqual(aliasModels(nativeModels, loaded.settings), nativeModels);
});

test("resolves provider display aliases without changing provider ids", () => {
    const loaded = loadedConfig([], undefined, [{ provider: "openai", name: "OpenAI Work" }]);
    assert.equal(getProviderDisplayName("openai", "OpenAI", loaded.settings), "OpenAI Work");
    assert.equal(getProviderDisplayName("anthropic", "Anthropic", loaded.settings), "Anthropic");
});

test("detects alias collisions with native model ids per provider", () => {
    const collision = getAliasModelIdCollision(
        loadedConfig([{ provider: "openai", model: "gpt-5", alias: "gpt-5" }]).settings,
        nativeModels,
    );

    assert.match(collision ?? "", /conflicts with an existing model id/);

    const crossProviderCollision = getAliasModelIdCollision(
        loadedConfig([{ provider: "anthropic", model: "claude-opus", alias: "gpt-5" }]).settings,
        nativeModels,
    );
    assert.equal(crossProviderCollision, undefined);
});

test("finds aliases by model and by provider lookup", () => {
    const loaded = loadedConfig(aliases);
    assert.deepEqual(getAliasForModel(nativeModels[0], loaded.settings), aliases[0]);
    assert.deepEqual(getAliasForLookup("anthropic", "smart", loaded.settings), aliases[1]);
    assert.equal(getAliasForLookup("openai", "missing", loaded.settings), undefined);
});

test("rewrites provider request payloads only for object payloads", () => {
    assert.deepEqual(rewritePayloadModel({ model: "fast", messages: [] }, "gpt-5"), {
        model: "gpt-5",
        messages: [],
    });
    assert.equal(isProviderPayloadObject(["not", "object"]), false);
    assert.equal(isProviderPayloadObject(null), false);
    assert.equal(isProviderPayloadObject({ model: "fast" }), true);
});

test("resolves provider request aliases from selected model or request payload", () => {
    const loaded = loadedConfig(aliases);
    const selectedAliasModel = applyAlias(nativeModels[0], aliases[0]);

    assert.deepEqual(
        aliasForProviderRequest({ model: "fast" }, selectedAliasModel, loaded.settings),
        aliases[0],
    );
    assert.deepEqual(
        aliasForProviderRequest({ model: "smart" }, nativeModels.at(1), loaded.settings),
        aliases[1],
    );
    assert.equal(
        aliasForProviderRequest({ model: "claude-opus" }, nativeModels.at(1), loaded.settings),
        undefined,
    );
    assert.equal(aliasForProviderRequest({ model: "fast" }, undefined, loaded.settings), undefined);
});

test("virtual selection aliases never replace the dispatched physical payload model", () => {
    const loaded = loadedConfig([
        { provider: "router", model: "auto", alias: "short", name: "Short Router" },
    ]);
    const selected = { provider: "router", id: "short", api: "pi-virtual" };

    assert.equal(
        aliasForProviderRequest({ model: "native-chat" }, selected, loaded.settings),
        undefined,
    );
});

test("model selector patch aliases snapshot display and search while preserving native models", () => {
    const state: AliasPolicy = new AliasPolicy({
        loadSettings: () =>
            loadedConfig([aliases[0]], undefined, [{ provider: "openai", name: "OpenAI Work" }]),
    });
    const openaiModel = nativeModels.at(0);
    const anthropicModel = nativeModels.at(1);
    if (openaiModel === undefined || anthropicModel === undefined) {
        throw new Error("missing model fixture");
    }

    const modelItems: ModelSelectorMockItem[] = [
        {
            provider: "openai",
            id: "gpt-5",
            model: openaiModel,
        },
        {
            provider: "anthropic",
            id: "claude-opus",
            model: anthropicModel,
        },
    ];

    const successCheckmark = "\x1b[32m ✓\x1b[39m";
    const prototype = {
        allModels: Array<ModelSelectorMockItem>(),
        scopedModelItems: Array<ModelSelectorMockItem>(),
        activeModels: Array<ModelSelectorMockItem>(),
        filteredModels: Array<ModelSelectorMockItem>(),
        listContainer: { children: Array<ProviderRowComponent>() },
        searchInput: {
            render(width: number) {
                return [`> ${" ".repeat(Math.max(0, width - 2))}`];
            },
        },
        selectedIndex: 0,
        scope: "all",
        loadModelsFromSnapshot(): void {
            this.allModels = modelItems;
            this.scopedModelItems = [];
            this.activeModels = modelItems;
            this.filteredModels = modelItems;
        },
        filterModels(query: string): void {
            const normalizedQuery = query.toLowerCase();
            this.filteredModels = this.activeModels.filter((item) => {
                const searchable = `${item.provider} ${item.id} ${item.model.name ?? ""}`;
                return searchable.toLowerCase().includes(normalizedQuery);
            });
            this.updateList();
        },
        updateList(): void {
            this.listContainer.children = this.filteredModels.map((item, index) => {
                let prefix = "  ";
                let checkmark = "";
                if (index === this.selectedIndex) {
                    prefix = "→ ";
                    checkmark = successCheckmark;
                }

                return textComponent(`${prefix}${item.id} [${item.provider}]${checkmark}`);
            });
            this.listContainer.children.push(
                textComponent("  (1/2)"),
                {},
                textComponent("  Model Name: GPT-5"),
                {},
                textComponent("  Model catalogs refreshed."),
            );
        },
    };

    installModelSelectorProviderPatch(state, prototype);
    prototype.loadModelsFromSnapshot();
    prototype.updateList();
    assert.equal(prototype.allModels[0]?.provider, "OpenAI Work");
    assert.equal(prototype.allModels[0]?.model, openaiModel);
    assert.equal(prototype.allModels[0]?.id, "fast");
    assert.equal(prototype.activeModels[0]?.provider, "OpenAI Work");
    assert.deepEqual(textValues(prototype.listContainer.children), [
        `→ Fast${successCheckmark}       OpenAI Work`,
        "  Claude Opus  anthropic",
        "  Model catalogs refreshed.",
    ]);
    assert.equal(prototype.listContainer.children.length, 3);
    assert.equal(prototype.searchInput.render(20)[0], ">              (1/2)");
    prototype.filterModels("gpt-5");
    assert.equal(prototype.filteredModels.length, 1);
    assert.equal(prototype.filteredModels[0], prototype.allModels[0]);
    assert.equal(prototype.filteredModels[0]?.model, openaiModel);
    prototype.filterModels("OpenAI Work");
    assert.equal(prototype.filteredModels.length, 1);
    assert.equal(prototype.filteredModels[0], prototype.allModels[0]);
    prototype.filterModels("Fast");
    assert.equal(prototype.filteredModels.length, 1);
    assert.equal(prototype.filteredModels[0], prototype.allModels[0]);
});

test("model selector patch reapplies aliases after a refreshed snapshot", () => {
    let snapshot: ModelLike[] = [nativeModels.at(0)].filter(
        (model): model is ModelLike => model !== undefined,
    );
    const state: AliasPolicy = new AliasPolicy({
        loadSettings: () => loadedConfig(aliases),
    });
    const prototype = {
        allModels: Array<ModelSelectorMockItem>(),
        scopedModelItems: Array<ModelSelectorMockItem>(),
        activeModels: Array<ModelSelectorMockItem>(),
        filteredModels: Array<ModelSelectorMockItem>(),
        selectedIndex: 0,
        scope: "all",
        loadModelsFromSnapshot(): void {
            this.allModels = snapshot.map((model) => ({
                provider: model.provider,
                id: model.id,
                model,
            }));
            this.activeModels = this.allModels;
            this.filteredModels = this.allModels;
        },
        filterModels(): void {},
        updateList(): void {},
    };

    installModelSelectorProviderPatch(state, prototype);
    prototype.loadModelsFromSnapshot();
    assert.deepEqual(
        prototype.allModels.map((item) => item.id),
        ["fast"],
    );

    snapshot = [...nativeModels];
    prototype.loadModelsFromSnapshot();
    assert.deepEqual(
        prototype.allModels.map((item) => item.id),
        ["fast", "smart"],
    );
    assert.deepEqual(
        prototype.allModels.map((item) => item.model.id),
        ["gpt-5", "claude-opus"],
    );
});

test("model selector provider patch can align providers to all filtered model names", () => {
    const shortModel: ModelLike = { provider: "p", id: "short", name: "Short" };
    const longModel: ModelLike = {
        provider: "p",
        id: "long",
        name: "Extremely Long Model Name",
    };

    const modelItems = [
        { provider: "p", id: "short", model: shortModel },
        ...Array.from({ length: 9 }, (_unused, index) => {
            return {
                provider: "p",
                id: `medium-${index}`,
                model: { provider: "p", id: `medium-${index}`, name: `Medium ${index}` },
            };
        }),
        { provider: "p", id: "long", model: longModel },
    ];

    function createPrototype() {
        return {
            allModels: modelItems,
            scopedModelItems: [],
            activeModels: modelItems,
            filteredModels: modelItems,
            listContainer: { children: Array<ProviderRowComponent>() },
            selectedIndex: 0,
            scope: "all",
            loadModelsFromSnapshot(): void {},
            filterModels(_query: string): void {
                return;
            },
            updateList(): void {
                const visibleItems = this.filteredModels.slice(0, 10);
                this.listContainer.children = visibleItems.map((item, index) => {
                    let prefix = "  ";
                    if (index === this.selectedIndex) {
                        prefix = "→ ";
                    }

                    return textComponent(`${prefix}${item.id} [${item.provider}]`);
                });
            },
        };
    }

    const stableState: AliasPolicy = new AliasPolicy({
        loadSettings: () => loadedConfig([], undefined, [], true),
    });
    const stablePrototype = createPrototype();
    installModelSelectorProviderPatch(stableState, stablePrototype);
    stablePrototype.updateList();

    const visibleState: AliasPolicy = new AliasPolicy({
        loadSettings: () => loadedConfig([], undefined, [], false),
    });
    const visiblePrototype = createPrototype();
    installModelSelectorProviderPatch(visibleState, visiblePrototype);
    visiblePrototype.updateList();

    assert.equal(
        textValues(stablePrototype.listContainer.children)[0],
        `→ Short${" ".repeat(22)}p`,
    );
    assert.equal(
        textValues(visiblePrototype.listContainer.children)[0],
        `→ Short${" ".repeat(5)}p`,
    );
});

test("model selector provider rows stay single-line at narrow widths", () => {
    const modelItems = [
        {
            provider: "openai-codex",
            id: "short",
            model: { provider: "openai-codex", id: "short", name: "Short" },
        },
        {
            provider: "fireworks",
            id: "long",
            model: {
                provider: "fireworks",
                id: "long",
                name: "An Extremely Long Model Name Used For Stable Alignment",
            },
        },
    ];

    const prototype = {
        allModels: modelItems,
        scopedModelItems: [],
        activeModels: modelItems,
        filteredModels: modelItems,
        listContainer: { children: Array<ProviderRowComponent>() },
        selectedIndex: 0,
        scope: "all",
        loadModelsFromSnapshot(): void {},
        filterModels(): void {},
        updateList(): void {
            this.listContainer.children = this.filteredModels.map((item, index) => {
                let prefix = "  ";
                if (index === this.selectedIndex) prefix = "→ ";

                return renderableTextComponent(`${prefix}${item.id} [${item.provider}]`);
            });
        },
    };
    const state: AliasPolicy = new AliasPolicy({
        loadSettings: () => loadedConfig([], undefined, [], true),
    });

    installModelSelectorProviderPatch(state, prototype);
    prototype.updateList();

    const first = prototype.listContainer.children.at(0);
    const second = prototype.listContainer.children.at(1);
    if (
        first === undefined ||
        second === undefined ||
        !isRenderableTextFixture(first) ||
        !isRenderableTextFixture(second)
    ) {
        throw new Error("missing renderable model row fixture");
    }

    for (const component of [first, second]) {
        const lines = component.render(40);
        assert.equal(lines.length, 1);
        assert.ok(visibleWidth(lines[0] ?? "") <= 40);
    }

    assert.match(first.render(40)[0] ?? "", /openai-codex$/);
    const narrowLongModel = second.render(40)[0] ?? "";
    assert.match(narrowLongModel, /…/);
    assert.match(narrowLongModel, /fireworks$/);
});

test("scoped models patch aliases rendered and searched models without changing selection ids", () => {
    let currentLoaded = loadedConfig([aliases[0]], undefined, [
        { provider: "openai", name: "OpenAI Work" },
    ]);
    const state: AliasPolicy = new AliasPolicy({
        loadSettings: () => currentLoaded,
    });

    type ScopedMockItem = {
        fullId: string;
        model: ModelLike;
        enabled: boolean;
    };

    let query = "";
    const footerTexts: string[] = [];
    const openaiModel = nativeModels.at(0);
    if (openaiModel === undefined) {
        throw new Error("missing openai model fixture");
    }

    const originalItems: ScopedMockItem[] = [
        {
            fullId: "openai/gpt-5",
            model: openaiModel,
            enabled: true,
        },
    ];

    const successCheckmark = "\x1b[32m ✓\x1b[39m";
    const prototype = {
        filteredItems: originalItems,
        footerText: {
            setText(text: string) {
                footerTexts.push(text);
            },
        },
        listContainer: { children: [] },
        maxVisible: 8,
        searchInput: {
            getValue() {
                return query;
            },
            render(width: number) {
                return [`> ${" ".repeat(Math.max(0, width - 2))}`];
            },
        },
        selectedIndex: 0,
        buildItems(this: ScopedModelsSelectorPatchTarget) {
            return originalItems;
        },
        getFooterText(this: ScopedModelsSelectorPatchTarget) {
            return "footer";
        },
        refresh(this: ScopedModelsSelectorPatchTarget) {
            this.filteredItems = [];
        },
        updateList(this: ScopedModelsSelectorPatchTarget) {
            const container = this.listContainer;
            if (container === undefined) throw new Error("missing list container fixture");

            container.children = this.filteredItems.map((item, index) => {
                let prefix = "  ";
                if (index === this.selectedIndex) {
                    prefix = "→ ";
                }

                return textComponent(
                    `${prefix}${item.model?.id ?? item.fullId} [${item.model?.provider ?? "unavailable"}]${successCheckmark}`,
                );
            });
            container.children.push(
                textComponent("  (1/1)"),
                {},
                textComponent("  Model Name: GPT-5"),
            );
        },
    };

    installScopedModelsProviderPatch(state, prototype);
    prototype.updateList();
    assert.deepEqual(textValues(prototype.listContainer.children), [
        `→ Fast${successCheckmark}  OpenAI Work`,
    ]);

    currentLoaded = loadedConfig([aliases[0]]);
    query = "fast";
    prototype.refresh();

    assert.deepEqual(textValues(prototype.listContainer.children), [
        `→ Fast${successCheckmark}  openai`,
    ]);
    assert.equal(prototype.searchInput.render(20)[0], ">              (1/1)");
    assert.deepEqual(footerTexts, ["footer"]);
    assert.equal(prototype.filteredItems[0], originalItems[0]);
    assert.equal(prototype.filteredItems[0]?.model.id, "gpt-5");
    assert.equal(prototype.filteredItems[0]?.model.provider, "openai");
});

test("registry patch aliases list and lookup methods and updates config at runtime", () => {
    let loaded = loadedConfig([aliases[0]]);
    const state: AliasPolicy = new AliasPolicy({
        loadSettings: () => loaded,
    });
    const registry: PatchedModelRegistry = {
        getAll() {
            return nativeModels;
        },
        getAvailable() {
            return [nativeModels[0]];
        },
        find(provider: string, modelId: string) {
            return nativeModels.find(
                (model) => model.provider === provider && model.id === modelId,
            );
        },
        getProviderDisplayName(provider: string) {
            return provider.toUpperCase();
        },
    };

    installRegistryPatch(registry, state);

    assert.deepEqual(
        registry.getAll().map((model) => model.id),
        ["fast", "claude-opus"],
    );
    assert.deepEqual(
        registry.getAvailable().map((model) => model.id),
        ["fast"],
    );
    assert.equal(registry.getAll()[0]?.name, "Fast");
    assert.deepEqual(registry.find("openai", "fast"), {
        provider: "openai",
        id: "fast",
        name: "Fast",
    });
    assert.deepEqual(registry.find("openai", "gpt-5"), registry.find("openai", "fast"));
    assert.equal(registry.getProviderDisplayName("openai"), "OPENAI");
    loaded = loadedConfig([], undefined, [{ provider: "openai", name: "OpenAI Work" }]);
    installRegistryPatch(registry, state);

    assert.deepEqual(
        registry.getAll().map((model) => model.id),
        ["gpt-5", "claude-opus"],
    );
    assert.deepEqual(registry.find("openai", "gpt-5"), nativeModels.at(0));
    assert.equal(registry.getProviderDisplayName("openai"), "OpenAI Work");
});

test("registry reuses collision validation until an explicit model refresh", () => {
    const loaded = loadedConfig([
        { provider: "openai", model: "gpt-5", alias: "fast", name: "Fast" },
    ]);
    const state: AliasPolicy = new AliasPolicy({ loadSettings: () => loaded });
    let getAllCalls = 0;
    const registry: PatchedModelRegistry = {
        getAll() {
            getAllCalls++;
            return nativeModels;
        },
        getAvailable: () => nativeModels,
        find: (provider, modelId) =>
            nativeModels.find((model) => model.provider === provider && model.id === modelId),
        getProviderDisplayName: (provider) => provider,
    };
    installRegistryPatch(registry, state);

    registry.getAvailable();
    registry.getAvailable();
    assert.equal(getAllCalls, 1);
    state.load(() => getNativeModels(registry), true);
    assert.equal(getAllCalls, 2);
});

test("registry collision disables model and provider aliases and reports a diagnostic", () => {
    const loaded = loadedConfig(
        [{ provider: "openai", model: "gpt-5", alias: "gpt-5" }],
        undefined,
        [{ provider: "openai", name: "OpenAI Work" }],
    );
    const state: AliasPolicy = new AliasPolicy({ loadSettings: () => loaded });
    const registry: PatchedModelRegistry = {
        getAll: () => nativeModels,
        getAvailable: () => nativeModels,
        find: (provider, modelId) =>
            nativeModels.find((model) => model.provider === provider && model.id === modelId),
        getProviderDisplayName: (provider) => provider,
    };
    installRegistryPatch(registry, state);

    const resolved = state.load(() => getNativeModels(registry));
    assert.deepEqual(resolved.settings.aliases, []);
    assert.deepEqual(resolved.settings.providerAliases, []);
    assert.match(resolved.diagnostic ?? "", /conflicts with an existing model id/);
});
