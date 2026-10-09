import {
    ModelRegistry,
    ModelRuntime,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { installModelSelectorProviderPatch } from "./model-selector-patch.ts";
import { installModelRuntimeAliasPatch } from "./model-runtime-patch.ts";
import {
    installScopedModelsProviderPatchFromPi,
    type ScopedSelectorInterception,
} from "./scoped-model-selector-patch.ts";
import {
    aliasForProviderRequest,
    isProviderPayloadObject,
    rewritePayloadModel,
} from "./provider-payload.ts";
import { installRegistryPatch, getNativeModels } from "./registry-patch.ts";
import { AliasPolicy } from "./alias-policy.ts";
import {
    loadModelAliasSettings,
    type LoadedModelAliasSettings,
    type ModelAliasSettingsLoadState,
} from "./settings.ts";

type ModelAliasExtensionState = ModelAliasSettingsLoadState & { reportedDiagnosticKey?: string };

function reportConfigError(
    state: ModelAliasExtensionState,
    ctx: ExtensionContext,
    loaded: LoadedModelAliasSettings,
): void {
    if (loaded.diagnostic === undefined) {
        state.reportedDiagnosticKey = undefined;
        return;
    }

    const diagnosticKey = `${loaded.path}:${loaded.mtimeMs}:${loaded.diagnostic}`;
    if (state.reportedDiagnosticKey === diagnosticKey) return;

    state.reportedDiagnosticKey = diagnosticKey;
    ctx.ui.notify(loaded.diagnostic, "error");
}

function setConfigContext(state: ModelAliasExtensionState, ctx: ExtensionContext): void {
    const projectTrusted = ctx.isProjectTrusted();
    if (state.configCwd !== ctx.cwd || state.projectTrusted !== projectTrusted) {
        state.configCache = undefined;
    }
    state.configCwd = ctx.cwd;
    state.projectTrusted = projectTrusted;
}

export default function modelAliasExtension(pi: ExtensionAPI): void {
    const state: ModelAliasExtensionState = {};
    const policy = new AliasPolicy({ loadSettings: () => loadModelAliasSettings(state) });
    installRegistryPatch(ModelRegistry.prototype, policy);

    let runtimePatch = installModelRuntimeAliasPatch(ModelRuntime.prototype, policy);
    let scopedInterception: ScopedSelectorInterception | undefined;

    pi.on("session_start", (_event, ctx) => {
        scopedInterception?.dispose();
        scopedInterception = undefined;
        runtimePatch ??= installModelRuntimeAliasPatch(ModelRuntime.prototype, policy);
        installModelSelectorProviderPatch(policy);
        scopedInterception = installScopedModelsProviderPatchFromPi(policy);
        setConfigContext(state, ctx);

        const registry = ctx.modelRegistry;
        installRegistryPatch(registry, policy);
        reportConfigError(
            state,
            ctx,
            policy.load(() => getNativeModels(registry), true),
        );
    });

    pi.on("session_shutdown", () => {
        scopedInterception?.dispose();
        scopedInterception = undefined;
        runtimePatch?.dispose();
        runtimePatch = undefined;
    });

    pi.on("turn_start", (_event, ctx) => {
        setConfigContext(state, ctx);
        reportConfigError(
            state,
            ctx,
            policy.load(() => getNativeModels(ctx.modelRegistry), true),
        );
    });

    pi.on("before_provider_request", (event, ctx) => {
        setConfigContext(state, ctx);

        const loaded = policy.load(() => getNativeModels(ctx.modelRegistry), true);
        reportConfigError(state, ctx, loaded);

        if (!isProviderPayloadObject(event.payload)) return undefined;

        const alias = aliasForProviderRequest(event.payload, ctx.model, loaded.settings);
        if (alias === undefined) return undefined;
        return rewritePayloadModel(event.payload, alias.model);
    });
}
