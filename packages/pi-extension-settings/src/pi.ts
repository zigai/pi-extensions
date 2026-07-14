import {
    CONFIG_DIR_NAME,
    getAgentDir,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TObject } from "typebox";

import type { ExtensionSettingsDefinition } from "./definition.ts";
import { resolveGlobalSettingsPaths, resolveProjectSettingsPaths } from "./paths.ts";
import {
    loadSettings,
    type BundledSchemaSource,
    type LoadedSettings,
    type SettingsDiagnostic,
    type SettingsDiagnosticCode,
} from "./settings-loader.ts";

export type PiSettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

export type LoadPiExtensionSettingsOptions = {
    readonly bundledSchema: BundledSchemaSource;
};

export type LoadedPiExtensionSettings<Schema extends TObject> = LoadedSettings<Schema>;
export type { BundledSchemaSource, SettingsDiagnostic, SettingsDiagnosticCode };

export function getPiGlobalSettingsPath(extensionId: string): string {
    return resolveGlobalSettingsPaths(getAgentDir(), extensionId).configPath;
}

export function getPiProjectSettingsPath(extensionId: string, cwd: string): string {
    return resolveProjectSettingsPaths(cwd, CONFIG_DIR_NAME, extensionId).configPath;
}

export function loadPiExtensionSettings<const Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
    context: PiSettingsContext,
    options: LoadPiExtensionSettingsOptions,
): LoadedPiExtensionSettings<Schema> {
    return loadSettings(definition, {
        agentDir: getAgentDir(),
        bundledSchema: options.bundledSchema,
        project: {
            cwd: context.cwd,
            configDirName: CONFIG_DIR_NAME,
            trusted: context.isProjectTrusted(),
        },
    });
}
