import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import {
    filterModels,
    isVisibleModel,
    type ModelLike,
    type ModelFilterSettings,
} from "./model-filter.ts";

const REGISTRY_PATCH_MARKER = Symbol.for("@zigai/pi-model-filter/registry-patched");
const REGISTRY_RUNTIME_KEY = Symbol.for("@zigai/pi-model-filter/registry-runtime");
const ORIGINAL_REGISTRY_GET_ALL_KEY = Symbol.for("@zigai/pi-model-filter/registry-get-all");
const ORIGINAL_REGISTRY_GET_AVAILABLE_KEY = Symbol.for(
    "@zigai/pi-model-filter/registry-get-available",
);
const ORIGINAL_REGISTRY_FIND_KEY = Symbol.for("@zigai/pi-model-filter/registry-find");
const ORIGINAL_REGISTRY_GET_MODELS_OF_TYPE_KEY = Symbol.for(
    "@zigai/pi-model-filter/registry-get-models-of-type",
);
const ORIGINAL_REGISTRY_GET_MODEL_OF_TYPE_KEY = Symbol.for(
    "@zigai/pi-model-filter/registry-get-model-of-type",
);
const ORIGINAL_REGISTRY_GET_AVAILABLE_OF_TYPE_KEY = Symbol.for(
    "@zigai/pi-model-filter/registry-get-available-of-type",
);
const ORIGINAL_REGISTRY_FIND_OF_TYPE_KEY = Symbol.for(
    "@zigai/pi-model-filter/registry-find-of-type",
);

type ModelCatalogType = Parameters<ModelRegistry["getModelsOfType"]>[0];
type AvailabilityOptions = Parameters<ModelRegistry["getAvailableOfType"]>[2];

export type BasicModelRegistry = {
    getModelsOfType?: (
        this: BasicModelRegistry,
        type: ModelCatalogType,
        providerId?: string,
    ) => readonly ModelLike[];

    getModelOfType?: (
        this: BasicModelRegistry,
        type: ModelCatalogType,
        providerId: string,
        modelId: string,
    ) => ModelLike | undefined;

    getAvailableOfType?: (
        this: BasicModelRegistry,
        type: ModelCatalogType,
        providerId?: string,
        options?: AvailabilityOptions,
    ) => Promise<readonly ModelLike[]>;

    findOfType?: (
        this: BasicModelRegistry,
        type: ModelCatalogType,
        providerId: string,
        modelId: string,
    ) => ModelLike | undefined;

    getAll: (this: BasicModelRegistry) => ModelLike[];
    getAvailable: (this: BasicModelRegistry) => ModelLike[];
    find: (this: BasicModelRegistry, provider: string, modelId: string) => ModelLike | undefined;
};

export type PatchedModelRegistry = BasicModelRegistry & {
    [ORIGINAL_REGISTRY_GET_MODELS_OF_TYPE_KEY]?: BasicModelRegistry["getModelsOfType"];
    [ORIGINAL_REGISTRY_GET_MODEL_OF_TYPE_KEY]?: BasicModelRegistry["getModelOfType"];
    [ORIGINAL_REGISTRY_GET_AVAILABLE_OF_TYPE_KEY]?: BasicModelRegistry["getAvailableOfType"];
    [ORIGINAL_REGISTRY_FIND_OF_TYPE_KEY]?: BasicModelRegistry["findOfType"];
    [REGISTRY_PATCH_MARKER]?: boolean;
    [REGISTRY_RUNTIME_KEY]?: () => ModelFilterSettings;
    [ORIGINAL_REGISTRY_GET_ALL_KEY]?: BasicModelRegistry["getAll"];
    [ORIGINAL_REGISTRY_GET_AVAILABLE_KEY]?: BasicModelRegistry["getAvailable"];
    [ORIGINAL_REGISTRY_FIND_KEY]?: BasicModelRegistry["find"];
};

function requireSettingsAccessor(
    accessor: (() => ModelFilterSettings) | undefined,
): () => ModelFilterSettings {
    if (accessor !== undefined) return accessor;
    throw new Error("Pi model filter policy is not initialized.");
}

