import {
    CONFIG_DIR_NAME,
    getAgentDir,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { TObject } from "typebox";

import type { ExtensionSettingsDefinition } from "./definition.ts";
import {
    loadExtensionSettings,
    loadExtensionSettingsSync,
    type BundledSchemaSource,
    type LoadedExtensionSettings,
} from "./runtime.ts";

export type PiSettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

export type LegacyPiConfigPaths = {
    readonly global?: readonly string[];
    readonly project?: readonly string[];
};

export type LoadPiExtensionSettingsOptions = {
    readonly bundledSchema: BundledSchemaSource;
    /** Test or embedded-host override. Normal Pi extensions should omit this. */
    readonly agentDir?: string;
    /** Additional historical extension IDs whose per-extension config may be migrated. */
    readonly legacySettingsIds?: readonly string[];
    /** Historical config paths that do not follow the conventional `<id>/config.json` layout. */
    readonly legacyConfigPaths?: LegacyPiConfigPaths;
};

function legacyConfigPaths<Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
    agentDir: string,
    context: PiSettingsContext,
    additionalIds: readonly string[],
    additionalPaths: LegacyPiConfigPaths,
): { readonly global: readonly string[]; readonly project: readonly string[] } {
    const ids = [...new Set([definition.id, ...additionalIds])];
    return {
        global: [
            ...new Set([
                ...ids.map((id) => join(agentDir, id, "config.json")),
                ...(additionalPaths.global ?? []),
            ]),
        ],
        project: [
            ...new Set([
                ...ids.map((id) => join(context.cwd, CONFIG_DIR_NAME, id, "config.json")),
                ...(additionalPaths.project ?? []),
            ]),
        ],
    };
}

/** Load settings using Pi's configured global and project-directory locations. */
export function loadPiExtensionSettings<const Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
    context: PiSettingsContext,
    options: LoadPiExtensionSettingsOptions,
): Promise<LoadedExtensionSettings<Schema>> {
    const agentDir = options.agentDir ?? getAgentDir();
    return loadExtensionSettings(definition, {
        agentDir,
        bundledSchema: options.bundledSchema,
        project: {
            cwd: context.cwd,
            configDirName: CONFIG_DIR_NAME,
            trusted: context.isProjectTrusted(),
        },
        legacyConfigPaths: legacyConfigPaths(
            definition,
            agentDir,
            context,
            options.legacySettingsIds ?? [],
            options.legacyConfigPaths ?? {},
        ),
    });
}

/** Synchronously load settings for Pi APIs that cannot await configuration. */
export function loadPiExtensionSettingsSync<const Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
    context: PiSettingsContext,
    options: LoadPiExtensionSettingsOptions,
): LoadedExtensionSettings<Schema> {
    const agentDir = options.agentDir ?? getAgentDir();
    return loadExtensionSettingsSync(definition, {
        agentDir,
        bundledSchema: options.bundledSchema,
        project: {
            cwd: context.cwd,
            configDirName: CONFIG_DIR_NAME,
            trusted: context.isProjectTrusted(),
        },
        legacyConfigPaths: legacyConfigPaths(
            definition,
            agentDir,
            context,
            options.legacySettingsIds ?? [],
            options.legacyConfigPaths ?? {},
        ),
    });
}
