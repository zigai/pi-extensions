import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import {
    installLinkedMethodPatch,
    warnPiInternalPatchUnavailable,
} from "@zigai/pi-extension-internals";
import { getAliasForModel, type ModelAliasSettings, type ModelLike } from "./model-aliasing.ts";
import { applyProviderDisplayNames, getProviderAlias } from "./provider-aliasing.ts";
import {
    formatProviderRows,
    setSearchCounter,
    visibleRows,
    type ListContainer,
    type ProviderRow,
    type SearchInput,
} from "./provider-row.ts";
import type { AliasPolicy } from "./alias-policy.ts";

type SelectorPolicy = Pick<AliasPolicy, "forModels">;

const MODEL_SELECTOR_PROVIDER_PATCH_KEY = Symbol.for(
    "zigai.pi-model-alias.model-selector-provider-patched",
);
const MODEL_SELECTOR_PROVIDER_STATE_KEY = Symbol.for(
    "zigai.pi-model-alias.model-selector-provider-state",
);

type ModelSelectorItem = {
    provider: string;
    id: string;
    model: ModelLike;
};

type RuntimeStateHolder = { state: SelectorPolicy };

type ModelSelectorPatchSurface = {
    [MODEL_SELECTOR_PROVIDER_PATCH_KEY]?: true;
    [MODEL_SELECTOR_PROVIDER_STATE_KEY]?: RuntimeStateHolder;
    loadModelsFromSnapshot: (this: ModelSelectorPatchSurface) => void;
    filterModels: (this: ModelSelectorPatchSurface, query: string) => void;
    updateList: (this: ModelSelectorPatchSurface) => void;
};

export type ModelSelectorPatchTarget = ModelSelectorPatchSurface & {
    allModels: ModelSelectorItem[];
    scopedModelItems: ModelSelectorItem[];
    activeModels: ModelSelectorItem[];
    filteredModels: ModelSelectorItem[];
    listContainer?: ListContainer;
    searchInput?: SearchInput;
    selectedIndex: number;
    scope: string;
};

function isModelSelectorPatchSurface(value: unknown): value is ModelSelectorPatchSurface {
    return (
        ((typeof value === "object" && value !== null) || typeof value === "function") &&
        "loadModelsFromSnapshot" in value &&
        typeof value.loadModelsFromSnapshot === "function" &&
        "filterModels" in value &&
        typeof value.filterModels === "function" &&
        "updateList" in value &&
        typeof value.updateList === "function"
    );
}

function isModelLike(value: unknown): value is ModelLike {
    return (
        typeof value === "object" &&
        value !== null &&
        "provider" in value &&
        typeof value.provider === "string" &&
        "id" in value &&
        typeof value.id === "string"
    );
}

function isModelSelectorItem(value: unknown): value is ModelSelectorItem {
    return (
        typeof value === "object" &&
        value !== null &&
        "provider" in value &&
        typeof value.provider === "string" &&
        "id" in value &&
        typeof value.id === "string" &&
        "model" in value &&
        isModelLike(value.model)
    );
}

function isModelSelectorItems(value: unknown): value is ModelSelectorItem[] {
    return Array.isArray(value) && value.every(isModelSelectorItem);
}

function isModelSelectorInstance(
    value: ModelSelectorPatchSurface,
): value is ModelSelectorPatchTarget {
    return (
        "allModels" in value &&
        isModelSelectorItems(value.allModels) &&
        "scopedModelItems" in value &&
        isModelSelectorItems(value.scopedModelItems) &&
        "activeModels" in value &&
        isModelSelectorItems(value.activeModels) &&
        "filteredModels" in value &&
        isModelSelectorItems(value.filteredModels) &&
        "selectedIndex" in value &&
        typeof value.selectedIndex === "number" &&
        "scope" in value &&
        typeof value.scope === "string"
    );
}

function setPatchState(
    target: ModelSelectorPatchSurface,
    state: SelectorPolicy,
): RuntimeStateHolder {
    const existingState = target[MODEL_SELECTOR_PROVIDER_STATE_KEY];
    if (existingState !== undefined) {
        existingState.state = state;
        return existingState;
    }

    const patchState = { state };
    target[MODEL_SELECTOR_PROVIDER_STATE_KEY] = patchState;
    return patchState;
}

function getSettings(target: ModelSelectorPatchTarget, state: SelectorPolicy): ModelAliasSettings {
    return state.forModels(target.allModels.map((item) => item.model));
}

function applyModelSelectorAliases(
    items: readonly ModelSelectorItem[],
    settings: ModelAliasSettings,
): ModelSelectorItem[] {
    const modelAliased = items.map((item) => {
        const alias = getAliasForModel(item.model, settings);
        if (alias === undefined) return item;

        return { ...item, id: alias.alias };
    });

    return applyProviderDisplayNames(modelAliased, settings);
}