export function installRegistryPatch(
    registry: PatchedModelRegistry,
    getSettings: () => ModelFilterSettings,
): void {
    if (
        typeof registry.getAll !== "function" ||
        typeof registry.getAvailable !== "function" ||
        typeof registry.find !== "function"
    ) {
        throw new Error("Pi model registry does not expose the expected methods.");
    }

    const typedTargets = [
        registry.getModelsOfType,
        registry.getModelOfType,
        registry.getAvailableOfType,
        registry.findOfType,
    ];

    const hasTypedCatalogs = typedTargets.some((target) => target !== undefined);
    if (hasTypedCatalogs && !typedTargets.every((target) => typeof target === "function")) {
        throw new Error("Pi model registry does not expose the expected methods.");
    }

    registry[REGISTRY_RUNTIME_KEY] = getSettings;

    if (registry[REGISTRY_PATCH_MARKER] === true) return;

    registry[ORIGINAL_REGISTRY_GET_ALL_KEY] = registry.getAll;
    registry[ORIGINAL_REGISTRY_GET_AVAILABLE_KEY] = registry.getAvailable;
    registry[ORIGINAL_REGISTRY_FIND_KEY] = registry.find;
    registry[ORIGINAL_REGISTRY_GET_MODELS_OF_TYPE_KEY] = registry.getModelsOfType;
    registry[ORIGINAL_REGISTRY_GET_MODEL_OF_TYPE_KEY] = registry.getModelOfType;
    registry[ORIGINAL_REGISTRY_GET_AVAILABLE_OF_TYPE_KEY] = registry.getAvailableOfType;
    registry[ORIGINAL_REGISTRY_FIND_OF_TYPE_KEY] = registry.findOfType;

    registry.getAll = function getAll(this: PatchedModelRegistry) {
        const models = this[ORIGINAL_REGISTRY_GET_ALL_KEY]?.call(this) ?? [];
        const runtime = requireSettingsAccessor(
            this[REGISTRY_RUNTIME_KEY] ?? registry[REGISTRY_RUNTIME_KEY],
        );
        return filterModels(models, runtime());
    };

    registry.getAvailable = function getAvailable(this: PatchedModelRegistry) {
        const models = this[ORIGINAL_REGISTRY_GET_AVAILABLE_KEY]?.call(this) ?? [];
        const runtime = requireSettingsAccessor(
            this[REGISTRY_RUNTIME_KEY] ?? registry[REGISTRY_RUNTIME_KEY],
        );
        return filterModels(models, runtime());
    };

    registry.find = function find(this: PatchedModelRegistry, provider: string, modelId: string) {
        const finder = this[ORIGINAL_REGISTRY_FIND_KEY] ?? registry[ORIGINAL_REGISTRY_FIND_KEY];
        const model = finder?.call(this, provider, modelId);
        if (model === undefined) return undefined;

        const runtime = requireSettingsAccessor(
            this[REGISTRY_RUNTIME_KEY] ?? registry[REGISTRY_RUNTIME_KEY],
        );
        if (!isVisibleModel(model, runtime())) return undefined;
        return model;
    };

    if (hasTypedCatalogs) {
        registry.getModelsOfType = function getModelsOfType(
            this: PatchedModelRegistry,
            type: ModelCatalogType,
            providerId?: string,
        ) {
            const models =
                this[ORIGINAL_REGISTRY_GET_MODELS_OF_TYPE_KEY]?.call(this, type, providerId) ?? [];
            const runtime = requireSettingsAccessor(
                this[REGISTRY_RUNTIME_KEY] ?? registry[REGISTRY_RUNTIME_KEY],
            );
            return filterModels(models, runtime());
        };

        registry.getModelOfType = function getModelOfType(
            this: PatchedModelRegistry,
            type: ModelCatalogType,
            providerId: string,
            modelId: string,
        ) {
            const finder =
                this[ORIGINAL_REGISTRY_GET_MODEL_OF_TYPE_KEY] ??
                registry[ORIGINAL_REGISTRY_GET_MODEL_OF_TYPE_KEY];
            const model = finder?.call(this, type, providerId, modelId);
            if (model === undefined) return undefined;

            const runtime = requireSettingsAccessor(
                this[REGISTRY_RUNTIME_KEY] ?? registry[REGISTRY_RUNTIME_KEY],
            );
            if (!isVisibleModel(model, runtime())) return undefined;
            return model;
        };

        registry.getAvailableOfType = async function getAvailableOfType(
            this: PatchedModelRegistry,
            type: ModelCatalogType,
            providerId?: string,
            options?: AvailabilityOptions,
        ) {
            const models =
                (await this[ORIGINAL_REGISTRY_GET_AVAILABLE_OF_TYPE_KEY]?.call(
                    this,
                    type,
                    providerId,
                    options,
                )) ?? [];
            const runtime = requireSettingsAccessor(
                this[REGISTRY_RUNTIME_KEY] ?? registry[REGISTRY_RUNTIME_KEY],
            );
            return filterModels(models, runtime());
        };

        registry.findOfType = function findOfType(
            this: PatchedModelRegistry,
            type: ModelCatalogType,
            providerId: string,
            modelId: string,
        ) {
            const finder =
                this[ORIGINAL_REGISTRY_FIND_OF_TYPE_KEY] ??
                registry[ORIGINAL_REGISTRY_FIND_OF_TYPE_KEY];
            const model = finder?.call(this, type, providerId, modelId);
            if (model === undefined) return undefined;

            const runtime = requireSettingsAccessor(
                this[REGISTRY_RUNTIME_KEY] ?? registry[REGISTRY_RUNTIME_KEY],
            );
            if (!isVisibleModel(model, runtime())) return undefined;
            return model;
        };
    }

    registry[REGISTRY_PATCH_MARKER] = true;
}
