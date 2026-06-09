import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolved pi-typed-commands settings after defaults, files, and environment overrides. */
export type PiTypedCommandsSettings = {
    /** Whether typed parsing, completions, forms, and helper UX are enabled. */
    enabled: boolean;
    /** Whether the live helper, typed autocomplete bridge, and Tab-to-form UX are enabled. */
    uxEnabled: boolean;
    /** Whether compact usage lines include primitive type names. */
    uxShowTypes: boolean;
};

type RawSettings = {
    piTypedCommands?: {
        enabled?: boolean;
        uxEnabled?: boolean;
        uxShowTypes?: boolean;
    };
};

type CachedSettings = {
    mtimeMs: number | undefined;
    enabled: boolean | undefined;
    uxEnabled: boolean | undefined;
    uxShowTypes: boolean | undefined;
};

const cache = new Map<string, CachedSettings>();

function readEnvBoolean(name: string): boolean | undefined {
    const value = process.env[name]?.toLowerCase();
    if (value === undefined) {
        return undefined;
    }
    if (["0", "false", "no", "off"].includes(value)) {
        return false;
    }
    if (["1", "true", "yes", "on"].includes(value)) {
        return true;
    }
    return undefined;
}

function defaultAgentDir(): string {
    return join(homedir(), ".pi", "agent");
}

function agentSettingsPath(): string {
    return join(process.env.PI_CODING_AGENT_DIR ?? defaultAgentDir(), "settings.json");
}

function projectSettingsPath(cwd: string): string {
    return join(cwd, ".pi", "settings.json");
}

function parseSettings(path: string): CachedSettings {
    if (!existsSync(path)) {
        return {
            mtimeMs: undefined,
            enabled: undefined,
            uxEnabled: undefined,
            uxShowTypes: undefined,
        };
    }

    const stat = statSync(path);
    const cached = cache.get(path);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) {
        return cached;
    }

    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as RawSettings;
        const settings: CachedSettings = {
            mtimeMs: stat.mtimeMs,
            enabled: raw.piTypedCommands?.enabled,
            uxEnabled: raw.piTypedCommands?.uxEnabled,
            uxShowTypes: raw.piTypedCommands?.uxShowTypes,
        };
        cache.set(path, settings);
        return settings;
    } catch {
        const settings: CachedSettings = {
            mtimeMs: stat.mtimeMs,
            enabled: undefined,
            uxEnabled: undefined,
            uxShowTypes: undefined,
        };
        cache.set(path, settings);
        return settings;
    }
}

function applySettings(
    current: PiTypedCommandsSettings,
    next: CachedSettings,
): PiTypedCommandsSettings {
    const merged: PiTypedCommandsSettings = { ...current };
    if (next.enabled !== undefined) {
        merged.enabled = next.enabled;
    }
    if (next.uxEnabled !== undefined) {
        merged.uxEnabled = next.uxEnabled;
    }
    if (next.uxShowTypes !== undefined) {
        merged.uxShowTypes = next.uxShowTypes;
    }
    return merged;
}

/**
 * Resolve pi-typed-commands settings for a working directory.
 *
 * Precedence is defaults, agent settings, project settings, then environment variables.
 */
export function getPiTypedCommandsSettings(cwd = process.cwd()): PiTypedCommandsSettings {
    let settings: PiTypedCommandsSettings = {
        enabled: true,
        uxEnabled: true,
        uxShowTypes: false,
    };

    settings = applySettings(settings, parseSettings(agentSettingsPath()));
    settings = applySettings(settings, parseSettings(projectSettingsPath(cwd)));

    const envEnabled = readEnvBoolean("PI_TYPED_COMMANDS");
    if (envEnabled !== undefined) {
        settings.enabled = envEnabled;
    }

    const envUxEnabled = readEnvBoolean("PI_TYPED_COMMANDS_UX");
    if (envUxEnabled !== undefined) {
        settings.uxEnabled = envUxEnabled;
    }

    const envUxShowTypes = readEnvBoolean("PI_TYPED_COMMANDS_UX_SHOW_TYPES");
    if (envUxShowTypes !== undefined) {
        settings.uxShowTypes = envUxShowTypes;
    }

    if (!settings.enabled) {
        settings.uxEnabled = false;
    }

    return settings;
}
