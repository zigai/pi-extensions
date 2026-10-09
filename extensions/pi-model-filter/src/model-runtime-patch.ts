import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
    filterModels,
    isVisibleModel,
    type ModelLike,
    type ModelFilterSettings,
} from "./model-filter.ts";

const MODEL_RUNTIME_PATCH_MARKER = Symbol.for("@zigai/pi-model-filter/model-runtime-patched");
const MODEL_RUNTIME_STATE_KEY = Symbol.for("@zigai/pi-model-filter/model-runtime-state");
const ORIGINAL_RUNTIME_GET_MODELS_KEY = Symbol.for(
    "@zigai/pi-model-filter/model-runtime-get-models",
);
const ORIGINAL_RUNTIME_GET_AVAILABLE_KEY = Symbol.for(
    "@zigai/pi-model-filter/model-runtime-get-available",
);
const ORIGINAL_RUNTIME_GET_AVAILABLE_SNAPSHOT_KEY = Symbol.for(
    "@zigai/pi-model-filter/model-runtime-get-available-snapshot",
);
const ORIGINAL_RUNTIME_GET_MODEL_KEY = Symbol.for("@zigai/pi-model-filter/model-runtime-get-model");
const ORIGINAL_RUNTIME_GET_MODELS_OF_TYPE_KEY = Symbol.for(
    "@zigai/pi-model-filter/model-runtime-get-models-of-type",
);
const ORIGINAL_RUNTIME_GET_MODEL_OF_TYPE_KEY = Symbol.for(
    "@zigai/pi-model-filter/model-runtime-get-model-of-type",
);
const ORIGINAL_RUNTIME_GET_ALL_MODELS_KEY = Symbol.for(
    "@zigai/pi-model-filter/model-runtime-get-all-models",
);
const ORIGINAL_RUNTIME_GET_AVAILABLE_OF_TYPE_KEY = Symbol.for(
    "@zigai/pi-model-filter/model-runtime-get-available-of-type",
);
const ORIGINAL_RUNTIME_GET_ALL_AVAILABLE_KEY = Symbol.for(
    "@zigai/pi-model-filter/model-runtime-get-all-available",
);

type ModelCatalogType = Parameters<ModelRuntime["getModelsOfType"]>[0];
type AvailabilityOptions = Parameters<ModelRuntime["getAvailableOfType"]>[2];

export type BasicModelRuntime = {
    getModelsOfType?: (
        this: BasicModelRuntime,
        type: ModelCatalogType,
        providerId?: string,
    ) => readonly ModelLike[];

    getModelOfType?: (
        this: BasicModelRuntime,
        type: ModelCatalogType,
        providerId: string,
        modelId: string,
    ) => ModelLike | undefined;

    getAllModels?: (this: BasicModelRuntime, providerId?: string) => readonly ModelLike[];

    getAvailableOfType?: (
        this: BasicModelRuntime,
        type: ModelCatalogType,
        providerId?: string,
        options?: AvailabilityOptions,
    ) => Promise<readonly ModelLike[]>;

    getAllAvailable?: (
        this: BasicModelRuntime,
        providerId?: string,
        options?: AvailabilityOptions,
    ) => Promise<readonly ModelLike[]>;

    getModels: (this: BasicModelRuntime, providerId?: string) => readonly ModelLike[];

    getAvailable: (
        this: BasicModelRuntime,
        providerId?: string,
        options?: AvailabilityOptions,
    ) => Promise<readonly ModelLike[]>;

    getAvailableSnapshot: (this: BasicModelRuntime) => readonly ModelLike[];

    getModel: (
        this: BasicModelRuntime,
        providerId: string,
        modelId: string,
    ) => ModelLike | undefined;
};

