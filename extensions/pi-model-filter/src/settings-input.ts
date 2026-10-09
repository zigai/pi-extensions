import { Type } from "typebox";

import { type ModelFilterSettings } from "./model-filter.ts";

export const EXTENSION_ID = "pi-model-filter";
export const CONFIG_FILE = `${EXTENSION_ID}.json`;

export type LoadedModelFilterSettings = {
    path: string;
    mtimeMs: number;
    settings: ModelFilterSettings;
    diagnostic?: string;
};

export type ModelFilterSettingsLoadState = {
    configCache?: LoadedModelFilterSettings;
    configCacheSignature?: string;
    configCwd?: string;
    projectTrusted?: boolean;
};

export const nonBlankStringSchema = Type.String({ pattern: "\\S" });

export const filterRuleSchema = Type.Object(
    {
        provider: nonBlankStringSchema,
        models: Type.Array(nonBlankStringSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
);

export const extensionSettingsInput = {
    id: EXTENSION_ID,
    title: "Pi Model Filter",
    description: "Settings for including and excluding models from Pi's model registry.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-model-filter/config.schema.json",
    schema: Type.Object(
        {
            include: Type.Array(filterRuleSchema, {
                default: [],
                description: "Provider and model glob rules that form inclusion allowlists.",
            }),
            exclude: Type.Array(filterRuleSchema, {
                default: [],
                description: "Provider and model glob rules that hide matching models.",
            }),
        },
        { additionalProperties: false },
    ),
    exampleSettings: {
        include: [{ provider: "openai-codex", models: ["gpt-5.*"] }],
        exclude: [{ provider: "openai-codex", models: ["*-mini"] }],
    },
};

export default extensionSettingsInput;
