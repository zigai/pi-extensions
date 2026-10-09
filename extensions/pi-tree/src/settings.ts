import {
    loadPiExtensionSettings,
    updatePiExtensionSettings,
    type LoadedPiExtensionSettings,
} from "@zigai/pi-extension-settings/pi";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Value } from "typebox/value";

import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import {
    MAX_VISIBLE_LINES_SETTINGS_KEY,
    MIN_VISIBLE_LINES,
    PREVIEW_FULL_HEIGHT_SETTINGS_KEY,
    PREVIEW_SETTINGS_KEY,
    SETTINGS_KEY,
    SettingsObject,
    TreeTimestampModeSchema,
    extensionSettingsInput,
} from "./settings-input.ts";
import prevalidatedSettings from "./settings.prevalidated.ts";
import { DEFAULT_MODE, type TreeTimestampMode } from "./timestamps.ts";

export * from "./settings-input.ts";

export const treeSettingsDefinition = definePrevalidatedExtensionSettings(
    extensionSettingsInput,
    prevalidatedSettings,
);

export default treeSettingsDefinition;

type SettingsReadContext = {
    cwd: string;
    projectTrusted: boolean;
};

let settingsReadContext: SettingsReadContext | undefined;
let cachedSettings: LoadedPiExtensionSettings<typeof extensionSettingsInput.schema> | undefined;
let cachedMode: TreeTimestampMode | null = null;
let cachedPreviewEnabled: boolean | null = null;
let cachedMaxVisibleLines: number | null | undefined;
let cachedPreviewFullHeight: boolean | undefined;

export type TreeSettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

function isProjectTrusted(ctx: TreeSettingsContext): boolean {
    return ctx.isProjectTrusted();
}

function clearReadCaches(): void {
    cachedSettings = undefined;
    cachedMode = null;
    cachedPreviewEnabled = null;
    cachedMaxVisibleLines = undefined;
    cachedPreviewFullHeight = undefined;
}

export function setSettingsContext(ctx: TreeSettingsContext): void {
    settingsReadContext = {
        cwd: ctx.cwd,
        projectTrusted: isProjectTrusted(ctx),
    };
    clearReadCaches();
}

export function isTreeTimestampMode(value: unknown): value is TreeTimestampMode {
    return Value.Check(TreeTimestampModeSchema, value);
}

export function loadTreeSettings(): LoadedPiExtensionSettings<
    typeof extensionSettingsInput.schema
> {
    const context = settingsReadContext ?? { cwd: process.cwd(), projectTrusted: false };

    cachedSettings ??= loadPiExtensionSettings(
        treeSettingsDefinition,
        {
            cwd: context.cwd,
            isProjectTrusted: () => context.projectTrusted,
        },
        {
            bundledSchema: {
                kind: "url",
                url: new URL("../config.schema.json", import.meta.url),
            },
        },
    );

    return cachedSettings;
}

function readMergedSettingsObject(): SettingsObject {
    const settings = loadTreeSettings().settings;
    return {
        [SETTINGS_KEY]: settings[SETTINGS_KEY],
        [PREVIEW_SETTINGS_KEY]: settings[PREVIEW_SETTINGS_KEY],
        [MAX_VISIBLE_LINES_SETTINGS_KEY]: settings[MAX_VISIBLE_LINES_SETTINGS_KEY],
        [PREVIEW_FULL_HEIGHT_SETTINGS_KEY]: settings[PREVIEW_FULL_HEIGHT_SETTINGS_KEY],
    };
}

async function updateSettingsObject(update: (settings: SettingsObject) => void): Promise<void> {
    const context = settingsReadContext ?? { cwd: process.cwd(), projectTrusted: false };
    loadTreeSettings();

    const result = await updatePiExtensionSettings(
        treeSettingsDefinition,
        { cwd: context.cwd, isProjectTrusted: () => context.projectTrusted },
        {
            scope: "global",
            update: (settings) => {
                update(settings);
                return settings;
            },
        },
    );
    switch (result.status) {
        case "updated":
        case "unchanged":
            return;
        case "blocked":
        case "conflict":
        case "failed":
        case "invalid-existing":
        case "invalid-update":
            throw new Error(result.message);
    }
}

export function getPersistedMode(): TreeTimestampMode {
    if (cachedMode !== null) return cachedMode;

    const settings = readMergedSettingsObject();
    cachedMode = settings[SETTINGS_KEY] ?? DEFAULT_MODE;
    return cachedMode;
}

export function getPersistedPreviewEnabled(): boolean {
    if (cachedPreviewEnabled !== null) return cachedPreviewEnabled;

    const settings = readMergedSettingsObject();
    cachedPreviewEnabled = settings[PREVIEW_SETTINGS_KEY] ?? false;
    return cachedPreviewEnabled;
}

export function getPersistedMaxVisibleLines(): number | null {
    if (cachedMaxVisibleLines !== undefined) return cachedMaxVisibleLines;

    const settings = readMergedSettingsObject();
    const configured = settings[MAX_VISIBLE_LINES_SETTINGS_KEY];
    cachedMaxVisibleLines = null;
    if (configured !== undefined && Number.isFinite(configured)) {
        cachedMaxVisibleLines = Math.max(MIN_VISIBLE_LINES, Math.floor(configured));
    }

    return cachedMaxVisibleLines;
}

export function getPersistedPreviewFullHeight(): boolean {
    if (cachedPreviewFullHeight !== undefined) return cachedPreviewFullHeight;

    const settings = readMergedSettingsObject();
    cachedPreviewFullHeight = settings[PREVIEW_FULL_HEIGHT_SETTINGS_KEY] ?? true;
    return cachedPreviewFullHeight;
}

const pendingSettingsWrites = new Set<Promise<void>>();

function trackSettingsWrite(write: Promise<void>): void {
    pendingSettingsWrites.add(write);
    void write.then(
        () => pendingSettingsWrites.delete(write),
        () => pendingSettingsWrites.delete(write),
    );
}

export async function flushSettingsWrites(): Promise<void> {
    await Promise.allSettled(pendingSettingsWrites);
}

function warnSettingsWriteFailed(cause: unknown): void {
    let suffix = "";
    if (cause instanceof Error && cause.message.length > 0) {
        suffix = `: ${cause.message}`;
    }

    console.warn(`[pi-tree] settings update was not saved${suffix}`);
}

export function persistPreviewEnabled(enabled: boolean): void {
    const write = updateSettingsObject((settings) => {
        settings[PREVIEW_SETTINGS_KEY] = enabled;
    })
        .then(() => {
            cachedPreviewEnabled = enabled;
        })
        .catch(warnSettingsWriteFailed);
    trackSettingsWrite(write);
}

export function persistMode(mode: TreeTimestampMode): void {
    const write = updateSettingsObject((settings) => {
        settings[SETTINGS_KEY] = mode;
    })
        .then(() => {
            cachedMode = mode;
        })
        .catch(warnSettingsWriteFailed);
    trackSettingsWrite(write);
}
