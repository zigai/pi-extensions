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

/**
 * Portion of Pi's extension context required to locate and authorize project settings.
 *
 * Pass the current `ExtensionContext` directly; callers do not need to construct this object.
 */
export type PiSettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

/** Options for {@link loadPiExtensionSettings}. */
export type LoadPiExtensionSettingsOptions = {
    /** Generated schema bundled with the extension package. */
    readonly bundledSchema: BundledSchemaSource;
};

/**
 * Settings resolution result returned by {@link loadPiExtensionSettings}.
 *
 * @template Schema The TypeBox object schema from the supplied extension definition.
 */
export type LoadedPiExtensionSettings<Schema extends TObject> = LoadedSettings<Schema>;
export type { BundledSchemaSource, SettingsDiagnostic, SettingsDiagnosticCode };

/**
 * Returns the absolute global settings path for an extension.
 *
 * The path is `<getAgentDir()>/extension-settings/<extensionId>.json`. This function does not access
 * the filesystem.
 *
 * @param extensionId The definition ID used in the settings filename.
 */
export function getPiGlobalSettingsPath(extensionId: string): string {
    return resolveGlobalSettingsPaths(getAgentDir(), extensionId).configPath;
}

/**
 * Returns the absolute project-settings path for an extension.
 *
 * The path is `<cwd>/<CONFIG_DIR_NAME>/extension-settings/<extensionId>.json`. This function does
 * not check project trust or access the filesystem.
 *
 * @param extensionId The definition ID used in the settings filename.
 * @param cwd The project directory, normally `ctx.cwd`.
 */
export function getPiProjectSettingsPath(extensionId: string, cwd: string): string {
    return resolveProjectSettingsPaths(cwd, CONFIG_DIR_NAME, extensionId).configPath;
}

/**
 * Loads an extension's resolved settings using Pi's standard directories and trust state.
 *
 * Resolution starts with schema defaults, recursively merges the global layer, then recursively
 * merges the project layer only when Pi reports the project as trusted. Arrays and scalar values
 * replace earlier values. Unreadable, malformed, invalid, or undecodable layers are ignored and
 * reported in `diagnostics`.
 *
 * Loading is synchronous. When the bundled schema matches the definition, the function atomically
 * installs the editor schema and creates the global settings file if it does not exist. Existing
 * settings files are never overwritten, and project settings files are never created.
 *
 * @template Schema The TypeBox object schema used to infer the decoded `settings` value.
 * @param definition A validated definition created by `defineExtensionSettings`.
 * @param context The current Pi extension context.
 * @param options The generated schema bundled with the extension.
 * @returns Decoded settings, accepted layers, paths, installation state, and non-fatal diagnostics.
 * @throws If a custom TypeBox transform decoder throws while decoding the resolved settings.
 *
 * @example
 * ```ts
 * import { loadPiExtensionSettings } from "@zigai/pi-extension-settings/pi";
 * import settingsDefinition from "./settings.ts";
 *
 * const loaded = loadPiExtensionSettings(settingsDefinition, ctx, {
 *   bundledSchema: {
 *     kind: "url",
 *     url: new URL("../config.schema.json", import.meta.url),
 *   },
 * });
 * ```
 */
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
