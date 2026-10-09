import {
    ModelRegistry,
    ModelRuntime,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { installRegistryPatch } from "./model-registry-patch.ts";
import { installModelRuntimePatch } from "./model-runtime-patch.ts";
import {
    loadModelFilterSettings,
    type LoadedModelFilterSettings,
    type ModelFilterSettingsLoadState,
} from "./settings.ts";

type ModelFilterExtensionState = ModelFilterSettingsLoadState & { reportedDiagnosticKey?: string };

function setConfigContext(state: ModelFilterExtensionState, ctx: ExtensionContext): void {
    const projectTrusted = ctx.isProjectTrusted();
    if (state.configCwd !== ctx.cwd || state.projectTrusted !== projectTrusted) {
        state.configCache = undefined;
    }
    state.configCwd = ctx.cwd;
    state.projectTrusted = projectTrusted;
}

function reportConfigDiagnostic(
    state: ModelFilterExtensionState,
    ctx: ExtensionContext,
    loaded: LoadedModelFilterSettings,
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

export default function providerModelFilterExtension(pi: ExtensionAPI): void {
    const state: ModelFilterExtensionState = {};
    const getSettings = () => loadModelFilterSettings(state).settings;
    installModelRuntimePatch(ModelRuntime.prototype, getSettings);
    installRegistryPatch(ModelRegistry.prototype, getSettings);

    pi.on("session_start", async (_event, ctx) => {
        setConfigContext(state, ctx);
        installRegistryPatch(ctx.modelRegistry, getSettings);
        reportConfigDiagnostic(state, ctx, loadModelFilterSettings(state));
    });

    pi.on("turn_start", (_event, ctx) => {
        setConfigContext(state, ctx);
        reportConfigDiagnostic(state, ctx, loadModelFilterSettings(state));
    });
}
