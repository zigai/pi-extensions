import type { JsonValue } from "../src/json-value.ts";
import type { CatalogExtensionSettings, SettingsCatalog } from "../src/settings-store.ts";
import {
    type ExtensionSettingsSchema,
    parseExtensionSettingsSchema,
} from "../src/settings-schema.ts";

export function generatedSchemaText(
    id: string,
    properties: Readonly<Record<string, JsonValue>>,
    title = "Fixture Extension settings",
    required: readonly string[] = [],
): string {
    const requiredProperties = required.length > 0 ? { required } : {};

    return `${JSON.stringify(
        {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            $id: `urn:fixture:${id}`,
            title,
            description: "Fixture extension settings.",
            type: "object",
            ...requiredProperties,
            additionalProperties: false,
            properties: {
                $schema: {
                    type: "string",
                    default: `./schemas/${id}.schema.json`,
                    description: "JSON Schema used by editors for this settings file.",
                },
                ...properties,
            },
        },
        null,
        2,
    )}\n`;
}

export function richSchemaText(id = "pi-fixture"): string {
    return generatedSchemaText(id, {
        enabled: {
            type: "boolean",
            default: true,
            description: "Enable the fixture.",
        },
        mode: {
            type: "string",
            enum: ["fast", "safe"],
            default: "safe",
            description: "Choose the operating mode.",
        },
        threshold: {
            type: "integer",
            minimum: 1,
            default: 2,
            description: "Minimum event threshold.",
        },
        nested: {
            type: "object",
            additionalProperties: false,
            default: {},
            properties: {
                label: {
                    type: "string",
                    minLength: 1,
                    default: "default label",
                    description: "Nested display label.",
                },
                visible: {
                    type: "boolean",
                    default: true,
                    description: "Show the nested item.",
                },
            },
        },
        names: {
            type: "array",
            items: { type: "string", minLength: 1 },
            default: [],
            description: "Names shown in order.",
        },
        aliases: {
            type: "object",
            patternProperties: { "^.+$": { type: "string" } },
            default: {},
            description: "Aliases keyed by source name.",
        },
        flexible: {
            anyOf: [
                { type: "string", minLength: 1 },
                { type: "array", items: { type: "string" } },
            ],
            default: [],
            description: "One name or a list of names.",
        },
        fixed: {
            type: "number",
            const: 1,
            default: 1,
            description: "Settings format version.",
        },
        locked: {
            type: "string",
            default: "managed",
            readOnly: true,
            description: "A setting managed by the extension.",
        },
    });
}

export function parseFixtureSchema(
    id = "pi-fixture",
    schemaPath = `/agent/extension-settings/schemas/${id}.schema.json`,
): ExtensionSettingsSchema {
    const text = richSchemaText(id);
    const parsed = parseExtensionSettingsSchema(id, schemaPath, text);
    if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);
    return parsed.schema;
}

export function editableCatalog(extensions: readonly CatalogExtensionSettings[]): SettingsCatalog {
    return { extensions, diagnostics: [] };
}