export type PatchedModelRuntime = BasicModelRuntime & {
    [ORIGINAL_RUNTIME_GET_MODELS_OF_TYPE_KEY]?: BasicModelRuntime["getModelsOfType"];
    [ORIGINAL_RUNTIME_GET_MODEL_OF_TYPE_KEY]?: BasicModelRuntime["getModelOfType"];
    [ORIGINAL_RUNTIME_GET_ALL_MODELS_KEY]?: BasicModelRuntime["getAllModels"];
    [ORIGINAL_RUNTIME_GET_AVAILABLE_OF_TYPE_KEY]?: BasicModelRuntime["getAvailableOfType"];
    [ORIGINAL_RUNTIME_GET_ALL_AVAILABLE_KEY]?: BasicModelRuntime["getAllAvailable"];
    [MODEL_RUNTIME_PATCH_MARKER]?: boolean;
    [MODEL_RUNTIME_STATE_KEY]?: () => ModelFilterSettings;
    [ORIGINAL_RUNTIME_GET_MODELS_KEY]?: BasicModelRuntime["getModels"];
    [ORIGINAL_RUNTIME_GET_AVAILABLE_KEY]?: BasicModelRuntime["getAvailable"];
    [ORIGINAL_RUNTIME_GET_AVAILABLE_SNAPSHOT_KEY]?: BasicModelRuntime["getAvailableSnapshot"];
    [ORIGINAL_RUNTIME_GET_MODEL_KEY]?: BasicModelRuntime["getModel"];
};

function requireSettingsAccessor(
    accessor: (() => ModelFilterSettings) | undefined,
): () => ModelFilterSettings {
    if (accessor !== undefined) return accessor;
    throw new Error("Pi model filter policy is not initialized.");
}

