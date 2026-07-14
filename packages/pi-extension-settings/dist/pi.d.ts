import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TObject } from "typebox";
import type { ExtensionSettingsDefinition } from "./definition.ts";
import { type BundledSchemaSource, type LoadedExtensionSettings } from "./runtime.ts";
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
/** Load settings using Pi's configured global and project-directory locations. */
export declare function loadPiExtensionSettings<const Schema extends TObject>(definition: ExtensionSettingsDefinition<Schema>, context: PiSettingsContext, options: LoadPiExtensionSettingsOptions): Promise<LoadedExtensionSettings<Schema>>;
/** Synchronously load settings for Pi APIs that cannot await configuration. */
export declare function loadPiExtensionSettingsSync<const Schema extends TObject>(definition: ExtensionSettingsDefinition<Schema>, context: PiSettingsContext, options: LoadPiExtensionSettingsOptions): LoadedExtensionSettings<Schema>;
//# sourceMappingURL=pi.d.ts.map