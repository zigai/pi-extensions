import { readFileSync } from "node:fs";

import { Result } from "better-result";
import type { StaticDecode, TObject, TSchema } from "typebox";
import { Value } from "typebox/value";

import type { ExtensionSettingsDefinition } from "./definition.ts";
import { readTextIfPresent, writeTextAtomically, writeTextIfMissing } from "./file-system.ts";
import { formatJson, type JsonObject } from "./json-value.ts";
import { resolveGlobalSettingsPaths, resolveProjectSettingsPaths } from "./paths.ts";
import {
    createDefaultSettingsDocument,
    createSettingsFileSchema,
    createSettingsLayerSchema,
} from "./schema-document.ts";
import {
    applySettingsLayer,
    parseSettingsLayer,
    type ParsedSettingsLayer,
    type SettingsDiagnostic,
    type SettingsDiagnosticCode,
    type SettingsScope,
} from "./settings-layer.ts";

export type BundledSchemaSource =
    | { readonly kind: "content"; readonly content: string }
    | { readonly kind: "url"; readonly url: URL };

export type ProjectSettingsLocation = {
    readonly cwd: string;
    readonly configDirName: string;
    readonly trusted: boolean;
};

export type LoadSettingsOptions = {
    readonly agentDir: string;
    readonly bundledSchema: BundledSchemaSource;
    readonly project?: ProjectSettingsLocation;
};

export type LoadedSettings<Schema extends TObject> = {
    readonly settings: StaticDecode<Schema>;
    readonly globalSettingsLayer: JsonObject | undefined;
    readonly projectSettingsLayer: JsonObject | undefined;
    readonly diagnostics: readonly SettingsDiagnostic[];
    readonly globalConfigPath: string;
    readonly projectConfigPath: string | undefined;
    readonly usedGlobalConfig: boolean;
    readonly usedProjectConfig: boolean;
    readonly scaffoldedGlobalConfig: boolean;
    readonly schemaStatus: "created" | "unavailable" | "unchanged" | "updated";
};

export type { SettingsDiagnostic, SettingsDiagnosticCode };

function bundledSchemaContent(source: BundledSchemaSource): string | undefined {
    if (source.kind === "content") return source.content;

    try {
        return readFileSync(source.url, "utf8");
    } catch {
        return undefined;
    }
}

function readLayer(path: string, scope: SettingsScope, layerSchema: TSchema): ParsedSettingsLayer {
    const content = readTextIfPresent(path);
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
    return parseSettingsLayer(path, scope, content.value, layerSchema);
}

export function loadSettings<const Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
    options: LoadSettingsOptions,
): LoadedSettings<Schema> {
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

    const expectedSchema = formatJson(createSettingsFileSchema(definition));
    const sourceSchema = bundledSchemaContent(options.bundledSchema);

    let schemaStatus: LoadedSettings<Schema>["schemaStatus"] = "unavailable";
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
        const schemaWrite = writeTextAtomically(globalPaths.schemaPath, sourceSchema);
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
            const configWrite = writeTextIfMissing(
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
    const globalLayer = readLayer(globalPaths.configPath, "global", layerSchema);
    diagnostics.push(...globalLayer.diagnostics);
    const globalApplied = applySettingsLayer(
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
        const projectLayer = readLayer(projectPaths.configPath, "project", layerSchema);
        diagnostics.push(...projectLayer.diagnostics);
        const projectApplied = applySettingsLayer(
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
        settings: Value.Decode(Value.Clone(definition.schema), resolved),
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
