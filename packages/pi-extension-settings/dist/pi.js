import { CONFIG_DIR_NAME, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { loadExtensionSettings, loadExtensionSettingsSync, } from "./runtime.js";
/** Load settings using Pi's configured global and project-directory locations. */
export function loadPiExtensionSettings(definition, context, options) {
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
export function loadPiExtensionSettingsSync(definition, context, options) {
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
//# sourceMappingURL=pi.js.map