import { loadPiExtensionSettings } from "@zigai/pi-extension-settings/pi";

import { readFileSync } from "node:fs";

import { homedir } from "node:os";

import { dirname, isAbsolute, join, resolve } from "node:path";

import { Type, type Static } from "typebox";

import { Value } from "typebox/value";

import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import {
    DEFAULT_RIGHT_MESSAGE_INTERVAL_MS,
    DEFAULT_RIGHT_MESSAGE_MIN_GAP,
    DEFAULT_RIGHT_MESSAGE_MIN_SCROLL_CYCLES,
    DEFAULT_RIGHT_MESSAGE_SCROLL_COLUMN_INTERVAL_MS,
    RIGHT_MESSAGES_SETTINGS_KEY,
    extensionSettingsInput,
} from "./settings-input.ts";
import prevalidatedSettings from "./settings.prevalidated.ts";
import type { StatusBarConfig } from "./status-bar-api.ts";

export * from "./settings-input.ts";

export const statusBarSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedSettings,
);

export default statusBarSettingsDefinition;

export type RightMessagesConfig = {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly minGap: number;
    readonly minScrollCycles: number;
    readonly scrollColumnIntervalMs: number;
    readonly dimmed: boolean;
    readonly italic: boolean;
    readonly messages: readonly string[];
};

export type StatusBarResolvedConfig = {
    readonly statusBar: StatusBarConfig;
    readonly rightMessages: RightMessagesConfig;
};

export type LoadedStatusBarConfig = {
    readonly config: StatusBarResolvedConfig;
    readonly errors: readonly string[];
};

export type StatusBarSettingsSource = {
    readonly label: string;
    readonly baseDir: string;
    readonly settings: unknown;
};

type MessageFileReference = {
    readonly path: string;
    readonly baseDir: string;
    readonly label: string;
};

type RightMessagesSettings = {
    readonly enabled?: boolean;
    readonly intervalMs?: number;
    readonly minGap?: number;
    readonly minScrollCycles?: number;
    readonly scrollColumnIntervalMs?: number;
    readonly dimmed?: boolean;
    readonly italic?: boolean;
    readonly messages?: readonly string[];
    readonly messagesFile?: MessageFileReference;
};

type MutableRightMessagesSettings = {
    -readonly [Key in keyof RightMessagesSettings]: RightMessagesSettings[Key];
};

type StatusBarSettings = {
    readonly $schema?: string;
    readonly statusBar?: StatusBarConfig;
    readonly rightMessages?: RightMessagesSettings;
};

type MergedStatusBarSettings = {
    statusBar?: StatusBarConfig;
    rightMessages?: RightMessagesSettings;
};

type MutableStatusBarConfig = {
    active?: {
        text?: string;

        spinner?: {
            frames?: readonly string[];
        };

        timer?: {
            visible?: boolean;
            paused?: boolean;
        };
    };

    idle?: {
        text?: string;
        visible?: boolean;
        showLastRunSummary?: boolean;
        showTokensPerSecond?: boolean;
    };
};

const StatusBarSpinnerConfigSchema = Type.Object(
    {
        frames: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: false },
);

