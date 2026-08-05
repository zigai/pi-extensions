import type { TObject, TSchema } from "typebox";
import { Value } from "typebox/value";

import { isJsonObject, parseJson, type JsonObject } from "./json-value.ts";
import { mergeSettings, settingsLayerFromFile } from "./settings-merge.ts";

export type SettingsScope = "global" | "project";

/**
 * Stable machine-readable category for a non-fatal settings problem.
 *
 * Callers should branch on this value rather than diagnostic text:
 *
 * - `bundled-schema-read-failed`: the generated schema could not be read.
 * - `bundled-schema-stale`: the bundled schema does not match the definition.
 * - `config-decode-failed`: a validated layer could not be decoded by TypeBox.
 * - `config-invalid`: a layer failed validation or conflicted with an earlier layer.
 * - `config-malformed`: a settings file contains malformed JSON.
 * - `config-read-failed`: a settings file could not be read.
 * - `config-scaffold-failed`: the initial global settings file could not be created.
 * - `schema-install-failed`: the editor schema could not be installed.
 */
export type SettingsDiagnosticCode =
    | "bundled-schema-read-failed"
    | "bundled-schema-stale"
    | "config-decode-failed"
    | "config-invalid"
    | "config-malformed"
    | "config-read-failed"
    | "config-scaffold-failed"
    | "schema-install-failed";

export type SettingsValidationIssue = {
    /** JSON Pointer to the invalid setting, or `/` for the document root. */
    readonly path: string;
    /** TypeBox validation message for this issue. */
    readonly message: string;
};

/**
 * A non-fatal problem encountered while loading settings.
 *
 * The affected schema or settings layer is ignored. Messages and validation issues contain no
 * settings values, making them suitable for display through Pi's UI.
 */
export type SettingsDiagnostic = {
    /** Stable category intended for programmatic handling. */
    readonly code: SettingsDiagnosticCode;
    /** All current diagnostics are errors; the field allows direct use with `ctx.ui.notify`. */
    readonly severity: "error";
    /** The settings layer or editor-schema operation that failed. */
    readonly scope: SettingsScope | "schema";
    /** Absolute path of the affected settings or schema file. */
    readonly path: string;
    /** User-facing summary that does not include settings values. */
    readonly message: string;
    /** JSON Pointer paths and validator messages when schema validation failed. */
    readonly issues?: readonly SettingsValidationIssue[];
};

export type ParsedSettingsLayer = {
    /** Encoded JSON settings after editor-only metadata is removed. */
    readonly settings: JsonObject | undefined;
    /** Editor schema reference from the file, when present and valid. */
    readonly schemaReference: string | undefined;
    readonly diagnostics: readonly SettingsDiagnostic[];
};

export function settingsValidationIssues(
    schema: TSchema,
    value: unknown,
): readonly SettingsValidationIssue[] {
    return [...Value.Errors(schema, value)].map((issue) => ({
        path: issue.instancePath === "" ? "/" : issue.instancePath,
        message: issue.message,
    }));
}

export function parseSettingsLayer(
    path: string,
    scope: SettingsScope,
    text: string,
    layerSchema: TSchema,
): ParsedSettingsLayer {
    const parsed = parseJson(text);
    if (parsed === undefined) {
        return {
            settings: undefined,
            schemaReference: undefined,
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
            schemaReference: undefined,
            diagnostics: [
                {
                    code: "config-invalid",
                    severity: "error",
                    scope,
                    path,
                    message: `${scope} settings do not match the extension schema and were ignored`,
                    issues: settingsValidationIssues(layerSchema, parsed),
                },
            ],
        };
    }

    const schemaReference =
        isJsonObject(parsed) && typeof parsed.$schema === "string" ? parsed.$schema : undefined;
    try {
        const decoded: unknown = Value.Decode(layerSchema, parsed);
        if (!isJsonObject(decoded)) {
            return {
                settings: undefined,
                schemaReference,
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
        return { settings: settingsLayerFromFile(decoded), schemaReference, diagnostics: [] };
    } catch {
        return {
            settings: undefined,
            schemaReference,
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

export function applySettingsLayer<Schema extends TObject>(
    schema: Schema,
    current: JsonObject,
    layer: Pick<ParsedSettingsLayer, "settings">,
    path: string,
    scope: SettingsScope,
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
            issues: settingsValidationIssues(schema, merged),
        },
    };
}
