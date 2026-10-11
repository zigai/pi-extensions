import type { TLocalizedValidationError } from "typebox/error";
import type { TObject, TSchema } from "typebox";

import { Value } from "./typebox-runtime.ts";

import {
    isJsonArray,
    isJsonObject,
    isJsonString,
    cloneJson,
    parseJson,
    type JsonObject,
    type JsonValue,
} from "./json-value.ts";
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

function validationMessage(keyword: string): string {
    switch (keyword) {
        case "additionalProperties":
            return "Unexpected setting";
        case "anyOf":
            return "Setting does not match an allowed form";
        case "const":
            return "Setting does not match the required value";
        case "enum":
            return "Setting is not one of the allowed values";
        case "maximum":
            return "Number is above the allowed maximum";
        case "maxItems":
            return "Array has too many items";
        case "maxLength":
            return "Text is longer than allowed";
        case "minimum":
            return "Number is below the allowed minimum";
        case "minItems":
            return "Array has too few items";
        case "minLength":
            return "Text is shorter than allowed";
        case "pattern":
            return "Text does not match the required format";
        case "required":
            return "Required setting is missing";
        case "type":
            return "Setting has the wrong type";
        default:
            return "Setting failed validation";
    }
}

function collectDeclaredPropertyNames(value: JsonValue, names: Set<string>): void {
    if (isJsonArray(value)) {
        for (const item of value) collectDeclaredPropertyNames(item, names);

        return;
    }

    if (!isJsonObject(value)) return;

    if (isJsonObject(value.properties)) {
        for (const name of Object.keys(value.properties)) names.add(name);
    }

    for (const [key, child] of Object.entries(value)) {
        if (["default", "const", "enum", "examples"].includes(key)) continue;
        collectDeclaredPropertyNames(child, names);
    }
}

function declaredPropertyNames(schema: TSchema): ReadonlySet<string> {
    const names = new Set<string>();
    const serialized = JSON.stringify(schema);
    if (serialized === undefined) return names;

    const parsed = parseJson(serialized);
    if (parsed !== undefined) collectDeclaredPropertyNames(parsed, names);

    return names;
}

function safeIssuePath(instancePath: string, names: ReadonlySet<string>): string {
    if (instancePath === "") return "/";

    const segments = instancePath.slice(1).split("/");

    return `/${segments
        .map((segment) => {
            const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
            if (/^\d+$/.test(decoded)) return "<index>";
            return names.has(decoded) ? segment : "<key>";
        })
        .join("/")}`;
}

export function settingsValidationIssues(
    schema: TSchema,
    value: JsonValue,
): readonly SettingsValidationIssue[] {
    const names = declaredPropertyNames(schema);

    return [...Value.Errors(schema, value)].map((issue: TLocalizedValidationError) => ({
        path: safeIssuePath(issue.instancePath, names),
        message: validationMessage(issue.keyword),
    }));
}

const UNSUPPORTED_SETTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function unsupportedSettingsKeyPath(value: JsonValue, path = ""): string | undefined {
    if (isJsonArray(value)) {
        for (const [index, child] of value.entries()) {
            const result = unsupportedSettingsKeyPath(child, `${path}/${index}`);
            if (result !== undefined) return result;
        }

        return undefined;
    }

    if (!isJsonObject(value)) return undefined;

    for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        if (UNSUPPORTED_SETTING_KEYS.has(key)) return childPath;

        const result = unsupportedSettingsKeyPath(child, childPath);
        if (result !== undefined) return result;
    }

    return undefined;
}

export function unsupportedSettingsKeyIssue(
    schema: TSchema,
    value: JsonValue,
): SettingsValidationIssue | undefined {
    const path = unsupportedSettingsKeyPath(value);
    if (path === undefined) return undefined;

    const names = new Set([...declaredPropertyNames(schema), ...UNSUPPORTED_SETTING_KEYS]);
    return { path: safeIssuePath(path, names), message: "Unsupported property name" };
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

    const unsupportedIssue = unsupportedSettingsKeyIssue(layerSchema, parsed);
    if (unsupportedIssue !== undefined) {
        return {
            settings: undefined,
            schemaReference: undefined,
            diagnostics: [
                {
                    code: "config-invalid",
                    severity: "error",
                    scope,
                    path,
                    message: `${scope} settings contain an unsupported property name and were ignored`,
                    issues: [unsupportedIssue],
                },
            ],
        };
    }

    if (!isJsonObject(parsed) || !Value.Check(layerSchema, parsed)) {
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
        isJsonObject(parsed) && isJsonString(parsed.$schema) ? parsed.$schema : undefined;
    return {
        settings: settingsLayerFromFile(cloneJson(parsed)),
        schemaReference,
        diagnostics: [],
    };
}

export type AppliedSettingsLayer = {
    readonly settings: JsonObject;
    readonly diagnostic?: SettingsDiagnostic;
};

export function applySettingsLayer(
    schema: TObject,
    current: JsonObject,
    layer: Pick<ParsedSettingsLayer, "settings">,
    path: string,
    scope: SettingsScope,
): AppliedSettingsLayer {
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