const StatusBarTimerConfigSchema = Type.Object(
    {
        visible: Type.Optional(Type.Boolean()),
        paused: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

const StatusBarActiveConfigSchema = Type.Object(
    {
        text: Type.Optional(Type.String()),
        spinner: Type.Optional(StatusBarSpinnerConfigSchema),
        timer: Type.Optional(StatusBarTimerConfigSchema),
    },
    { additionalProperties: false },
);

const StatusBarIdleConfigSchema = Type.Object(
    {
        text: Type.Optional(Type.String()),
        visible: Type.Optional(Type.Boolean()),
        showLastRunSummary: Type.Optional(Type.Boolean()),
        showTokensPerSecond: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

const StatusBarConfigSchema = Type.Object(
    {
        active: Type.Optional(StatusBarActiveConfigSchema),
        idle: Type.Optional(StatusBarIdleConfigSchema),
    },
    { additionalProperties: false },
);

const RightMessagesConfigSchema = Type.Object(
    {
        enabled: Type.Optional(Type.Boolean()),
        intervalMs: Type.Optional(Type.Integer({ minimum: 1 })),
        minGap: Type.Optional(Type.Integer({ minimum: 0 })),
        minScrollCycles: Type.Optional(Type.Integer({ minimum: 1 })),
        scrollColumnIntervalMs: Type.Optional(Type.Integer({ minimum: 1 })),
        dimmed: Type.Optional(Type.Boolean()),
        italic: Type.Optional(Type.Boolean()),
        messages: Type.Optional(Type.Array(Type.String())),
        messagesFile: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
);

const StatusBarConfigFileSchema = Type.Object(
    {
        $schema: Type.Optional(Type.String()),
        statusBar: Type.Optional(StatusBarConfigSchema),
        rightMessages: Type.Optional(RightMessagesConfigSchema),
    },
    { additionalProperties: false },
);

type ParsedStatusBarResolvedConfig = Static<typeof StatusBarConfigFileSchema>;

export const DEFAULT_RIGHT_MESSAGES_CONFIG: RightMessagesConfig = {
    enabled: false,
    intervalMs: DEFAULT_RIGHT_MESSAGE_INTERVAL_MS,
    minGap: DEFAULT_RIGHT_MESSAGE_MIN_GAP,
    minScrollCycles: DEFAULT_RIGHT_MESSAGE_MIN_SCROLL_CYCLES,
    scrollColumnIntervalMs: DEFAULT_RIGHT_MESSAGE_SCROLL_COLUMN_INTERVAL_MS,
    dimmed: true,
    italic: true,
    messages: [],
};

export const DEFAULT_STATUS_BAR_CONFIG: StatusBarConfig = {
    active: {
        timer: {
            visible: true,
            paused: false,
        },
    },
    idle: {
        visible: true,
        showLastRunSummary: true,
        showTokensPerSecond: true,
    },
};

function sanitizeOptionalText(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;

    const sanitized = text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
    if (sanitized.length === 0) return undefined;
    return sanitized;
}

function sanitizeOptionalFrames(
    frames: readonly string[] | undefined,
): readonly string[] | undefined {
    if (frames === undefined) return undefined;

    const sanitizedFrames: string[] = [];
    for (const frame of frames) {
        const sanitized = sanitizeOptionalText(frame);
        if (sanitized !== undefined) {
            sanitizedFrames.push(sanitized);
        }
    }

    if (sanitizedFrames.length === 0) return undefined;
    return sanitizedFrames;
}

function parseStatusBarConfigSettings(
    settings: Static<typeof StatusBarConfigSchema> | undefined,
): StatusBarConfig | undefined {
    if (settings === undefined) return undefined;

    const parsed = settings;

    const statusBar: MutableStatusBarConfig = {};

    if (parsed.active !== undefined) {
        const active: NonNullable<MutableStatusBarConfig["active"]> = {};
        const text = sanitizeOptionalText(parsed.active.text);
        if (text !== undefined) {
            active.text = text;
        }

        const frames = sanitizeOptionalFrames(parsed.active.spinner?.frames);
        if (frames !== undefined) {
            active.spinner = { frames };
        }

        if (parsed.active.timer !== undefined) {
            active.timer = parsed.active.timer;
        }

        statusBar.active = active;
    }

    if (parsed.idle !== undefined) {
        const idle: NonNullable<MutableStatusBarConfig["idle"]> = {};
        const text = sanitizeOptionalText(parsed.idle.text);
        if (text !== undefined) {
            idle.text = text;
        }

        if (parsed.idle.visible !== undefined) {
            idle.visible = parsed.idle.visible;
        }

        if (parsed.idle.showLastRunSummary !== undefined) {
            idle.showLastRunSummary = parsed.idle.showLastRunSummary;
        }

        if (parsed.idle.showTokensPerSecond !== undefined) {
            idle.showTokensPerSecond = parsed.idle.showTokensPerSecond;
        }

        statusBar.idle = idle;
    }

    return statusBar;
}

function formatSchemaPath(instancePath: string): string {
    if (instancePath.length === 0) return "root";
    return instancePath
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
        .join(".");
}

function parseStatusBarConfigFile(
    value: StatusBarSettingsSource["settings"],
    label: string,
): ParsedStatusBarResolvedConfig {
    const errors = [...Value.Errors(StatusBarConfigFileSchema, value)];
    if (errors.length > 0) {
        const messages = errors
            .slice(0, 10)
            .map((error) => `${formatSchemaPath(error.instancePath)} ${error.message}`);
        let suffix = "";
        if (errors.length > messages.length) {
            suffix = `; and ${errors.length - messages.length} more`;
        }

        throw new Error(`${label} is invalid: ${messages.join("; ")}${suffix}`);
    }

    return Value.Parse(StatusBarConfigFileSchema, value);
}

type ParsedSettings = {
    readonly settings: StatusBarSettings;
    readonly errors: string[];
};

function parseStatusBarSettings(
    settings: StatusBarSettingsSource["settings"],
    label: string,
    baseDir: string,
): ParsedSettings {
    let parsedConfig: ParsedStatusBarResolvedConfig;
    try {
        parsedConfig = parseStatusBarConfigFile(settings, label);
    } catch (error: unknown) {
        let message = String(error);
        if (error instanceof Error) message = error.message;

        return { settings: {}, errors: [message] };
    }

    const rightMessages = parsedConfig.rightMessages;
    let rightMessagesSettings: RightMessagesSettings | undefined;
    if (rightMessages !== undefined) {
        const { messagesFile: configuredMessagesFile, ...configuredRightMessages } = rightMessages;
        const parsedRightMessages: MutableRightMessagesSettings = {
            ...configuredRightMessages,
        };
        if (rightMessages.messages !== undefined) {
            parsedRightMessages.messages = rightMessages.messages
                .map((message) => message.trim())
                .filter((message) => message.length > 0);
        }

        const messagesFilePath = configuredMessagesFile?.trim();
        if (messagesFilePath !== undefined) {
            parsedRightMessages.messagesFile = {
                path: messagesFilePath,
                baseDir,
                label: `${label}.${RIGHT_MESSAGES_SETTINGS_KEY}.messagesFile`,
            };
        }

        rightMessagesSettings = parsedRightMessages;
    }

    return {
        settings: {
            statusBar: parseStatusBarConfigSettings(parsedConfig.statusBar),
            rightMessages: rightMessagesSettings,
        },
        errors: [],
    };
}

function mergeStatusBarConfig(
    current: StatusBarConfig | undefined,
    next: StatusBarConfig | undefined,
): StatusBarConfig | undefined {
    if (current === undefined) return next;
    if (next === undefined) return current;

    return {
        active: {
            ...current.active,
            ...next.active,
            spinner: {
                ...current.active?.spinner,
                ...next.active?.spinner,
            },
            timer: {
                ...current.active?.timer,
                ...next.active?.timer,
            },
        },
        idle: {
            ...current.idle,
            ...next.idle,
        },
    };
}

function resolveConfiguredPath(path: string, baseDir: string): string {
    if (path === "~") {
        return homedir();
    }

    if (path.startsWith("~/")) {
        return join(homedir(), path.slice(2));
    }

    if (isAbsolute(path)) {
        return path;
    }

    return resolve(baseDir, path);
}

function parseMessagesFileContent(content: string): string[] {
    const messages: string[] = [];
    for (const line of content.split(/\r?\n/u)) {
        const message = line.trim();
        if (message.length === 0) {
            continue;
        }

        if (message.startsWith("#")) {
            continue;
        }

        messages.push(message);
    }

    return messages;
}

type LoadedMessagesFile = {
    readonly messages: string[];
    readonly error?: string;
};

function readMessagesFile(reference: MessageFileReference): LoadedMessagesFile {
    const resolvedPath = resolveConfiguredPath(reference.path, reference.baseDir);

    try {
        const content = readFileSync(resolvedPath, "utf8");
        return { messages: parseMessagesFileContent(content) };
    } catch (cause: unknown) {
        let message = String(cause);
        if (cause instanceof Error) message = cause.message;

        return {
            messages: [],
            error: `Failed to read ${reference.label} (${resolvedPath}): ${message}`,
        };
    }
}

function buildStatusBarResolvedConfig(settings: StatusBarSettings): LoadedStatusBarConfig {
    const rightMessages = settings.rightMessages ?? {};
    const errors: string[] = [];
    const messages: string[] = [];

    if (rightMessages.enabled === false) {
        return {
            config: {
                statusBar: settings.statusBar ?? DEFAULT_STATUS_BAR_CONFIG,
                rightMessages: {
                    enabled: false,
                    intervalMs:
                        rightMessages.intervalMs ?? DEFAULT_RIGHT_MESSAGES_CONFIG.intervalMs,
                    minGap: rightMessages.minGap ?? DEFAULT_RIGHT_MESSAGES_CONFIG.minGap,
                    minScrollCycles:
                        rightMessages.minScrollCycles ??
                        DEFAULT_RIGHT_MESSAGES_CONFIG.minScrollCycles,
                    scrollColumnIntervalMs:
                        rightMessages.scrollColumnIntervalMs ??
                        DEFAULT_RIGHT_MESSAGES_CONFIG.scrollColumnIntervalMs,
                    dimmed: rightMessages.dimmed ?? DEFAULT_RIGHT_MESSAGES_CONFIG.dimmed,
                    italic: rightMessages.italic ?? DEFAULT_RIGHT_MESSAGES_CONFIG.italic,
                    messages: [],
                },
            },
            errors,
        };
    }

    if (rightMessages.messages !== undefined) {
        messages.push(...rightMessages.messages);
    }

    if (rightMessages.messagesFile !== undefined) {
        const loaded = readMessagesFile(rightMessages.messagesFile);
        messages.push(...loaded.messages);

        if (loaded.error !== undefined) {
            errors.push(loaded.error);
        }
    }

    let enabled = messages.length > 0;
    if (rightMessages.enabled !== undefined) {
        enabled = rightMessages.enabled;
    }

    return {
        config: {
            statusBar: settings.statusBar ?? DEFAULT_STATUS_BAR_CONFIG,
            rightMessages: {
                enabled,
                intervalMs: rightMessages.intervalMs ?? DEFAULT_RIGHT_MESSAGES_CONFIG.intervalMs,
                minGap: rightMessages.minGap ?? DEFAULT_RIGHT_MESSAGES_CONFIG.minGap,
                minScrollCycles:
                    rightMessages.minScrollCycles ?? DEFAULT_RIGHT_MESSAGES_CONFIG.minScrollCycles,
                scrollColumnIntervalMs:
                    rightMessages.scrollColumnIntervalMs ??
                    DEFAULT_RIGHT_MESSAGES_CONFIG.scrollColumnIntervalMs,
                dimmed: rightMessages.dimmed ?? DEFAULT_RIGHT_MESSAGES_CONFIG.dimmed,
                italic: rightMessages.italic ?? DEFAULT_RIGHT_MESSAGES_CONFIG.italic,
                messages,
            },
        },
        errors,
    };
}

/**
 * Resolves status bar settings from already-parsed Pi settings objects in precedence order.
 */
export function resolveStatusBarResolvedConfig(
    settingsSources: readonly StatusBarSettingsSource[],
): LoadedStatusBarConfig {
    const mergedSettings: MergedStatusBarSettings = {};
    const errors: string[] = [];

    for (const source of settingsSources) {
        const parsed = parseStatusBarSettings(source.settings, source.label, source.baseDir);
        mergedSettings.statusBar = mergeStatusBarConfig(
            mergedSettings.statusBar,
            parsed.settings.statusBar,
        );

        if (parsed.settings.rightMessages !== undefined) {
            Object.assign((mergedSettings.rightMessages ??= {}), parsed.settings.rightMessages);
        }

        errors.push(...parsed.errors);
    }

    const loaded = buildStatusBarResolvedConfig(mergedSettings);
    return {
        config: loaded.config,
        errors: [...errors, ...loaded.errors],
    };
}

/** Load status-bar settings from global and trusted-project extension settings. */
export function loadStatusBarSettings(cwd: string, projectTrusted: boolean): LoadedStatusBarConfig {
    const settings = loadPiExtensionSettings(
        statusBarSettingsDefinition,
        { cwd, isProjectTrusted: () => projectTrusted },
        {
            bundledSchema: {
                kind: "url",
                url: new URL("../config.schema.json", import.meta.url),
            },
        },
    );
    const settingsSources: StatusBarSettingsSource[] = [];
    if (settings.globalSettingsLayer !== undefined) {
        settingsSources.push({
            label: settings.globalConfigPath,
            baseDir: dirname(settings.globalConfigPath),
            settings: settings.globalSettingsLayer,
        });
    }

    if (settings.projectSettingsLayer !== undefined && settings.projectConfigPath !== undefined) {
        settingsSources.push({
            label: settings.projectConfigPath,
            baseDir: cwd,
            settings: settings.projectSettingsLayer,
        });
    }

    const loaded = resolveStatusBarResolvedConfig(settingsSources);

    return {
        config: loaded.config,
        errors: [...settings.diagnostics.map((diagnostic) => diagnostic.message), ...loaded.errors],
    };
}
