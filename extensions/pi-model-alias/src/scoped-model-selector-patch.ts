import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import {
    installLinkedMethodPatch,
    warnPiInternalPatchUnavailable,
} from "@zigai/pi-extension-internals";
import { getAliasForModel, type ModelAliasSettings, type ModelLike } from "./model-aliasing.ts";
import { getProviderAlias } from "./provider-aliasing.ts";
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

const SCOPED_MODELS_PROVIDER_PATCH_KEY = Symbol.for(
    "zigai.pi-model-alias.scoped-models-provider-patched",
);
const SCOPED_MODELS_PROVIDER_STATE_KEY = Symbol.for(
    "zigai.pi-model-alias.scoped-models-provider-state",
);
const SCOPED_MODELS_INTERCEPTOR_KEY = Symbol.for("zigai.pi-model-alias.scoped-models-interceptor");

type ScopedModelsSelectorItem = {
    fullId: string;
    model?: ModelLike;
    enabled: boolean;
};

type ScopedModelsSearchInput = { getValue(): string };
type ScopedModelsFooterText = { setText(text: string): void };
type RuntimeStateHolder = { state: SelectorPolicy };

export type ScopedModelsSelectorPatchTarget = {
    [SCOPED_MODELS_PROVIDER_PATCH_KEY]?: true;
    [SCOPED_MODELS_PROVIDER_STATE_KEY]?: RuntimeStateHolder;
    buildItems?: (this: ScopedModelsSelectorPatchTarget) => ScopedModelsSelectorItem[];
    getFooterText?: (this: ScopedModelsSelectorPatchTarget) => string;
    refresh?: (this: ScopedModelsSelectorPatchTarget) => void;
    updateList: (this: ScopedModelsSelectorPatchTarget) => void;
    filteredItems: ScopedModelsSelectorItem[];
    footerText?: ScopedModelsFooterText;
    listContainer?: ListContainer;
    maxVisible?: number;
    searchInput?: ScopedModelsSearchInput & Partial<SearchInput>;
    selectedIndex?: number;
};

function isObjectIdentity(value: unknown): value is object {
    return typeof value === "object" && value !== null;
}

function isScopedModelsSelectorItem(value: unknown): value is ScopedModelsSelectorItem {
    if (!isObjectIdentity(value)) return false;
    if (!("fullId" in value) || !("enabled" in value) || !("model" in value)) return false;

    const model = value.model;

    return (
        typeof value.fullId === "string" &&
        typeof value.enabled === "boolean" &&
        (model === undefined ||
            (isObjectIdentity(model) &&
                "provider" in model &&
                "id" in model &&
                typeof model.provider === "string" &&
                typeof model.id === "string"))
    );
}

function isScopedModelsSelectorPrototype(value: unknown): value is ScopedModelsSelectorPatchTarget {
    return (
        isObjectIdentity(value) &&
        Object.hasOwn(value, "updateList") &&
        "updateList" in value &&
        typeof value.updateList === "function" &&
        "buildItems" in value &&
        typeof value.buildItems === "function" &&
        "refresh" in value &&
        typeof value.refresh === "function" &&
        "getFooterText" in value &&
        typeof value.getFooterText === "function"
    );
}

// Check both prototype methods and initialized instance fields before touching a live component.
function isScopedModelsSelectorInstance(value: unknown): value is ScopedModelsSelectorPatchTarget {
    if (!isObjectIdentity(value)) return false;

    if (
        !("updateList" in value) ||
        typeof value.updateList !== "function" ||
        !("buildItems" in value) ||
        typeof value.buildItems !== "function" ||
        !("refresh" in value) ||
        typeof value.refresh !== "function" ||
        !("getFooterText" in value) ||
        typeof value.getFooterText !== "function" ||
        !("filteredItems" in value) ||
        !Array.isArray(value.filteredItems) ||
        !value.filteredItems.every(isScopedModelsSelectorItem) ||
        !("selectedIndex" in value) ||
        typeof value.selectedIndex !== "number" ||
        !Number.isInteger(value.selectedIndex) ||
        !("maxVisible" in value) ||
        typeof value.maxVisible !== "number" ||
        !Number.isInteger(value.maxVisible) ||
        !("listContainer" in value) ||
        !isObjectIdentity(value.listContainer) ||
        !("children" in value.listContainer) ||
        !Array.isArray(value.listContainer.children) ||
        !("searchInput" in value) ||
        !isObjectIdentity(value.searchInput) ||
        !("getValue" in value.searchInput) ||
        typeof value.searchInput.getValue !== "function" ||
        !("footerText" in value) ||
        !isObjectIdentity(value.footerText) ||
        !("setText" in value.footerText) ||
        typeof value.footerText.setText !== "function"
    )
        return false;

    return isScopedModelsSelectorPrototype(Object.getPrototypeOf(value));
}

