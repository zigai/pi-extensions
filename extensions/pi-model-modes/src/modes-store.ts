import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
    getPiGlobalSettingsPath,
    getPiProjectSettingsPath,
    updatePiExtensionSettings,
} from "@zigai/pi-extension-settings/pi";
import fs from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { normalizeThinkingLevel } from "./thinking-levels.ts";
import {
    applyModesPatch,
    computeModesPatch,
    createDefaultModes,
    ensureDefaultModeEntries,
    parseModeColor,
    type DefaultModelSpec,
    type ModesFile,
    type ModeSpec,
} from "./modes.ts";
import {
    defaultThinkingLevelSchema,
    loadModelModesSettings,
    modelModesSettingsDefinition,
    modeThinkingLevelSchema,
    type LoadedModelModesSettings,
} from "./settings.ts";

const ModeSpecJsonSchema = Type.Object(
    {
        provider: Type.Optional(Type.String()),
        modelId: Type.Optional(Type.String()),
        thinkingLevel: Type.Optional(modeThinkingLevelSchema),
        color: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);

const DefaultModelJsonSchema = Type.Object(
    {
        provider: Type.String({ minLength: 1 }),
        modelId: Type.String({ minLength: 1 }),
        thinkingLevel: Type.Optional(defaultThinkingLevelSchema),
    },
    { additionalProperties: false },
);

const ModesFileJsonSchema = Type.Object(
    {
        $schema: Type.Optional(Type.String()),
        version: Type.Optional(Type.Number()),
        currentMode: Type.Optional(Type.String()),
        defaultModel: Type.Optional(DefaultModelJsonSchema),
        modeUseThinkingBorderColors: Type.Optional(Type.Boolean()),
        modeShowThinkingLevelStatus: Type.Optional(Type.Boolean()),
        shortcuts: Type.Optional(
            Type.Object(
                {
                    forward: Type.Optional(Type.String({ minLength: 1 })),
                    backward: Type.Optional(Type.String({ minLength: 1 })),
                },
                { additionalProperties: false },
            ),
        ),
        modes: Type.Optional(Type.Record(Type.String(), ModeSpecJsonSchema)),
    },
    { additionalProperties: false },
);

type ModeSpecJson = Static<typeof ModeSpecJsonSchema>;
type DefaultModelJson = Static<typeof DefaultModelJsonSchema>;
type ModesFileJson = Static<typeof ModesFileJsonSchema>;

type NodeErrorWithCode = Error & {
    readonly code: string;
};

function formatSchemaPath(instancePath: string): string {
    if (instancePath.length === 0) return "root";
    return instancePath
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
        .join(".");
}

const modesFileJsonDecoder = {
    parse(value: unknown, label = "pi-model-modes config.json"): ModesFileJson {
        const errors = [...Value.Errors(ModesFileJsonSchema, value)];
        if (errors.length > 0) {
            const messages = errors
                .slice(0, 5)
                .map((error) => `${formatSchemaPath(error.instancePath)} ${error.message}`);
            let suffix = "";
            if (errors.length > messages.length) {
                suffix = `; and ${errors.length - messages.length} more`;
            }

            throw new Error(`${label} is invalid: ${messages.join("; ")}${suffix}`);
        }

        return Value.Parse(ModesFileJsonSchema, value);
    },
};

function isNodeErrorWithCode(cause: unknown): cause is NodeErrorWithCode {
    return cause instanceof Error && "code" in cause && typeof cause.code === "string";
}

function getErrorCode(cause: unknown): string | undefined {
    if (isNodeErrorWithCode(cause)) return cause.code;
    return undefined;
}

function errorMessage(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}

function throwLoadError(filePath: string, cause: unknown): never {
    throw new Error(`Failed to load ${filePath}: ${errorMessage(cause)}`);
}

function sanitizeModeSpec(spec: ModeSpecJson | undefined): ModeSpec {
    if (spec === undefined) return {};

    const sanitized: ModeSpec = {};
    const thinkingLevel = normalizeThinkingLevel(spec.thinkingLevel);
    if (thinkingLevel !== undefined) sanitized.thinkingLevel = thinkingLevel;
    if (spec.provider !== undefined) sanitized.provider = spec.provider;
    if (spec.modelId !== undefined) sanitized.modelId = spec.modelId;
    if (spec.color !== undefined) sanitized.color = parseModeColor(spec.color);

    return sanitized;
}

function sanitizeDefaultModelSpec(
    spec: DefaultModelJson | undefined,
): DefaultModelSpec | undefined {
    if (spec === undefined) return undefined;

    const sanitized: DefaultModelSpec = {
        provider: spec.provider,
        modelId: spec.modelId,
    };
    const thinkingLevel = normalizeThinkingLevel(spec.thinkingLevel);
    if (thinkingLevel !== undefined) sanitized.thinkingLevel = thinkingLevel;

    return sanitized;
}

export function getGlobalAgentDir(): string {
    return getAgentDir();
}

const EXTENSION_ID = "pi-model-modes";

export function getGlobalModesPath(): string {
    return getPiGlobalSettingsPath(EXTENSION_ID);
}

export function getProjectModesPath(cwd: string): string {
    return getPiProjectSettingsPath(EXTENSION_ID, cwd);
}

export async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.stat(filePath);
        return true;
    } catch {
        return false;
    }
}

