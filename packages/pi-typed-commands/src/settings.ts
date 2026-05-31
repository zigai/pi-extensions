import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PiCommandArgsSettings = {
    enabled: boolean;
    uxEnabled: boolean;
};

type RawSettings = {
    piCommandArgs?: {
        enabled?: boolean;
        uxEnabled?: boolean;
    };
};

type CachedSettings = {
    mtimeMs: number | undefined;
    enabled: boolean | undefined;
    uxEnabled: boolean | undefined;
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
            enabled: raw.piCommandArgs?.enabled,
            uxEnabled: raw.piCommandArgs?.uxEnabled,
        };
        cache.set(path, settings);
        return settings;
    } catch {
        const settings: CachedSettings = {
            mtimeMs: stat.mtimeMs,
            enabled: undefined,
            uxEnabled: undefined,
        };
        cache.set(path, settings);
        return settings;
    }
}

function applySettings(
    current: PiCommandArgsSettings,
    next: CachedSettings,
): PiCommandArgsSettings {
    const merged: PiCommandArgsSettings = { ...current };
    if (next.enabled !== undefined) {
        merged.enabled = next.enabled;
    }
    if (next.uxEnabled !== undefined) {
        merged.uxEnabled = next.uxEnabled;
    }
    return merged;
}

export function getPiCommandArgsSettings(cwd = process.cwd()): PiCommandArgsSettings {
    let settings: PiCommandArgsSettings = {
        enabled: true,
        uxEnabled: true,
    };

    settings = applySettings(settings, parseSettings(agentSettingsPath()));
    settings = applySettings(settings, parseSettings(projectSettingsPath(cwd)));

    const envEnabled = readEnvBoolean("PI_COMMAND_ARGS");
    if (envEnabled !== undefined) {
        settings.enabled = envEnabled;
    }

    const envUxEnabled = readEnvBoolean("PI_COMMAND_ARGS_UX");
    if (envUxEnabled !== undefined) {
        settings.uxEnabled = envUxEnabled;
    }

    if (!settings.enabled) {
        settings.uxEnabled = false;
    }

    return settings;
}