function setPatchState(
    target: ScopedModelsSelectorPatchTarget,
    state: SelectorPolicy,
): RuntimeStateHolder {
    const existingState = target[SCOPED_MODELS_PROVIDER_STATE_KEY];
    if (existingState !== undefined) {
        existingState.state = state;
        return existingState;
    }

    const patchState = { state };
    target[SCOPED_MODELS_PROVIDER_STATE_KEY] = patchState;
    return patchState;
}

function getSettingsForModels(
    state: SelectorPolicy,
    models: readonly ModelLike[],
): ModelAliasSettings {
    return state.forModels(models);
}

function getModelDisplayId(model: ModelLike, settings: ModelAliasSettings): string {
    const alias = getAliasForModel(model, settings);
    if (alias?.name !== undefined && alias.name.length > 0) return alias.name;
    if (model.name !== undefined && model.name.length > 0) return model.name;
    return alias?.alias ?? model.id;
}

function presentModels(items: readonly ScopedModelsSelectorItem[]): ModelLike[] {
    return items.flatMap((item) => {
        if (item.model === undefined) return [];

        return [item.model];
    });
}

function getDisplayItems(
    items: readonly ScopedModelsSelectorItem[],
    state: SelectorPolicy,
): ScopedModelsSelectorItem[] {
    const settings = getSettingsForModels(state, presentModels(items));

    return items.map((item) => {
        if (item.model === undefined) return item;

        const displayedModel = { ...item.model, id: getModelDisplayId(item.model, settings) };
        const alias = getProviderAlias(item.model.provider, settings);
        if (alias !== undefined) displayedModel.provider = alias.name;

        return { ...item, model: displayedModel };
    });
}

function getSearchText(item: ScopedModelsSelectorItem, settings: ModelAliasSettings): string {
    const model = item.model;
    if (model === undefined) return item.fullId;

    const providerAlias = getProviderAlias(model.provider, settings);
    let provider = model.provider;
    if (providerAlias !== undefined) provider = `${providerAlias.name} ${model.provider}`;

    const modelAlias = getAliasForModel(model, settings);
    let ids = model.id;
    if (modelAlias !== undefined) ids = `${modelAlias.alias} ${model.id}`;

    const names = [model.name, modelAlias?.name]
        .filter((name): name is string => name !== undefined && name.length > 0)
        .join(" ");

    return `${ids} ${provider} ${provider}/${ids} ${provider} ${ids} ${names}`;
}

function formatList(target: ScopedModelsSelectorPatchTarget, state: SelectorPolicy): void {
    const container = target.listContainer;
    const selectedIndex = target.selectedIndex;
    if (container === undefined || selectedIndex === undefined) return;

    const settings = getSettingsForModels(state, presentModels(target.filteredItems));
    const toRows = (items: readonly ScopedModelsSelectorItem[]): ProviderRow[] =>
        items.map((item) => {
            if (item.model === undefined)
                return { modelText: item.fullId, providerText: "unavailable" };

            return {
                modelText: getModelDisplayId(item.model, settings),
                providerText:
                    getProviderAlias(item.model.provider, settings)?.name ?? item.model.provider,
            };
        });
    const rows = toRows(visibleRows(target.filteredItems, selectedIndex, target.maxVisible ?? 8));
    let widthRows = rows;
    if (settings.stableProviderColumn) widthRows = toRows(target.filteredItems);
    setSearchCounter(target.searchInput, formatProviderRows(container, rows, widthRows));
}

export function installScopedModelsProviderPatch(
    state: SelectorPolicy,
    prototype: ScopedModelsSelectorPatchTarget,
): void {
    if (typeof prototype.updateList !== "function") {
        warnPiInternalPatchUnavailable(
            "pi-model-alias",
            "scoped models provider alias patch",
            new Error("missing updateList"),
        );

        return;
    }

    const patchState = setPatchState(prototype, state);

    if (prototype[SCOPED_MODELS_PROVIDER_PATCH_KEY] === true) return;

    const originalRefresh = prototype.refresh;
    const originalBuildItems = prototype.buildItems;

    installLinkedMethodPatch(prototype, "updateList", (predecessor) => {
        return function updateListWithProviderAliases(this: ScopedModelsSelectorPatchTarget): void {
            const originalFilteredItems = this.filteredItems;
            this.filteredItems = getDisplayItems(originalFilteredItems, patchState.state);

            try {
                predecessor.call(this);
                formatList(this, patchState.state);
            } finally {
                this.filteredItems = originalFilteredItems;
            }
        };
    });

    if (typeof originalRefresh === "function" && typeof originalBuildItems === "function") {
        prototype.refresh = function refreshWithProviderAliasSearch(): void {
            const query = this.searchInput?.getValue();
            const items = originalBuildItems.call(this);
            const settings = getSettingsForModels(patchState.state, presentModels(items));
            if (
                query === undefined ||
                query.length === 0 ||
                (settings.providerAliases.length === 0 && settings.aliases.length === 0)
            ) {
                originalRefresh.call(this);
                return;
            }

            this.filteredItems = fuzzyFilter(items, query, (item) => getSearchText(item, settings));
            if (this.selectedIndex !== undefined) {
                this.selectedIndex = Math.min(
                    this.selectedIndex,
                    Math.max(0, this.filteredItems.length - 1),
                );
            }

            this.updateList();
            const footerText = this.getFooterText?.();
            if (footerText !== undefined) this.footerText?.setText(footerText);
        };
    }

    prototype[SCOPED_MODELS_PROVIDER_PATCH_KEY] = true;
}

