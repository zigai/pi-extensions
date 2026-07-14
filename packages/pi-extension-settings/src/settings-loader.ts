import { readFileSync } from "node:fs";

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

/**
 * Source for the generated `config.schema.json` shipped with an extension.
 *
 * The content must exactly match the schema derived from the settings definition. A mismatch is
 * reported as `bundled-schema-stale`, and neither the editor schema nor the initial global settings
 * file is installed.
 */
export type BundledSchemaSource =
    | {
          /** Use schema text already loaded by the extension. */
          readonly kind: "content";
          /** Complete generated JSON Schema, including its trailing newline. */
          readonly content: string;
      }
    | {
          /** Read the schema synchronously from a bundled file URL. */
          readonly kind: "url";
          /** A `file:` URL, usually `new URL("../config.schema.json", import.meta.url)`. */
          readonly url: URL;
      };

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

/**
 * Result of resolving defaults, global settings, and an optional trusted-project override.
 *
 * File and validation failures are represented in {@link SettingsDiagnostic}; a failed layer is
 * ignored and resolution continues from the last valid value.
 *
 * @template Schema The definition's TypeBox schema.
 */
export type LoadedSettings<Schema extends TObject> = {
    /** Fully resolved and TypeBox-decoded settings safe for extension code to consume. */
    readonly settings: StaticDecode<Schema>;
    /** Accepted global file contents after decoding and removal of editor-only metadata. */
    readonly globalSettingsLayer: JsonObject | undefined;
    /** Accepted trusted-project file contents after decoding and removal of editor metadata. */
    readonly projectSettingsLayer: JsonObject | undefined;
    /** Non-fatal problems encountered while installing, reading, validating, or decoding settings. */
    readonly diagnostics: readonly SettingsDiagnostic[];
    /** Absolute path of the extension's global settings file. */
    readonly globalConfigPath: string;
    /** Absolute project settings path, even when the project is untrusted; absent without a project. */
    readonly projectConfigPath: string | undefined;
    /** Whether a valid global layer contributed to {@link LoadedSettings.settings}. */
    readonly usedGlobalConfig: boolean;
    /** Whether a valid trusted-project layer contributed to {@link LoadedSettings.settings}. */
    readonly usedProjectConfig: boolean;
    /** Whether this load created the global settings file from schema defaults. */
    readonly scaffoldedGlobalConfig: boolean;
    /**
     * Result of installing the bundled editor schema in Pi's global settings directory.
     *
     * `created` and `updated` indicate a write, `unchanged` means the installed file already
     * matched, and `unavailable` means the bundled schema could not be verified or installed.
     */
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
    try {
        const content = readTextIfPresent(path);
        return content === undefined
            ? { settings: undefined, diagnostics: [] }
            : parseSettingsLayer(path, scope, content, layerSchema);
    } catch {
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
        try {
            schemaStatus = writeTextAtomically(globalPaths.schemaPath, sourceSchema);
        } catch {
            diagnostics.push({
                code: "schema-install-failed",
                severity: "error",
                scope: "schema",
                path: globalPaths.schemaPath,
                message: "The local editor schema could not be installed",
            });
        }

        if (schemaStatus !== "unavailable") {
            try {
                scaffoldedGlobalConfig =
                    writeTextIfMissing(
                        globalPaths.configPath,
                        formatJson(createDefaultSettingsDocument(definition)),
                    ) === "created";
            } catch {
                diagnostics.push({
                    code: "config-scaffold-failed",
                    severity: "error",
                    scope: "global",
                    path: globalPaths.configPath,
                    message: "The default global settings file could not be scaffolded",
                });
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
