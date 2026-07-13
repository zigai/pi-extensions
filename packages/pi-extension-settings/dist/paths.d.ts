export declare const EXTENSION_SETTINGS_DIRECTORY = "extension-settings";
export declare const EXTENSION_SETTINGS_SCHEMA_DIRECTORY = "schemas";
export type ExtensionSettingsPaths = {
    readonly configPath: string;
    readonly schemaPath: string;
    readonly schemaReference: string;
};
/** Resolve the centralized user-level settings and schema paths. */
export declare function resolveGlobalSettingsPaths(agentDir: string, settingsId: string): ExtensionSettingsPaths;
/** Resolve a project override using Pi's configured project-directory name. */
export declare function resolveProjectSettingsPaths(cwd: string, configDirName: string, settingsId: string): ExtensionSettingsPaths;
/** Default path shown in user-facing README configuration sections. */
export declare function defaultGlobalSettingsDisplayPath(settingsId: string): string;
//# sourceMappingURL=paths.d.ts.map