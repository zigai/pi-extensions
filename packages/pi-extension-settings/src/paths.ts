import { join } from "node:path";

export const EXTENSION_SETTINGS_DIRECTORY = "extension-settings";
export const EXTENSION_SETTINGS_SCHEMA_DIRECTORY = "schemas";

export type ExtensionSettingsPaths = {
    readonly configPath: string;
    readonly schemaPath: string;
    readonly schemaReference: string;
};

export function resolveGlobalSettingsPaths(
    agentDir: string,
    settingsId: string,
): ExtensionSettingsPaths {
    const settingsDirectory = join(agentDir, EXTENSION_SETTINGS_DIRECTORY);
    return {
        configPath: join(settingsDirectory, `${settingsId}.json`),
        schemaPath: join(
            settingsDirectory,
            EXTENSION_SETTINGS_SCHEMA_DIRECTORY,
            `${settingsId}.schema.json`,
        ),
        schemaReference: `./${EXTENSION_SETTINGS_SCHEMA_DIRECTORY}/${settingsId}.schema.json`,
    };
}

export function resolveProjectSettingsPaths(
    cwd: string,
    configDirName: string,
    settingsId: string,
): ExtensionSettingsPaths {
    const settingsDirectory = join(cwd, configDirName, EXTENSION_SETTINGS_DIRECTORY);
    return {
        configPath: join(settingsDirectory, `${settingsId}.json`),
        schemaPath: join(
            settingsDirectory,
            EXTENSION_SETTINGS_SCHEMA_DIRECTORY,
            `${settingsId}.schema.json`,
        ),
        schemaReference: `./${EXTENSION_SETTINGS_SCHEMA_DIRECTORY}/${settingsId}.schema.json`,
    };
}

export function defaultGlobalSettingsDisplayPath(settingsId: string): string {
    return `~/.pi/agent/${EXTENSION_SETTINGS_DIRECTORY}/${settingsId}.json`;
}