export function installModelRuntimePatch(
    runtime: PatchedModelRuntime,
    getSettings: () => ModelFilterSettings,
): void {
    if (
        typeof runtime.getModels !== "function" ||
        typeof runtime.getAvailable !== "function" ||
        typeof runtime.getAvailableSnapshot !== "function" ||
        typeof runtime.getModel !== "function"
    ) {
        throw new Error("Pi model runtime does not expose the expected methods.");
    }

    const typedTargets = [
        runtime.getModelsOfType,
        runtime.getModelOfType,
        runtime.getAllModels,
        runtime.getAvailableOfType,
        runtime.getAllAvailable,
    ];

    const hasTypedCatalogs = typedTargets.some((target) => target !== undefined);
    if (hasTypedCatalogs && !typedTargets.every((target) => typeof target === "function")) {
        throw new Error("Pi model runtime does not expose the expected methods.");
    }

    runtime[MODEL_RUNTIME_STATE_KEY] = getSettings;

    if (runtime[MODEL_RUNTIME_PATCH_MARKER] === true) return;

    runtime[ORIGINAL_RUNTIME_GET_MODELS_KEY] = runtime.getModels;
    runtime[ORIGINAL_RUNTIME_GET_AVAILABLE_KEY] = runtime.getAvailable;
    runtime[ORIGINAL_RUNTIME_GET_AVAILABLE_SNAPSHOT_KEY] = runtime.getAvailableSnapshot;
    runtime[ORIGINAL_RUNTIME_GET_MODEL_KEY] = runtime.getModel;
    runtime[ORIGINAL_RUNTIME_GET_MODELS_OF_TYPE_KEY] = runtime.getModelsOfType;
    runtime[ORIGINAL_RUNTIME_GET_MODEL_OF_TYPE_KEY] = runtime.getModelOfType;
    runtime[ORIGINAL_RUNTIME_GET_ALL_MODELS_KEY] = runtime.getAllModels;
    runtime[ORIGINAL_RUNTIME_GET_AVAILABLE_OF_TYPE_KEY] = runtime.getAvailableOfType;
    runtime[ORIGINAL_RUNTIME_GET_ALL_AVAILABLE_KEY] = runtime.getAllAvailable;

    runtime.getModels = function getModels(this: PatchedModelRuntime, providerId?: string) {
        const models = this[ORIGINAL_RUNTIME_GET_MODELS_KEY]?.call(this, providerId) ?? [];
        const filterState = requireSettingsAccessor(
            this[MODEL_RUNTIME_STATE_KEY] ?? runtime[MODEL_RUNTIME_STATE_KEY],
        );
        return filterModels(models, filterState());
    };

    runtime.getAvailable = async function getAvailable(
        this: PatchedModelRuntime,
        providerId?: string,
        options?: AvailabilityOptions,
    ) {
        const models =
            (await this[ORIGINAL_RUNTIME_GET_AVAILABLE_KEY]?.call(this, providerId, options)) ?? [];
        const filterState = requireSettingsAccessor(
            this[MODEL_RUNTIME_STATE_KEY] ?? runtime[MODEL_RUNTIME_STATE_KEY],
        );
        return filterModels(models, filterState());
    };

    runtime.getAvailableSnapshot = function getAvailableSnapshot(this: PatchedModelRuntime) {
        const models = this[ORIGINAL_RUNTIME_GET_AVAILABLE_SNAPSHOT_KEY]?.call(this) ?? [];
        const filterState = requireSettingsAccessor(
            this[MODEL_RUNTIME_STATE_KEY] ?? runtime[MODEL_RUNTIME_STATE_KEY],
        );
        return filterModels(models, filterState());
    };

    runtime.getModel = function getModel(
        this: PatchedModelRuntime,
        providerId: string,
        modelId: string,
    ) {
        const finder =
            this[ORIGINAL_RUNTIME_GET_MODEL_KEY] ?? runtime[ORIGINAL_RUNTIME_GET_MODEL_KEY];
        const model = finder?.call(this, providerId, modelId);
        if (model === undefined) return undefined;

        const filterState = requireSettingsAccessor(
            this[MODEL_RUNTIME_STATE_KEY] ?? runtime[MODEL_RUNTIME_STATE_KEY],
        );
        if (!isVisibleModel(model, filterState())) return undefined;
        return model;
    };

    if (hasTypedCatalogs) {
        runtime.getModelsOfType = function getModelsOfType(
            this: PatchedModelRuntime,
            type: ModelCatalogType,
            providerId?: string,
        ) {
            const models =
                this[ORIGINAL_RUNTIME_GET_MODELS_OF_TYPE_KEY]?.call(this, type, providerId) ?? [];
            const filterState = requireSettingsAccessor(
                this[MODEL_RUNTIME_STATE_KEY] ?? runtime[MODEL_RUNTIME_STATE_KEY],
            );
            return filterModels(models, filterState());
        };

        runtime.getModelOfType = function getModelOfType(
            this: PatchedModelRuntime,
            type: ModelCatalogType,
            providerId: string,
            modelId: string,
        ) {
            const finder =
                this[ORIGINAL_RUNTIME_GET_MODEL_OF_TYPE_KEY] ??
                runtime[ORIGINAL_RUNTIME_GET_MODEL_OF_TYPE_KEY];
            const model = finder?.call(this, type, providerId, modelId);
            if (model === undefined) return undefined;

            const filterState = requireSettingsAccessor(
                this[MODEL_RUNTIME_STATE_KEY] ?? runtime[MODEL_RUNTIME_STATE_KEY],
            );
            if (!isVisibleModel(model, filterState())) return undefined;
            return model;
        };

        runtime.getAllModels = function getAllModels(
            this: PatchedModelRuntime,
            providerId?: string,
        ) {
            const models = this[ORIGINAL_RUNTIME_GET_ALL_MODELS_KEY]?.call(this, providerId) ?? [];
            const filterState = requireSettingsAccessor(
                this[MODEL_RUNTIME_STATE_KEY] ?? runtime[MODEL_RUNTIME_STATE_KEY],
            );
            return filterModels(models, filterState());
        };

        runtime.getAvailableOfType = async function getAvailableOfType(
            this: PatchedModelRuntime,
            type: ModelCatalogType,
            providerId?: string,
            options?: AvailabilityOptions,
        ) {
            const models =
                (await this[ORIGINAL_RUNTIME_GET_AVAILABLE_OF_TYPE_KEY]?.call(
                    this,
                    type,
                    providerId,
                    options,
                )) ?? [];
            const filterState = requireSettingsAccessor(
                this[MODEL_RUNTIME_STATE_KEY] ?? runtime[MODEL_RUNTIME_STATE_KEY],
            );
            return filterModels(models, filterState());
        };

        runtime.getAllAvailable = async function getAllAvailable(
            this: PatchedModelRuntime,
            providerId?: string,
            options?: AvailabilityOptions,
        ) {
            const models =
                (await this[ORIGINAL_RUNTIME_GET_ALL_AVAILABLE_KEY]?.call(
                    this,
                    providerId,
                    options,
                )) ?? [];
            const filterState = requireSettingsAccessor(
                this[MODEL_RUNTIME_STATE_KEY] ?? runtime[MODEL_RUNTIME_STATE_KEY],
            );
            return filterModels(models, filterState());
        };
    }

    runtime[MODEL_RUNTIME_PATCH_MARKER] = true;
}