export async function prepareModesConfig(cwd: string, projectTrusted: boolean): Promise<void> {
    loadModelModesSettings({ cwd, projectTrusted });
}

export async function scaffoldGlobalModesConfig(): Promise<void> {
    await prepareModesConfig(process.cwd(), false);
}

export async function getMtimeMs(filePath: string): Promise<number | null> {
    try {
        const stat = await fs.stat(filePath);
        return stat.mtimeMs;
    } catch {
        return null;
    }
}

export type ModesStoreContext = {
    readonly cwd: string;
    readonly projectTrusted: boolean;
};

type LoadModelModesSettings = (
    context: ModesStoreContext,
) => Pick<LoadedModelModesSettings, "globalConfigPath" | "projectConfigPath">;

export type SavedModes = {
    readonly data: ModesFile;
    readonly mtimeMs: number | null;
};

function modesFromConfig(parsed: ModesFileJson, fallbackMode: ModeSpec): ModesFile {
    const modes: Record<string, ModeSpec> = {};
    for (const [key, value] of Object.entries(parsed.modes ?? {})) {
        modes[key] = sanitizeModeSpec(value);
    }

    const file: ModesFile = {
        version: 1,
        currentMode: parsed.currentMode ?? "default",
        modes,
    };
    const defaultModel = sanitizeDefaultModelSpec(parsed.defaultModel);
    if (defaultModel !== undefined) file.defaultModel = defaultModel;
    ensureDefaultModeEntries(file, fallbackMode);

    return file;
}

export class ModesStore {
    private readonly contexts = new Map<string, ModesStoreContext>();

    constructor(private readonly loadSettings: LoadModelModesSettings = loadModelModesSettings) {}

    async resolvePath(context: ModesStoreContext): Promise<string> {
        const loaded = this.loadSettings(context);
        let path = loaded.globalConfigPath;
        if (
            context.projectTrusted &&
            loaded.projectConfigPath !== undefined &&
            (await fileExists(loaded.projectConfigPath))
        ) {
            path = loaded.projectConfigPath;
        }

        this.contexts.set(path, context);

        return path;
    }

    async load(
        filePath: string,
        fallbackMode: ModeSpec,
        options?: { readonly throwOnInvalid?: boolean },
    ): Promise<ModesFile> {
        try {
            const raw = await fs.readFile(filePath, "utf8");
            const parsedJson: unknown = JSON.parse(raw);
            return modesFromConfig(modesFileJsonDecoder.parse(parsedJson), fallbackMode);
        } catch (cause: unknown) {
            if (getErrorCode(cause) === "ENOENT") return createDefaultModes(fallbackMode);
            if (options?.throwOnInvalid === true) throwLoadError(filePath, cause);
            return createDefaultModes(fallbackMode);
        }
    }

    async saveChanges(
        filePath: string,
        baseline: ModesFile,
        next: ModesFile,
        fallbackMode: ModeSpec,
    ): Promise<SavedModes | null> {
        const patch = computeModesPatch(baseline, next, false);
        if (patch === null) return null;

        const context = this.contexts.get(filePath);
        if (context === undefined)
            throw new Error("Mode settings path was not resolved for this session.");

        loadModelModesSettings(context);

        const projectPath = getProjectModesPath(context.cwd);
        let scope: "global" | "project" = "global";
        if (context.projectTrusted && filePath === projectPath) scope = "project";

        let saved: ModesFile | undefined;
        const result = await updatePiExtensionSettings(
            modelModesSettingsDefinition,
            { cwd: context.cwd, isProjectTrusted: () => context.projectTrusted },
            {
                scope,
                update: (config) => {
                    const latest = modesFromConfig(
                        modesFileJsonDecoder.parse(config),
                        fallbackMode,
                    );
                    applyModesPatch(latest, patch);
                    ensureDefaultModeEntries(latest, fallbackMode);
                    config.version = latest.version;
                    config.currentMode = latest.currentMode;
                    if (latest.defaultModel === undefined) delete config.defaultModel;
                    else config.defaultModel = latest.defaultModel;
                    config.modes = latest.modes;
                    saved = latest;
                    return config;
                },
            },
        );
        switch (result.status) {
            case "updated":
            case "unchanged":
                break;
            case "blocked":
            case "conflict":
            case "failed":
            case "invalid-existing":
            case "invalid-update":
                throw new Error(result.message);
        }

        if (saved === undefined) throw new Error("Mode settings update produced no result.");
        return { data: saved, mtimeMs: await getMtimeMs(filePath) };
    }
}
