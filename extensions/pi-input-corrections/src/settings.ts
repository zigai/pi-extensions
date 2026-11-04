import { getPiGlobalSettingsPath, loadPiExtensionSettings } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import { dirname } from "node:path";
import { loadCorrectionPolicy, type LoadedCorrectionPolicy } from "./policy-loader.ts";
import settingsInput from "./settings-input.ts";
import artifact from "./settings.prevalidated.ts";

const definition = definePrevalidatedExtensionSettings(settingsInput, artifact);

export type LoadedInputCorrectionsSettings = LoadedCorrectionPolicy;

export function loadInputCorrectionsSettings(): LoadedInputCorrectionsSettings {
    const configFile = getPiGlobalSettingsPath(definition.id);

    // Never forward project trust or cwd: this adapter accepts personal settings only.
    const loaded = loadPiExtensionSettings(
        definition,
        {
            cwd: dirname(configFile),
            isProjectTrusted: () => false,
        },
        {
            bundledSchema: { kind: "url", url: new URL("../config.schema.json", import.meta.url) },
        },
    );

    let policyFile = "";
    if (loaded.settings.enabled && loaded.diagnostics.length === 0)
        policyFile = loaded.settings.policyFile;

    const policy = loadCorrectionPolicy(policyFile, configFile);

    return {
        engine: policy.engine,
        diagnostics: [
            ...loaded.diagnostics,
            ...policy.diagnostics.map((diagnostic) => ({
                ...diagnostic,
                message: `[pi-input-corrections] ${diagnostic.message}`,
            })),
        ],
    };
}
