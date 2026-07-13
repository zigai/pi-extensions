import {
    CONFIG_DIR_NAME,
    getAgentDir,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TObject } from "typebox";

import type { ExtensionSettingsDefinition } from "./definition.ts";
import {
    loadExtensionSettings,
    loadExtensionSettingsSync,
    type BundledSchemaSource,
    type LoadedExtensionSettings,
} from "./runtime.ts";

export type PiSettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

export type LoadPiExtensionSettingsOptions = {
    readonly bundledSchema: BundledSchemaSource;
    /** Test or embedded-host override. Normal Pi extensions should omit this. */
    readonly agentDir?: string;
};

/** Load settings using Pi's configured global and project-directory locations. */
export function loadPiExtensionSettings<const Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
    context: PiSettingsContext,
    options: LoadPiExtensionSettingsOptions,
): Promise<LoadedExtensionSettings<Schema>> {
    return loadExtensionSettings(definition, {
        agentDir: options.agentDir ?? getAgentDir(),
        bundledSchema: options.bundledSchema,
        project: {
            cwd: context.cwd,
            configDirName: CONFIG_DIR_NAME,
            trusted: context.isProjectTrusted(),
        },
    });
}

/** Synchronously load settings for Pi APIs that cannot await configuration. */
export function loadPiExtensionSettingsSync<const Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
    context: PiSettingsContext,
    options: LoadPiExtensionSettingsOptions,
): LoadedExtensionSettings<Schema> {
    return loadExtensionSettingsSync(definition, {
        agentDir: options.agentDir ?? getAgentDir(),
        bundledSchema: options.bundledSchema,
        project: {
            cwd: context.cwd,
            configDirName: CONFIG_DIR_NAME,
            trusted: context.isProjectTrusted(),
        },
    });
}
