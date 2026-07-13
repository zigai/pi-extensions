import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { Result } from "better-result";
import type { StaticDecode, TObject, TSchema } from "typebox";
import { Value } from "typebox/value";

import type { ExtensionSettingsDefinition } from "./definition.ts";
import {
    readTextIfPresentSync,
    writeTextAtomicallySync,
    writeTextIfMissingSync,
} from "./file-system-sync.ts";
import { readTextIfPresent, writeTextAtomically, writeTextIfMissing } from "./file-system.ts";
import { formatJson, isJsonObject, parseJson, type JsonObject } from "./json-value.ts";
import { resolveGlobalSettingsPaths, resolveProjectSettingsPaths } from "./paths.ts";
import {
    createDefaultSettingsDocument,
    createSettingsFileSchema,
    createSettingsLayerSchema,
} from "./schema-document.ts";
import { mergeSettings, settingsLayerFromFile } from "./settings-merge.ts";

export type BundledSchemaSource =
    | { readonly kind: "content"; readonly content: string }
    | { readonly kind: "url"; readonly url: URL };

export type ProjectSettingsLocation = {
    readonly cwd: string;
    readonly configDirName: string;
    readonly trusted: boolean;
};

export type LoadExtensionSettingsOptions = {
    readonly agentDir: string;
    readonly bundledSchema: BundledSchemaSource;
    readonly project?: ProjectSettingsLocation;
    /** Older config locations copied once when the centralized target is absent. */
    readonly legacyConfigPaths?: {
        readonly global?: readonly string[];
        readonly project?: readonly string[];
    };
};

export type SettingsDiagnosticCode =
    | "bundled-schema-read-failed"
    | "bundled-schema-stale"
    | "config-decode-failed"
    | "config-invalid"
    | "config-malformed"
    | "config-migration-failed"
    | "config-read-failed"
    | "config-scaffold-failed"
    | "schema-install-failed";

export type SettingsDiagnostic = {
    readonly code: SettingsDiagnosticCode;
    readonly severity: "error" | "warning";
    readonly scope: "global" | "project" | "schema";
    readonly path: string;
    readonly message: string;
    readonly issues?: readonly {
        readonly path: string;
        readonly message: string;
    }[];
};

export type LoadedExtensionSettings<Schema extends TObject> = {
    readonly settings: StaticDecode<Schema>;
    /** Validated user global layer before defaults or project overrides. */
    readonly globalSettingsLayer: JsonObject | undefined;
    /** Validated trusted-project layer before merging. */
    readonly projectSettingsLayer: JsonObject | undefined;
    readonly diagnostics: readonly SettingsDiagnostic[];
    readonly globalConfigPath: string;
    readonly projectConfigPath: string | undefined;
    readonly usedGlobalConfig: boolean;
    readonly usedProjectConfig: boolean;
    readonly scaffoldedGlobalConfig: boolean;
    readonly schemaStatus: "created" | "unavailable" | "unchanged" | "updated";
};

type ParsedLayer = {
    readonly settings: JsonObject | undefined;
    readonly diagnostics: readonly SettingsDiagnostic[];
};

async function bundledSchemaContent(source: BundledSchemaSource): Promise<string | undefined> {
    if (source.kind === "content") return source.content;

    try {
        return await readFile(source.url, "utf8");
    } catch {
        return undefined;
    }
}

function bundledSchemaContentSync(source: BundledSchemaSource): string | undefined {
    if (source.kind === "content") return source.content;

    try {
        return readFileSync(source.url, "utf8");
    } catch {
        return undefined;
    }
}

function validationIssues(
    schema: TSchema,
    value: unknown,
): readonly {
    readonly path: string;
    readonly message: string;
}[] {
    return [...Value.Errors(schema, value)].map((issue) => ({
        path: issue.instancePath === "" ? "/" : issue.instancePath,
        message: issue.message,
    }));
}

function parseLayer(
    path: string,
    scope: "global" | "project",
    text: string,
    layerSchema: TSchema,
): ParsedLayer {
    const parsed = parseJson(text);
    if (parsed === undefined) {
        return {
            settings: undefined,
            diagnostics: [
                {
                    code: "config-malformed",
                    severity: "error",
                    scope,
                    path,
                    message: `${scope} settings contain malformed JSON and were ignored`,
                },
            ],
        };
    }

    if (!Value.Check(layerSchema, parsed)) {
        return {
            settings: undefined,
            diagnostics: [
                {
                    code: "config-invalid",
                    severity: "error",
                    scope,
                    path,
                    message: `${scope} settings do not match the extension schema and were ignored`,
                    issues: validationIssues(layerSchema, parsed),
                },
            ],
        };
    }

    try {
        const decoded: unknown = Value.Decode(layerSchema, parsed);
        if (!isJsonObject(decoded)) {
            return {
                settings: undefined,
                diagnostics: [
                    {
                        code: "config-decode-failed",
                        severity: "error",
                        scope,
                        path,
                        message: `${scope} settings did not decode to a JSON object and were ignored`,
                    },
                ],
            };
        }
        return { settings: settingsLayerFromFile(decoded), diagnostics: [] };
    } catch {
        return {
            settings: undefined,
            diagnostics: [
                {
                    code: "config-decode-failed",
                    severity: "error",
                    scope,
                    path,
                    message: `${scope} settings could not be decoded and were ignored`,
                },
            ],
        };
    }
}

