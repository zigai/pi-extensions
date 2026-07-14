import type { TObject, TSchema } from "typebox";
import { Value } from "typebox/value";

import { isJsonObject, parseJson, type JsonObject } from "./json-value.ts";
import { mergeSettings, settingsLayerFromFile } from "./settings-merge.ts";

export type SettingsScope = "global" | "project";

export type SettingsDiagnosticCode =
    | "bundled-schema-read-failed"
    | "bundled-schema-stale"
    | "config-decode-failed"
    | "config-invalid"
    | "config-malformed"
    | "config-read-failed"
    | "config-scaffold-failed"
    | "schema-install-failed";

export type SettingsDiagnostic = {
    readonly code: SettingsDiagnosticCode;
    readonly severity: "error";
    readonly scope: SettingsScope | "schema";
    readonly path: string;
    readonly message: string;
    readonly issues?: readonly {
        readonly path: string;
        readonly message: string;
    }[];
};

export type ParsedSettingsLayer = {
    readonly settings: JsonObject | undefined;
    readonly diagnostics: readonly SettingsDiagnostic[];
};

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

export function applySettingsLayer<Schema extends TObject>(
    schema: Schema,
    current: JsonObject,
    layer: ParsedSettingsLayer,
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
            issues: validationIssues(schema, merged),
        },
    };
}
