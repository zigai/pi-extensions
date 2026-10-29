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
    orderedModeNames,
    modeSpec,
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
        thinkingLevel: Type.Optional(Type.Union([modeThinkingLevelSchema, Type.Null()])),
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
        deletedModes: Type.Optional(Type.Array(Type.String())),
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
    const thinkingLevel = normalizeThinkingLevel(spec.thinkingLevel ?? undefined);
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
) => Pick<
    LoadedModelModesSettings,
    "globalConfigPath" | "projectConfigPath" | "settings" | "diagnostics" | "projectSettingsLayer"
>;

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
        hasConfiguredModes: orderedModeNames(modes).length > 0,
        modes,
    };
    const defaultModel = sanitizeDefaultModelSpec(parsed.defaultModel);
    if (defaultModel !== undefined) file.defaultModel = defaultModel;
    ensureDefaultModeEntries(file, fallbackMode);

    return file;
}

function modesFromSettings(
    loaded: ReturnType<LoadModelModesSettings>,
    fallbackMode: ModeSpec,
): ModesFile {
    const merged = modesFileJsonDecoder.parse(loaded.settings);
    let project: ModesFileJson | undefined;
    if (loaded.projectSettingsLayer !== undefined) {
        project = modesFileJsonDecoder.parse(loaded.projectSettingsLayer);
    }

    for (const name of project?.deletedModes ?? []) delete merged.modes?.[name];
    const file = modesFromConfig(merged, fallbackMode);

    // Project declarations define the local cycle priority; inherited specs still come from
    // the shared loader's recursive merge, including partial per-mode overrides.
    if (project !== undefined && file.hasConfiguredModes !== false) {
        const names = new Set([...Object.keys(project.modes ?? {}), ...Object.keys(file.modes)]);
        const reordered: Record<string, ModeSpec> = {};
        for (const name of names) {
            const spec = modeSpec(file.modes, name);
            if (spec !== undefined) reordered[name] = spec;
        }

        file.modes = reordered;
    }

    return file;
}

type ResolvedModesContext = {
    readonly context: ModesStoreContext;
    readonly globalConfigPath: string;
    readonly projectConfigPath: string | undefined;
};

export class ModesStore {
    private readonly contexts = new Map<string, ResolvedModesContext>();

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

        this.contexts.set(path, {
            context,
            globalConfigPath: loaded.globalConfigPath,
            projectConfigPath: loaded.projectConfigPath,
        });

        return path;
    }

    /** Cache token for all settings sources, including a trusted project file not created yet. */
    async getRevision(filePath: string): Promise<string> {
        const resolved = this.contexts.get(filePath);
        const paths = [filePath];
        if (resolved !== undefined) {
            paths.splice(0, 1, resolved.globalConfigPath);

            if (resolved.context.projectTrusted && resolved.projectConfigPath !== undefined) {
                paths.push(resolved.projectConfigPath);
            }
        }

        const revisions = await Promise.all(
            paths.map(async (sourcePath) => {
                try {
                    const stat = await fs.stat(sourcePath);
                    return [sourcePath, stat.mtimeMs, stat.ctimeMs, stat.size];
                } catch {
                    return [sourcePath, null];
                }
            }),
        );

        return JSON.stringify(revisions);
    }

    async load(
        filePath: string,
        fallbackMode: ModeSpec,
        options?: { readonly throwOnInvalid?: boolean },
    ): Promise<ModesFile> {
        try {
            const resolved = this.contexts.get(filePath);
            if (resolved !== undefined) {
                const loaded = this.loadSettings(resolved.context);
                if (options?.throwOnInvalid === true) {
                    const invalid = loaded.diagnostics.filter(
                        (diagnostic) =>
                            diagnostic.scope === "global" || diagnostic.scope === "project",
                    );
                    if (invalid.length > 0) {
                        throw new Error(invalid.map((diagnostic) => diagnostic.message).join("; "));
                    }
                }

                return modesFromSettings(loaded, fallbackMode);
            }

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
        const resolved = this.contexts.get(filePath);
        if (resolved === undefined)
            throw new Error("Mode settings path was not resolved for this session.");

        const { context } = resolved;
        this.loadSettings(context);

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
                    let latest = modesFromConfig(modesFileJsonDecoder.parse(config), fallbackMode);
                    if (scope === "project") {
                        latest = modesFromSettings(this.loadSettings(context), fallbackMode);
                    }

                    if (patch === null && latest.defaultModel === undefined) return config;
                    if (patch !== null) applyModesPatch(latest, patch);
                    delete latest.defaultModel;
                    ensureDefaultModeEntries(latest, fallbackMode);
                    config.version = latest.version;
                    config.currentMode = latest.currentMode;
                    delete config.defaultModel;

                    if (scope === "project" && patch !== null) {
                        const localConfig = modesFileJsonDecoder.parse(config);
                        const local = localConfig.modes ?? {};

                        // Apply only changed fields to the project layer, never copying inherited specs.
                        for (const [name, change] of Object.entries(patch.modes ?? {})) {
                            if (change === null) {
                                delete local[name];
                                continue;
                            }

                            const spec = local[name] ?? {};
                            local[name] = spec;

                            if (change.provider === null) delete spec.provider;
                            else if (change.provider !== undefined) spec.provider = change.provider;

                            if (change.modelId === null) delete spec.modelId;
                            else if (change.modelId !== undefined) spec.modelId = change.modelId;

                            if (change.color === null) delete spec.color;
                            else if (change.color !== undefined) spec.color = change.color;

                            if (change.thinkingLevel !== undefined)
                                spec.thinkingLevel = change.thinkingLevel;
                        }

                        const deleted = new Set(config.deletedModes ?? []);
                        for (const [name, change] of Object.entries(patch.modes ?? {})) {
                            if (change === null) deleted.add(name);
                            else deleted.delete(name);
                        }

                        if (deleted.size > 0) config.deletedModes = [...deleted];
                        else delete config.deletedModes;

                        if (patch.modeOrder !== undefined) {
                            const reordered: Record<string, ModeSpecJson> = {};
                            if (latest.hasConfiguredModes !== false) {
                                for (const name of Object.keys(latest.modes)) {
                                    reordered[name] = local[name] ?? {};
                                }
                            }

                            config.modes = reordered;
                        } else {
                            config.modes = local;
                        }
                    } else if (scope === "global") {
                        // Fallback modes are runtime-only, including after deleting the final mode.
                        config.modes = latest.modes;
                        if (latest.hasConfiguredModes === false) config.modes = {};
                    }

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

        if (saved === undefined) return null;

        return {
            data: await this.load(filePath, fallbackMode),
            mtimeMs: await getMtimeMs(filePath),
        };
    }
}
