import type { StaticDecode, TObject } from "typebox";
import type { ExtensionSettingsDefinition } from "./definition.ts";
export type BundledSchemaSource = {
    readonly kind: "content";
    readonly content: string;
} | {
    readonly kind: "url";
    readonly url: URL;
};
export type ProjectSettingsLocation = {
    readonly cwd: string;
    readonly configDirName: string;
    readonly trusted: boolean;
};
export type LoadExtensionSettingsOptions = {
    readonly agentDir: string;
    readonly bundledSchema: BundledSchemaSource;
    readonly project?: ProjectSettingsLocation;
};
export type SettingsDiagnosticCode = "bundled-schema-read-failed" | "bundled-schema-stale" | "config-decode-failed" | "config-invalid" | "config-malformed" | "config-read-failed" | "config-scaffold-failed" | "schema-install-failed";
export type SettingsDiagnostic = {
    readonly code: SettingsDiagnosticCode;
    readonly severity: "error" | "warning";
    readonly scope: "global" | "project" | "schema";
    readonly path: string;
    readonly message: string;
    readonly issues?: readonly {
        readonly path: string;
        readonly message: string;
    }[];
};
export type LoadedExtensionSettings<Schema extends TObject> = {
    readonly settings: StaticDecode<Schema>;
    readonly diagnostics: readonly SettingsDiagnostic[];
    readonly globalConfigPath: string;
    readonly projectConfigPath: string | undefined;
    readonly usedGlobalConfig: boolean;
    readonly usedProjectConfig: boolean;
    readonly scaffoldedGlobalConfig: boolean;
    readonly schemaStatus: "created" | "unavailable" | "unchanged" | "updated";
};
/**
 * Load global and trusted project settings without ever replacing a user-owned file.
 * Invalid layers are reported and ignored; the returned settings always satisfy the
 * resolved TypeBox schema established by `defineExtensionSettings`.
 */
export declare function loadExtensionSettings<const Schema extends TObject>(definition: ExtensionSettingsDefinition<Schema>, options: LoadExtensionSettingsOptions): Promise<LoadedExtensionSettings<Schema>>;
/** Synchronous counterpart to `loadExtensionSettings` for render and patch paths. */
export declare function loadExtensionSettingsSync<const Schema extends TObject>(definition: ExtensionSettingsDefinition<Schema>, options: LoadExtensionSettingsOptions): LoadedExtensionSettings<Schema>;
//# sourceMappingURL=runtime.d.ts.map