async function readLayer(
    path: string,
    scope: "global" | "project",
    layerSchema: TSchema,
): Promise<ParsedLayer> {
    const content = await readTextIfPresent(path);
    if (Result.isError(content)) {
        return {
            settings: undefined,
            diagnostics: [
                {
                    code: "config-read-failed",
                    severity: "error",
                    scope,
                    path,
                    message: `${scope} settings could not be read and were ignored`,
                },
            ],
        };
    }
    if (content.value === undefined) return { settings: undefined, diagnostics: [] };
    return parseLayer(path, scope, content.value, layerSchema);
}

function readLayerSync(
    path: string,
    scope: "global" | "project",
    layerSchema: TSchema,
): ParsedLayer {
    const content = readTextIfPresentSync(path);
    if (Result.isError(content)) {
        return {
            settings: undefined,
            diagnostics: [
                {
                    code: "config-read-failed",
                    severity: "error",
                    scope,
                    path,
                    message: `${scope} settings could not be read and were ignored`,
                },
            ],
        };
    }
    if (content.value === undefined) return { settings: undefined, diagnostics: [] };
    return parseLayer(path, scope, content.value, layerSchema);
}

function migrationDiagnostic(scope: "global" | "project", path: string): SettingsDiagnostic {
    return {
        code: "config-migration-failed",
        severity: "error",
        scope,
        path,
        message: `Legacy ${scope} settings could not be migrated`,
    };
}

async function migrateLegacyConfig(
    targetPath: string,
    candidatePaths: readonly string[],
    scope: "global" | "project",
): Promise<SettingsDiagnostic | undefined> {
    const target = await readTextIfPresent(targetPath);
    if (Result.isError(target)) return migrationDiagnostic(scope, targetPath);
    if (target.value !== undefined) return undefined;

    for (const candidatePath of candidatePaths) {
        const candidate = await readTextIfPresent(candidatePath);
        if (Result.isError(candidate)) return migrationDiagnostic(scope, candidatePath);
        if (candidate.value === undefined) continue;

        const copied = await writeTextIfMissing(targetPath, candidate.value);
        /* v8 ignore next -- requires the target to become unwritable after its successful read */
        if (Result.isError(copied)) return migrationDiagnostic(scope, targetPath);
        return undefined;
    }
    return undefined;
}

function migrateLegacyConfigSync(
    targetPath: string,
    candidatePaths: readonly string[],
    scope: "global" | "project",
): SettingsDiagnostic | undefined {
    const target = readTextIfPresentSync(targetPath);
    if (Result.isError(target)) return migrationDiagnostic(scope, targetPath);
    if (target.value !== undefined) return undefined;

    for (const candidatePath of candidatePaths) {
        const candidate = readTextIfPresentSync(candidatePath);
        if (Result.isError(candidate)) return migrationDiagnostic(scope, candidatePath);
        if (candidate.value === undefined) continue;

        const copied = writeTextIfMissingSync(targetPath, candidate.value);
        /* v8 ignore next -- requires the target to become unwritable after its successful read */
        if (Result.isError(copied)) return migrationDiagnostic(scope, targetPath);
        return undefined;
    }
    return undefined;
}

function applyLayer<Schema extends TObject>(
    schema: Schema,
    current: JsonObject,
    layer: ParsedLayer,
    path: string,
    scope: "global" | "project",
): { readonly settings: JsonObject; readonly diagnostic?: SettingsDiagnostic } {
    if (layer.settings === undefined) return { settings: current };

    const merged = mergeSettings(current, layer.settings);
    if (Value.Check(schema, merged)) return { settings: merged };

    return {
        settings: current,
        diagnostic: {
            code: "config-invalid",
            severity: "error",
            scope,
            path,
            message: `${scope} settings conflict with the resolved configuration and were ignored`,
            issues: validationIssues(schema, merged),
        },
    };
}

