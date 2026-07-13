import { join } from "node:path";
export const EXTENSION_SETTINGS_DIRECTORY = "extension-settings";
export const EXTENSION_SETTINGS_SCHEMA_DIRECTORY = "schemas";
/** Resolve the centralized user-level settings and schema paths. */
export function resolveGlobalSettingsPaths(agentDir, settingsId) {
    const settingsDirectory = join(agentDir, EXTENSION_SETTINGS_DIRECTORY);
    return {
        configPath: join(settingsDirectory, `${settingsId}.json`),
        schemaPath: join(settingsDirectory, EXTENSION_SETTINGS_SCHEMA_DIRECTORY, `${settingsId}.schema.json`),
        schemaReference: `./${EXTENSION_SETTINGS_SCHEMA_DIRECTORY}/${settingsId}.schema.json`,
    };
}
/** Resolve a project override using Pi's configured project-directory name. */
export function resolveProjectSettingsPaths(cwd, configDirName, settingsId) {
    const settingsDirectory = join(cwd, configDirName, EXTENSION_SETTINGS_DIRECTORY);
    return {
        configPath: join(settingsDirectory, `${settingsId}.json`),
        schemaPath: join(settingsDirectory, EXTENSION_SETTINGS_SCHEMA_DIRECTORY, `${settingsId}.schema.json`),
        schemaReference: `./${EXTENSION_SETTINGS_SCHEMA_DIRECTORY}/${settingsId}.schema.json`,
    };
}
/** Default path shown in user-facing README configuration sections. */
export function defaultGlobalSettingsDisplayPath(settingsId) {
    return `~/.pi/agent/${EXTENSION_SETTINGS_DIRECTORY}/${settingsId}.json`;
}
//# sourceMappingURL=paths.js.map