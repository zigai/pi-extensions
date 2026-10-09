import {
    getAliasForLookup,
    type AliasConfig,
    type ModelAliasSettings,
    type ModelLike,
} from "./model-aliasing.ts";

export type ProviderPayloadObject = {
    readonly model?: unknown;
    readonly messages?: unknown;
};

export function isProviderPayloadObject(value: unknown): value is ProviderPayloadObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderModel(value: unknown): value is string {
    return typeof value === "string";
}

function payloadModel(payload: ProviderPayloadObject): string | undefined {
    const model: unknown = Object.getOwnPropertyDescriptor(payload, "model")?.value;
    if (isProviderModel(model)) return model;
    return undefined;
}

export function rewritePayloadModel(
    payload: ProviderPayloadObject,
    targetModel: string,
): ProviderPayloadObject {
    return { ...payload, model: targetModel };
}

export function aliasForProviderRequest(
    payload: ProviderPayloadObject,
    model: ModelLike | undefined,
    settings: ModelAliasSettings,
): AliasConfig | undefined {
    if (model === undefined) return undefined;
    if ("api" in model && model.api === "pi-virtual") return undefined;

    const modelAlias = getAliasForLookup(model.provider, model.id, settings);
    if (modelAlias !== undefined) return modelAlias;

    const requestModel = payloadModel(payload);
    if (requestModel === undefined || requestModel === model.id) return undefined;
    return getAliasForLookup(model.provider, requestModel, settings);
}
