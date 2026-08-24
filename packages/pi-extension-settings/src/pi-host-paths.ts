import { homedir } from "node:os";
import { join } from "node:path";

/** Pi's public project configuration directory for the supported upstream runtime. */
export const PI_CONFIG_DIR_NAME = ".pi";

const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Resolves Pi's agent directory without evaluating the full coding-agent runtime graph. */
export function getPiAgentDir(
    env: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): string {
    const configured = env[PI_AGENT_DIR_ENV];
    if (configured === undefined || configured.length === 0) {
        return join(homeDirectory, PI_CONFIG_DIR_NAME, "agent");
    }
    if (configured === "~") {
        return homeDirectory;
    }
    if (
        configured.startsWith("~/") ||
        (process.platform === "win32" && configured.startsWith("~\\"))
    ) {
        return join(homeDirectory, configured.slice(2));
    }
    return configured;
}
