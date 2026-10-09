import { Type } from "typebox";

import type { ModelAliasSettings } from "./model-aliasing.ts";

export const EXTENSION_ID = "pi-model-alias";
export const CONFIG_FILE = `${EXTENSION_ID}.json`;

export type LoadedModelAliasSettings = {
    path: string;
    mtimeMs: number;
    settings: ModelAliasSettings;
    diagnostic?: string;
};

export type ModelAliasSettingsLoadState = {
    configCache?: LoadedModelAliasSettings;
    configCacheSignature?: string;
    configCwd?: string;
    projectTrusted?: boolean;
};

export function nonBlankStringSchema(description: string) {
    return Type.String({ pattern: "\\S", description });
}

export const aliasConfigSchema = Type.Object(
    {
        provider: nonBlankStringSchema("Provider ID that owns the model."),
        model: nonBlankStringSchema("Original model ID sent to the provider."),
        alias: nonBlankStringSchema("Short local model ID accepted by Pi."),
        name: Type.Optional(
            nonBlankStringSchema(
                "Optional displayed model name; omit it to keep Pi's native label.",
            ),
        ),
    },
    { additionalProperties: false },
);

export const providerAliasConfigSchema = Type.Object(
    {
        provider: nonBlankStringSchema("Provider ID whose displayed name should change."),
        name: nonBlankStringSchema("Provider name displayed by Pi."),
    },
    { additionalProperties: false },
);

export const extensionSettingsInput = {
    id: EXTENSION_ID,
    title: "Pi Model Alias",
    description: "Settings for model and provider display aliases.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-model-alias/config.schema.json",
    schema: Type.Object(
        {
            aliases: Type.Array(aliasConfigSchema, {
                default: [],
                description: "Short model IDs with optional display-name overrides.",
            }),
            providerAliases: Type.Array(providerAliasConfigSchema, {
                default: [],
                description: "Provider display-name overrides; provider IDs remain unchanged.",
            }),
            stableProviderColumn: Type.Boolean({
                default: true,
                description: "Keep the provider column stable when aliases are displayed.",
            }),
        },
        { additionalProperties: false },
    ),
    exampleSettings: {
        aliases: [
            {
                provider: "anthropic",
                model: "claude-sonnet-4-5",
                alias: "sonnet",
                name: "Claude Sonnet 4.5",
            },
            {
                provider: "openai-codex",
                model: "gpt-5.6-sol",
                alias: "sol",
            },
        ],
        providerAliases: [{ provider: "openai-codex", name: "Codex" }],
    },
};

export default extensionSettingsInput;