function setModelSelectorAliases(target: ModelSelectorPatchTarget, state: SelectorPolicy): void {
    const settings = getSettings(target, state);
    target.allModels = applyModelSelectorAliases(target.allModels, settings);
    target.scopedModelItems = applyModelSelectorAliases(target.scopedModelItems, settings);
    if (target.scope === "scoped") {
        target.activeModels = target.scopedModelItems;
    } else {
        target.activeModels = target.allModels;
    }
    target.filteredModels = target.activeModels;
}

function getModelDisplayId(model: ModelLike, settings: ModelAliasSettings): string {
    const alias = getAliasForModel(model, settings);
    if (alias?.name !== undefined && alias.name.length > 0) return alias.name;
    if (model.name !== undefined && model.name.length > 0) return model.name;
    return alias?.alias ?? model.id;
}

type ModelSelectorSearch = {
    readonly items: ModelSelectorItem[];
    readonly originals: ReadonlyMap<ModelSelectorItem, ModelSelectorItem>;
};

function getSearchItems(
    target: ModelSelectorPatchTarget,
    state: SelectorPolicy,
): ModelSelectorSearch {
    const items = target.activeModels;
    const settings = getSettings(target, state);
    if (settings.providerAliases.length === 0 && settings.aliases.length === 0) {
        return { items, originals: new Map() };
    }

    const originals = new Map<ModelSelectorItem, ModelSelectorItem>();
    const searchItems = items.map((item) => {
        const providerAlias = getProviderAlias(item.model.provider, settings);
        const modelAlias = getAliasForModel(item.model, settings);
        if (providerAlias === undefined && modelAlias === undefined) return item;

        let provider = item.provider;
        if (providerAlias !== undefined) {
            provider = `${providerAlias.name} ${item.model.provider}`;
        }

        const modelSearchTerms = [item.model.name, modelAlias?.name, item.model.id]
            .filter((term): term is string => term !== undefined && term.length > 0)
            .join(" ");
        const searchItem = { ...item, provider, model: { ...item.model, name: modelSearchTerms } };
        originals.set(searchItem, item);

        return searchItem;
    });

    return { items: searchItems, originals };
}

function formatModelSelectorList(target: ModelSelectorPatchTarget, state: SelectorPolicy): void {
    const container = target.listContainer;
    if (container === undefined) return;

    const settings = getSettings(target, state);
    const toRows = (items: readonly ModelSelectorItem[]): ProviderRow[] =>
        items.map((item) => ({
            modelText: getModelDisplayId(item.model, settings),
            providerText: item.provider,
        }));
    const rows = toRows(visibleRows(target.filteredModels, target.selectedIndex, 10));
    let widthRows = rows;
    if (settings.stableProviderColumn) widthRows = toRows(target.filteredModels);
    setSearchCounter(target.searchInput, formatProviderRows(container, rows, widthRows));
}

export function installModelSelectorProviderPatch(
    state: SelectorPolicy,
    prototype?: ModelSelectorPatchTarget | null,
): void {
    let target: ModelSelectorPatchSurface | null | undefined = prototype;
    if (target === undefined && isModelSelectorPatchSurface(ModelSelectorComponent.prototype)) {
        target = ModelSelectorComponent.prototype;
    }

    if (!isModelSelectorPatchSurface(target)) {
        warnPiInternalPatchUnavailable("pi-model-alias", "model picker provider alias patch");
        return;
    }

    const patchState = setPatchState(target, state);

    if (target[MODEL_SELECTOR_PROVIDER_PATCH_KEY] === true) return;

    const originalLoadModelsFromSnapshot = target.loadModelsFromSnapshot;
    const originalFilterModels = target.filterModels;

    target.loadModelsFromSnapshot = function loadModelsFromSnapshotWithAliases(): void {
        originalLoadModelsFromSnapshot.call(this);

        if (isModelSelectorInstance(this)) setModelSelectorAliases(this, patchState.state);
    };

    target.filterModels = function filterModelsWithProviderAliases(query: string): void {
        if (!isModelSelectorInstance(this)) {
            originalFilterModels.call(this, query);
            return;
        }

        const originalActiveModels = this.activeModels;
        const search = getSearchItems(this, patchState.state);
        this.activeModels = search.items;

        try {
            originalFilterModels.call(this, query);
        } finally {
            this.activeModels = originalActiveModels;
        }

        this.filteredModels = this.filteredModels.map((item) => search.originals.get(item) ?? item);
        this.updateList();
    };

    installLinkedMethodPatch(target, "updateList", (predecessor) => {
        return function updateListWithModelNames(this: ModelSelectorPatchSurface): void {
            if (!isModelSelectorInstance(this)) {
                predecessor.call(this);
                return;
            }

            const originalFilteredModels = this.filteredModels;
            const settings = getSettings(this, patchState.state);

            this.filteredModels = originalFilteredModels.map((item) => ({
                ...item,
                id: getModelDisplayId(item.model, settings),
            }));

            try {
                predecessor.call(this);
                formatModelSelectorList(this, patchState.state);
            } finally {
                this.filteredModels = originalFilteredModels;
            }
        };
    });

    target[MODEL_SELECTOR_PROVIDER_PATCH_KEY] = true;
}
