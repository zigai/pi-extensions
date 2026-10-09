import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";

import prevalidatedSettings from "./settings.prevalidated.ts";
import settingsInput, { type ExtensionSettingsDocument, settingsSchema } from "./settings-input.ts";

/** A resolved picker-model selection, parsed from the model setting. */
export type PickerModelReference =
    | { readonly type: "current" }
    | { readonly type: "specific"; readonly provider: string; readonly id: string };

export type ExtensionSettings = Omit<ExtensionSettingsDocument, "model"> & {
    readonly model: PickerModelReference;
};

type AutonameSessionSettingsLoadResult = {
    readonly settings: ExtensionSettings | undefined;

    readonly diagnostics: readonly {
        readonly severity: "error" | "warning";
        readonly message: string;
    }[];
};

/**
 * Parse the picker model setting into a tagged reference.
 *
 * "current" selects the session's active model; any other value must be
 * provider/model-id form. Returns undefined for malformed references so the
 * caller can report the configured value as unavailable.
 */
export function parsePickerModelReference(model: string): PickerModelReference | undefined {
    if (model.trim() !== model) {
        return undefined;
    }

    if (model === "current") {
        return { type: "current" };
    }

    const separatorIndex = model.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex === model.length - 1 || /\s/.test(model)) {
        return undefined;
    }

    return {
        type: "specific",
        provider: model.slice(0, separatorIndex),
        id: model.slice(separatorIndex + 1),
    };
}

/** Render a parsed picker-model reference in its persisted setting form. */
export function formatPickerModelReference(reference: PickerModelReference): string {
    return reference.type === "current" ? "current" : `${reference.provider}/${reference.id}`;
}

export const extensionSettingsDefinition = definePrevalidatedExtensionSettings(
    settingsInput,
    prevalidatedSettings,
);

/**
 * Load resolved extension settings from Pi's global and trusted-project
 * settings layers, refreshing missing or stale generated schemas.
 */
export function loadAutonameSessionSettings(
    ctx: PiSettingsContext,
): AutonameSessionSettingsLoadResult {
    const loaded = loadPiExtensionSettings(extensionSettingsDefinition, ctx, {
        bundledSchema: {
            kind: "url",
            url: new URL("../config.schema.json", import.meta.url),
        },
    });

    const configFailed = loaded.diagnostics.some(
        ({ scope, code }) => scope !== "schema" && code !== "config-scaffold-failed",
    );
    if (configFailed) {
        return { settings: undefined, diagnostics: loaded.diagnostics };
    }

    if (loaded.settings.nameConstraints.minLength > loaded.settings.nameConstraints.maxLength) {
        return {
            settings: undefined,
            diagnostics: [
                ...loaded.diagnostics,
                {
                    severity: "error" as const,
                    message:
                        "Session naming is disabled because nameConstraints.minLength is greater than maxLength.",
                },
            ],
        };
    }

    const model = parsePickerModelReference(loaded.settings.model);
    if (model === undefined) {
        return {
            settings: undefined,
            diagnostics: [
                ...loaded.diagnostics,
                {
                    severity: "error" as const,
                    message:
                        'Session naming is disabled because model must be "current" or provider/model-id.',
                },
            ],
        };
    }

    return {
        settings: { ...loaded.settings, model },
        diagnostics: loaded.diagnostics,
    };
}

export { settingsSchema };
export type { ExtensionSettingsDocument };
export default extensionSettingsDefinition;