/**
 * Load global and trusted project settings without ever replacing a user-owned file.
 * Invalid layers are reported and ignored; the returned settings always satisfy the
 * resolved TypeBox schema established by `defineExtensionSettings`.
 */
export async function loadExtensionSettings<const Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
    options: LoadExtensionSettingsOptions,
): Promise<LoadedExtensionSettings<Schema>> {
    const diagnostics: SettingsDiagnostic[] = [];
    const globalPaths = resolveGlobalSettingsPaths(options.agentDir, definition.id);
    const projectPaths =
        options.project === undefined
            ? undefined
            : resolveProjectSettingsPaths(
                  options.project.cwd,
                  options.project.configDirName,
                  definition.id,
              );
    const globalMigration = await migrateLegacyConfig(
        globalPaths.configPath,
        options.legacyConfigPaths?.global ?? [],
        "global",
    );
    if (globalMigration !== undefined) diagnostics.push(globalMigration);
    if (projectPaths !== undefined && options.project?.trusted === true) {
        const projectMigration = await migrateLegacyConfig(
            projectPaths.configPath,
            options.legacyConfigPaths?.project ?? [],
            "project",
        );
        if (projectMigration !== undefined) diagnostics.push(projectMigration);
    }

    const expectedSchema = formatJson(createSettingsFileSchema(definition));
    const sourceSchema = await bundledSchemaContent(options.bundledSchema);

    let schemaStatus: LoadedExtensionSettings<Schema>["schemaStatus"] = "unavailable";
    let scaffoldedGlobalConfig = false;
    if (sourceSchema === undefined) {
        diagnostics.push({
            code: "bundled-schema-read-failed",
            severity: "error",
            scope: "schema",
            path: globalPaths.schemaPath,
            message: "The bundled settings schema could not be read",
        });
    } else if (sourceSchema !== expectedSchema) {
        diagnostics.push({
            code: "bundled-schema-stale",
            severity: "error",
            scope: "schema",
            path: globalPaths.schemaPath,
            message: "The bundled settings schema is stale; run the artifact generator",
        });
    } else {
        const schemaWrite = await writeTextAtomically(globalPaths.schemaPath, sourceSchema);
        if (Result.isError(schemaWrite)) {
            diagnostics.push({
                code: "schema-install-failed",
                severity: "error",
                scope: "schema",
                path: globalPaths.schemaPath,
                message: "The local editor schema could not be installed",
            });
        } else {
            schemaStatus = schemaWrite.value;
            const configWrite = await writeTextIfMissing(
                globalPaths.configPath,
                formatJson(createDefaultSettingsDocument(definition)),
            );
            if (Result.isError(configWrite)) {
                diagnostics.push({
                    code: "config-scaffold-failed",
                    severity: "error",
                    scope: "global",
                    path: globalPaths.configPath,
                    message: "The default global settings file could not be scaffolded",
                });
            } else {
                scaffoldedGlobalConfig = configWrite.value === "created";
            }
        }
    }

    const layerSchema = createSettingsLayerSchema(definition);
    const globalLayer = await readLayer(globalPaths.configPath, "global", layerSchema);
    diagnostics.push(...globalLayer.diagnostics);
    const globalApplied = applyLayer(
        definition.schema,
        definition.defaultSettings,
        globalLayer,
        globalPaths.configPath,
        "global",
    );
    if (globalApplied.diagnostic !== undefined) diagnostics.push(globalApplied.diagnostic);

    let resolved = globalApplied.settings;
    let projectSettingsLayer: JsonObject | undefined;
    let usedProjectConfig = false;
    if (projectPaths !== undefined && options.project?.trusted === true) {
        const projectLayer = await readLayer(projectPaths.configPath, "project", layerSchema);
        diagnostics.push(...projectLayer.diagnostics);
        const projectApplied = applyLayer(
            definition.schema,
            resolved,
            projectLayer,
            projectPaths.configPath,
            "project",
        );
        if (projectApplied.diagnostic !== undefined) diagnostics.push(projectApplied.diagnostic);
        if (projectLayer.settings !== undefined && projectApplied.diagnostic === undefined) {
            resolved = projectApplied.settings;
            projectSettingsLayer = projectLayer.settings;
            usedProjectConfig = true;
        }
    }

    return {
        settings: Value.Decode(definition.schema, resolved),
        globalSettingsLayer:
            globalApplied.diagnostic === undefined ? globalLayer.settings : undefined,
        projectSettingsLayer,
        diagnostics,
        globalConfigPath: globalPaths.configPath,
        projectConfigPath: projectPaths?.configPath,
        usedGlobalConfig:
            globalLayer.settings !== undefined && globalApplied.diagnostic === undefined,
        usedProjectConfig,
        scaffoldedGlobalConfig,
        schemaStatus,
    };
}

