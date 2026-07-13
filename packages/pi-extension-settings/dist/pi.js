import { CONFIG_DIR_NAME, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadExtensionSettings, loadExtensionSettingsSync, } from "./runtime.js";
function legacyConfigPaths(definition, agentDir, context, additionalIds) {
    const ids = [...new Set([definition.id, ...additionalIds])];
    return {
        global: ids.map((id) => join(agentDir, id, "config.json")),
        project: ids.map((id) => join(context.cwd, CONFIG_DIR_NAME, id, "config.json")),
    };
}
/** Load settings using Pi's configured global and project-directory locations. */
export function loadPiExtensionSettings(definition, context, options) {
    const agentDir = options.agentDir ?? getAgentDir();
    return loadExtensionSettings(definition, {
        agentDir,
        bundledSchema: options.bundledSchema,
        project: {
            cwd: context.cwd,
            configDirName: CONFIG_DIR_NAME,
            trusted: context.isProjectTrusted(),
        },
        legacyConfigPaths: legacyConfigPaths(definition, agentDir, context, options.legacySettingsIds ?? []),
    });
}
/** Synchronously load settings for Pi APIs that cannot await configuration. */
export function loadPiExtensionSettingsSync(definition, context, options) {
    const agentDir = options.agentDir ?? getAgentDir();
    return loadExtensionSettingsSync(definition, {
        agentDir,
        bundledSchema: options.bundledSchema,
        project: {
            cwd: context.cwd,
            configDirName: CONFIG_DIR_NAME,
            trusted: context.isProjectTrusted(),
        },
        legacyConfigPaths: legacyConfigPaths(definition, agentDir, context, options.legacySettingsIds ?? []),
    });
}
//# sourceMappingURL=pi.js.map