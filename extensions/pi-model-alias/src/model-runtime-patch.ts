import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
    installKeyedLinkedMethodPatch,
    warnPiInternalPatchUnavailable,
} from "@zigai/pi-extension-internals";

import { getAliasForLookup } from "./model-aliasing.ts";
import type { AliasPolicy } from "./alias-policy.ts";

type RuntimePolicy = Pick<AliasPolicy, "load">;
type AliasRuntime = Pick<ModelRuntime, "getModels" | "resolveModel" | "getPhysicalModel">;

export function installModelRuntimeAliasPatch(runtime: AliasRuntime, policy: RuntimePolicy) {
    if (
        typeof runtime.getModels !== "function" ||
        typeof runtime.resolveModel !== "function" ||
        typeof runtime.getPhysicalModel !== "function"
    ) {
        warnPiInternalPatchUnavailable("pi-model-alias", "native virtual routing identity");
        return undefined;
    }

    const selection = installKeyedLinkedMethodPatch(
        runtime,
        "resolveModel",
        Symbol.for("zigai.pi-model-alias.resolve-model"),
        policy,
        (predecessor, getPolicy) => {
            return async function resolveAliasedModel(model, messages, options) {
                const settings = getPolicy().load(() => this.getModels()).settings;
                const alias = getAliasForLookup(model.provider, model.id, settings);
                let nativeModel = model;
                if (alias !== undefined) nativeModel = { ...model, id: alias.model };

                return predecessor.call(this, nativeModel, messages, options);
            };
        },
    );
    const dispatch = installKeyedLinkedMethodPatch(
        runtime,
        "getPhysicalModel",
        Symbol.for("zigai.pi-model-alias.get-physical-model"),
        policy,
        (predecessor, getPolicy) => {
            return function getAliasedPhysicalModel(provider, modelId) {
                const settings = getPolicy().load(() => this.getModels()).settings;
                const alias = getAliasForLookup(provider, modelId, settings);
                return predecessor.call(this, provider, alias?.model ?? modelId);
            };
        },
    );

    return {
        update(nextPolicy: RuntimePolicy): void {
            selection.update(nextPolicy);
            dispatch.update(nextPolicy);
        },
        dispose(): void {
            dispatch.dispose();
            selection.dispose();
        },
    };
}