type SelectorFactory<Result extends object> = (done: () => void) => Result;

type ShowSelector = <Result extends object>(
    this: InteractiveSelectorSurface,
    create: SelectorFactory<Result>,
) => void;

type ShowModelsSelector = (this: InteractiveSelectorSurface) => void;

type InteractiveSelectorSurface = {
    showSelector: ShowSelector;
    showModelsSelector: ShowModelsSelector;

    [SCOPED_MODELS_INTERCEPTOR_KEY]?: {
        state: SelectorPolicy;
        enabled: boolean;
        owner: object;
        restore(): void;
    };
};

function isInteractiveSelectorSurface(
    value: InteractiveMode | InteractiveSelectorSurface,
): value is InteractiveSelectorSurface {
    const selector: unknown = Object.getOwnPropertyDescriptor(value, "showSelector")?.value;
    const models: unknown = Object.getOwnPropertyDescriptor(value, "showModelsSelector")?.value;
    return typeof selector === "function" && typeof models === "function";
}

/** Intercept Pi's synchronous selector factory, never importing a second copy of the class. */
export type ScopedSelectorInterception = { dispose(): void };

export function installScopedModelsProviderPatchFromPi(
    state: SelectorPolicy,
    candidate: InteractiveMode | InteractiveSelectorSurface = InteractiveMode.prototype,
): ScopedSelectorInterception | undefined {
    if (!isInteractiveSelectorSurface(candidate)) {
        warnPiInternalPatchUnavailable(
            "pi-model-alias",
            "scoped models selector interception (showSelector/showModelsSelector)",
        );
        return undefined;
    }

    const existing = candidate[SCOPED_MODELS_INTERCEPTOR_KEY];
    if (existing !== undefined) {
        existing.state = state;
        existing.enabled = true;

        const owner = {};
        existing.owner = owner;

        return {
            dispose() {
                if (existing.owner === owner) {
                    existing.enabled = false;
                    existing.restore();
                }
            },
        };
    }

    const predecessorSelector = candidate.showSelector;
    const predecessorModels = candidate.showModelsSelector;

    const owner = {};
    const patchState = { state, enabled: true, owner, restore() {} };
    const openings = new WeakMap<InteractiveSelectorSurface, { captured: boolean }>();

    candidate.showSelector = function showSelectorWithScopedAliases<Result extends object>(
        create: SelectorFactory<Result>,
    ): void {
        const opening = openings.get(this);
        if (!patchState.enabled || opening === undefined) {
            predecessorSelector.call(this, create);
            return;
        }

        predecessorSelector.call(this, (done) => {
            const created = create(done);
            if (!("component" in created) || !isScopedModelsSelectorInstance(created.component)) {
                return created;
            }

            const component = created.component;
            try {
                // Patch only this selector; disposing the interception leaves Pi's class untouched.
                installScopedModelsProviderPatch(patchState.state, component);

                // The constructor already rendered once before its factory returned.
                component.refresh?.();
                opening.captured = true;
            } catch (error) {
                warnPiInternalPatchUnavailable(
                    "pi-model-alias",
                    "scoped models selector interception",
                    error,
                );
            }

            return created;
        });
    };
    candidate.showModelsSelector = function showModelsSelectorWithScopedAliases(): void {
        if (!patchState.enabled) {
            predecessorModels.call(this);
            return;
        }

        const opening = { captured: false };
        openings.set(this, opening);

        try {
            predecessorModels.call(this);
        } finally {
            openings.delete(this);

            if (!opening.captured) {
                warnPiInternalPatchUnavailable(
                    "pi-model-alias",
                    "scoped models selector interception (unexpected selector shape)",
                );
            }
        }
    };

    const patchedSelector = candidate.showSelector;
    const patchedModels = candidate.showModelsSelector;

    patchState.restore = () => {
        if (
            candidate.showSelector !== patchedSelector ||
            candidate.showModelsSelector !== patchedModels
        )
            return;

        candidate.showSelector = predecessorSelector;
        candidate.showModelsSelector = predecessorModels;
        delete candidate[SCOPED_MODELS_INTERCEPTOR_KEY];
    };
    candidate[SCOPED_MODELS_INTERCEPTOR_KEY] = patchState;

    return {
        dispose() {
            if (patchState.owner !== owner) return;

            patchState.enabled = false;
            patchState.restore();
        },
    };
}