/** Synchronous counterpart to `loadExtensionSettings` for render and patch paths. */
export function loadExtensionSettingsSync<const Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
    options: LoadExtensionSettingsOptions,
): LoadedExtensionSettings<Schema> {
    const diagnostics: SettingsDiagnostic[] = [];
    const globalPaths = resolveGlobalSettingsPaths(options.agentDir, definition.id);
    const projectPaths =
        options.project === undefined
            ? undefined
            : resolveProjectSettingsPaths(
                  options.project.cwd,
                  options.project.configDirName,
                  definition.id,
              );
    const globalMigration = migrateLegacyConfigSync(
        globalPaths.configPath,
        options.legacyConfigPaths?.global ?? [],
        "global",
    );
    if (globalMigration !== undefined) diagnostics.push(globalMigration);
    if (projectPaths !== undefined && options.project?.trusted === true) {
        const projectMigration = migrateLegacyConfigSync(
            projectPaths.configPath,
            options.legacyConfigPaths?.project ?? [],
            "project",
        );
        if (projectMigration !== undefined) diagnostics.push(projectMigration);
    }

    const expectedSchema = formatJson(createSettingsFileSchema(definition));
    const sourceSchema = bundledSchemaContentSync(options.bundledSchema);

    let schemaStatus: LoadedExtensionSettings<Schema>["schemaStatus"] = "unavailable";
    let scaffoldedGlobalConfig = false;
    if (sourceSchema === undefined) {
        diagnostics.push({
            code: "bundled-schema-read-failed",
            severity: "error",
            scope: "schema",
            path: globalPaths.schemaPath,
            message: "The bundled settings schema could not be read",
        });
    } else if (sourceSchema !== expectedSchema) {
        diagnostics.push({
            code: "bundled-schema-stale",
            severity: "error",
            scope: "schema",
            path: globalPaths.schemaPath,
            message: "The bundled settings schema is stale; run the artifact generator",
        });
    } else {
        const schemaWrite = writeTextAtomicallySync(globalPaths.schemaPath, sourceSchema);
        if (Result.isError(schemaWrite)) {
            diagnostics.push({
                code: "schema-install-failed",
                severity: "error",
                scope: "schema",
                path: globalPaths.schemaPath,
                message: "The local editor schema could not be installed",
            });
        } else {
            schemaStatus = schemaWrite.value;
            const configWrite = writeTextIfMissingSync(
                globalPaths.configPath,
                formatJson(createDefaultSettingsDocument(definition)),
            );
            if (Result.isError(configWrite)) {
                diagnostics.push({
                    code: "config-scaffold-failed",
                    severity: "error",
                    scope: "global",
                    path: globalPaths.configPath,
                    message: "The default global settings file could not be scaffolded",
                });
            } else {
                scaffoldedGlobalConfig = configWrite.value === "created";
            }
        }
    }

    const layerSchema = createSettingsLayerSchema(definition);
    const globalLayer = readLayerSync(globalPaths.configPath, "global", layerSchema);
    diagnostics.push(...globalLayer.diagnostics);
    const globalApplied = applyLayer(
        definition.schema,
        definition.defaultSettings,
        globalLayer,
        globalPaths.configPath,
        "global",
    );
    if (globalApplied.diagnostic !== undefined) diagnostics.push(globalApplied.diagnostic);

    let resolved = globalApplied.settings;
    let projectSettingsLayer: JsonObject | undefined;
    let usedProjectConfig = false;
    if (projectPaths !== undefined && options.project?.trusted === true) {
        const projectLayer = readLayerSync(projectPaths.configPath, "project", layerSchema);
        diagnostics.push(...projectLayer.diagnostics);
        const projectApplied = applyLayer(
            definition.schema,
            resolved,
            projectLayer,
            projectPaths.configPath,
            "project",
        );
        if (projectApplied.diagnostic !== undefined) diagnostics.push(projectApplied.diagnostic);
        if (projectLayer.settings !== undefined && projectApplied.diagnostic === undefined) {
            resolved = projectApplied.settings;
            projectSettingsLayer = projectLayer.settings;
            usedProjectConfig = true;
        }
    }

    return {
        settings: Value.Decode(definition.schema, resolved),
        globalSettingsLayer:
            globalApplied.diagnostic === undefined ? globalLayer.settings : undefined,
        projectSettingsLayer,
        diagnostics,
        globalConfigPath: globalPaths.configPath,
        projectConfigPath: projectPaths?.configPath,
        usedGlobalConfig:
            globalLayer.settings !== undefined && globalApplied.diagnostic === undefined,
        usedProjectConfig,
        scaffoldedGlobalConfig,
        schemaStatus,
    };
}
