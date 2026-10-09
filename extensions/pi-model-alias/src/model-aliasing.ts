import { PHYSICAL_MODEL_ID } from "@zigai/pi-extension-internals";

export type ModelLike = {
    provider: string;
    id: string;
    name?: string;
    [PHYSICAL_MODEL_ID]?: string;
};

export type AliasConfig = {
    provider: string;
    model: string;
    alias: string;
    name?: string;
};

export type ProviderAliasConfig = {
    provider: string;
    name: string;
};

export type ModelAliasSettings = {
    aliases: AliasConfig[];
    providerAliases: ProviderAliasConfig[];
    stableProviderColumn: boolean;
};

function buildModelIdSetByProvider(models: readonly ModelLike[]): Map<string, Set<string>> {
    const modelIds = new Map<string, Set<string>>();
    for (const model of models) {
        let providerModels = modelIds.get(model.provider);
        if (providerModels === undefined) {
            providerModels = new Set<string>();
            modelIds.set(model.provider, providerModels);
        }

        providerModels.add(model.id);
    }

    return modelIds;
}

export function getAliasModelIdCollision(
    settings: ModelAliasSettings,
    nativeModels: readonly ModelLike[],
): string | undefined {
    const modelIdsByProvider = buildModelIdSetByProvider(nativeModels);
    for (const alias of settings.aliases) {
        if (modelIdsByProvider.get(alias.provider)?.has(alias.alias) === true) {
            return `alias "${alias.alias}" for provider "${alias.provider}" conflicts with an existing model id; choose an alias that is not already registered by that provider.`;
        }
    }

    return undefined;
}

export function getAliasForModel(
    model: ModelLike,
    settings: ModelAliasSettings,
): AliasConfig | undefined {
    return settings.aliases.find(
        (alias) => alias.provider === model.provider && alias.model === model.id,
    );
}

export function getAliasForLookup(
    provider: string,
    modelId: string,
    settings: ModelAliasSettings,
): AliasConfig | undefined {
    return settings.aliases.find((alias) => alias.provider === provider && alias.alias === modelId);
}

export function applyAlias(model: ModelLike, alias: AliasConfig): ModelLike {
    const aliased: ModelLike = {
        ...model,
        id: alias.alias,
    };
    if (alias.name !== undefined) {
        aliased.name = alias.name;
    }

    Object.defineProperty(aliased, PHYSICAL_MODEL_ID, {
        value: model[PHYSICAL_MODEL_ID] ?? model.id,
    });

    return aliased;
}

export function aliasModels(models: ModelLike[], settings: ModelAliasSettings): ModelLike[] {
    if (settings.aliases.length === 0) return models;

    return models.map((model) => {
        const alias = getAliasForModel(model, settings);
        if (alias === undefined) return model;
        return applyAlias(model, alias);
    });
}
