import {
    CONFIG_DIR_NAME,
    getAgentDir,
    type ExtensionContext,
    withFileMutationQueue,
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
import type { PiSettingsRevision } from "./settings-revision.ts";
import {
    updateSettingsTransaction,
    type PiSettingsUpdateIssue,
    type PiSettingsUpdateScope,
    type UpdatePiExtensionSettingsOptions,
    type UpdatePiExtensionSettingsResult,
} from "./settings-transaction.ts";

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
export type {
    BundledSchemaSource,
    PiSettingsRevision,
    PiSettingsUpdateIssue,
    PiSettingsUpdateScope,
    SettingsDiagnostic,
    SettingsDiagnosticCode,
    UpdatePiExtensionSettingsOptions,
    UpdatePiExtensionSettingsResult,
};

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
 * @returns Decoded settings, encoded layers, source revisions, paths, installation state, and diagnostics.
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

async function withFileMutationQueues<Result>(
    paths: readonly string[],
    operation: () => Promise<Result>,
    index = 0,
): Promise<Result> {
    const path = paths[index];
    if (path === undefined) return operation();
    return withFileMutationQueue(path, () => withFileMutationQueues(paths, operation, index + 1));
}

/**
 * Transactionally updates an extension's encoded global or project settings layer.
 *
 * The latest layer is read, validated, cloned, and passed once to `options.update` while the target
 * settings sources are protected by Pi's in-process mutation queue and a cooperative inter-process
 * lock. The returned layer is validated both independently and after resolution over defaults and
 * earlier layers, then atomically published. Existing malformed or invalid settings are never
 * overwritten.
 *
 * Call `loadPiExtensionSettings` before updating so the generated editor schema is installed and
 * verified for the active definition.
 *
 * Pass `expectedRevision` for snapshot-based editors that must reject changes made after opening.
 * Omit it for semantic updates that should apply to the latest valid layer. Project updates are
 * blocked unless Pi reports the project as trusted; calling this function is an explicit write and
 * may create a missing trusted-project settings file.
 *
 * @template Schema The TypeBox object schema from the supplied extension definition.
 * @param definition A validated definition created by `defineExtensionSettings`.
 * @param context The current Pi extension context used for paths and project trust.
 * @param options Scope, optional optimistic revision, and synchronous encoded-layer updater.
 * @returns A typed update outcome; filesystem and validation failures do not expose settings values.
 * @throws The original error when `options.update` throws an `Error`.
 */
export async function updatePiExtensionSettings<const Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
    context: PiSettingsContext,
    options: UpdatePiExtensionSettingsOptions<Schema>,
): Promise<UpdatePiExtensionSettingsResult> {
    const global = resolveGlobalSettingsPaths(getAgentDir(), definition.id);
    const project = resolveProjectSettingsPaths(context.cwd, CONFIG_DIR_NAME, definition.id);
    const projectTrusted = context.isProjectTrusted();
    const paths =
        options.scope === "global"
            ? [global.configPath]
            : [global.configPath, project.configPath].sort();
    return withFileMutationQueues(paths, () =>
        updateSettingsTransaction(definition, {
            ...options,
            paths: { global, project },
            projectTrusted,
        }),
    );
}
