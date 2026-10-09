import type { ModelAliasSettings, ModelLike, ProviderAliasConfig } from "./model-aliasing.ts";

export type ModelSelectorItem = {
    provider: string;
    id: string;
    model: ModelLike;
};

export function getProviderAlias(
    provider: string,
    settings: ModelAliasSettings,
): ProviderAliasConfig | undefined {
    return settings.providerAliases.find((alias) => alias.provider === provider);
}

export function getProviderDisplayName(
    provider: string,
    fallbackName: string,
    settings: ModelAliasSettings,
): string {
    return getProviderAlias(provider, settings)?.name ?? fallbackName;
}

export function applyProviderDisplayName(
    item: ModelSelectorItem,
    settings: ModelAliasSettings,
): ModelSelectorItem {
    const alias = getProviderAlias(item.model.provider, settings);
    if (alias === undefined) return item;

    return { ...item, provider: alias.name };
}

export function applyProviderDisplayNames(
    items: ModelSelectorItem[],
    settings: ModelAliasSettings,
): ModelSelectorItem[] {
    if (settings.providerAliases.length === 0) return items;
    return items.map((item) => applyProviderDisplayName(item, settings));
}
