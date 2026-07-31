import { defineExtensionSettings } from "@zigai/pi-extension-settings";
import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { Type, type Static } from "typebox";

const identifierPattern = "^[a-zA-Z0-9][a-zA-Z0-9._-]*$";

const capabilityKindSchema = Type.Enum(["tool", "skill", "command", "system-fragment"] as const, {
    description: "Kind of Pi capability selected by a policy decision.",
});

const desiredStateSchema = Type.Enum(
    ["inherit", "on", "off", "lazy", "name-only", "user-only"] as const,
    { description: "Desired capability state. Available states depend on the capability kind." },
);

const scalarSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

const factArgsSchema = Type.Record(Type.String({ pattern: identifierPattern }), scalarSchema, {
    description: "Typed arguments supplied to a context fact.",
});

const factBaseProperties = {
    fact: Type.String({
        minLength: 1,
        description: "Registered context fact name, such as model.provider or project.fileExists.",
    }),
    args: Type.Optional(factArgsSchema),
};

export const conditionSchema = Type.Cyclic(
    {
        Condition: Type.Union([
            Type.Object(
                {
                    all: Type.Array(Type.Ref("Condition"), { minItems: 1 }),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    any: Type.Array(Type.Ref("Condition"), { minItems: 1 }),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    not: Type.Ref("Condition"),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    ...factBaseProperties,
                    equals: scalarSchema,
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    ...factBaseProperties,
                    notEquals: scalarSchema,
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    ...factBaseProperties,
                    in: Type.Array(scalarSchema, { minItems: 1 }),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    ...factBaseProperties,
                    notIn: Type.Array(scalarSchema, { minItems: 1 }),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    ...factBaseProperties,
                    contains: Type.String(),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    ...factBaseProperties,
                    startsWith: Type.String(),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    ...factBaseProperties,
                    endsWith: Type.String(),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    ...factBaseProperties,
                    lessThan: Type.Number(),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    ...factBaseProperties,
                    lessThanOrEqual: Type.Number(),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    ...factBaseProperties,
                    greaterThan: Type.Number(),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    ...factBaseProperties,
                    greaterThanOrEqual: Type.Number(),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    ...factBaseProperties,
                    isDefined: Type.Boolean(),
                },
                { additionalProperties: false },
            ),
        ]),
    },
    "Condition",
    { description: "Declarative condition evaluated against typed Pi and project context facts." },
);

export const capabilitySelectorSchema = Type.Object(
    {
        kind: capabilityKindSchema,
        name: Type.Optional(
            Type.String({ minLength: 1, description: "Declared capability name to match." }),
        ),
        source: Type.Optional(
            Type.String({ minLength: 1, description: "Pi sourceInfo.source value to match." }),
        ),
        path: Type.Optional(
            Type.String({
                minLength: 1,
                description: "Source-relative or canonical resource path to match.",
            }),
        ),
    },
    { additionalProperties: false },
);

export const policyDecisionSchema = Type.Object(
    {
        target: capabilitySelectorSchema,
        state: desiredStateSchema,
    },
    { additionalProperties: false },
);

const profileSchema = Type.Object(
    {
        decisions: Type.Array(policyDecisionSchema, {
            default: [],
            description: "Capability decisions activated by this profile.",
        }),
        promptFragments: Type.Array(Type.String({ pattern: identifierPattern }), {
            default: [],
            description: "System-prompt fragment IDs activated by this profile.",
        }),
    },
    { additionalProperties: false },
);

const promptFragmentContentSchema = Type.Union([
    Type.Object(
        {
            kind: Type.Literal("inline"),
            text: Type.String({
                maxLength: 50_000,
                "x-control": "textarea",
                description: "Inline system-prompt fragment text.",
            }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Literal("file"),
            path: Type.String({
                minLength: 1,
                "x-control": "path",
                description: "Path to a file containing the system-prompt fragment.",
            }),
        },
        { additionalProperties: false },
    ),
]);

export const promptFragmentSchema = Type.Object(
    {
        id: Type.String({ pattern: identifierPattern }),
        content: promptFragmentContentSchema,
        priority: Type.Integer({ default: 0 }),
        when: Type.Optional(conditionSchema),
    },
    { additionalProperties: false },
);

export const ruleSchema = Type.Object(
    {
        id: Type.String({ pattern: identifierPattern }),
        priority: Type.Integer({ default: 0 }),
        when: conditionSchema,
        decisions: Type.Array(policyDecisionSchema, {
            default: [],
            description: "Capability decisions contributed while this rule matches.",
        }),
        activateProfiles: Type.Array(Type.String({ pattern: identifierPattern }), {
            default: [],
            description: "Profiles contributed while this rule matches.",
        }),
    },
    { additionalProperties: false },
);

const defaultsSchema = Type.Object(
    {
        unknownCondition: Type.Literal("no-match", {
            default: "no-match",
            description: "Treat unknown or failed condition facts as a non-match.",
        }),
        lazyToolLimit: Type.Integer({
            minimum: 1,
            maximum: 20,
            default: 5,
            "x-control": "slider",
            description: "Maximum tools activated by one lazy capability search.",
        }),
        showStatus: Type.Boolean({
            default: true,
            description: "Show a compact footer status when policy changes Pi or has diagnostics.",
        }),
    },
    { additionalProperties: false },
);

export const settingsSchema = Type.Object(
    {
        enabled: Type.Boolean({
            default: true,
            description: "Enforce Pi Toggles policy while preserving the recovery command.",
        }),
        defaults: Type.Optional(
            Type.Object(
                {
                    unknownCondition: Type.Optional(defaultsSchema.properties.unknownCondition),
                    lazyToolLimit: Type.Optional(defaultsSchema.properties.lazyToolLimit),
                    showStatus: Type.Optional(defaultsSchema.properties.showStatus),
                },
                {
                    additionalProperties: false,
                    default: {},
                    description: "Default policy-engine behavior.",
                },
            ),
        ),
        activeProfile: Type.Optional(
            Type.String({
                pattern: identifierPattern,
                description: "Persistent profile selected at this settings scope.",
            }),
        ),
        overrides: Type.Array(policyDecisionSchema, {
            default: [],
            description: "Explicit persistent capability decisions.",
        }),
        profiles: Type.Record(Type.String({ pattern: identifierPattern }), profileSchema, {
            default: {},
            description: "Named bundles of capability decisions and prompt fragments.",
        }),
        promptFragments: Type.Array(promptFragmentSchema, {
            default: [],
            description: "Owned system-prompt fragments available to profiles and conditions.",
        }),
        rules: Type.Array(ruleSchema, {
            default: [],
            description: "Conditional decisions and profile activations.",
        }),
    },
    { additionalProperties: false },
);

export const settingsDocumentSchema = Type.Object(
    {
        $schema: Type.Optional(Type.String()),
        enabled: Type.Optional(settingsSchema.properties.enabled),
        defaults: Type.Optional(settingsSchema.properties.defaults),
        activeProfile: Type.Optional(settingsSchema.properties.activeProfile),
        overrides: Type.Optional(settingsSchema.properties.overrides),
        profiles: Type.Optional(settingsSchema.properties.profiles),
        promptFragments: Type.Optional(settingsSchema.properties.promptFragments),
        rules: Type.Optional(settingsSchema.properties.rules),
    },
    { additionalProperties: false },
);

export type CapabilityKind = Static<typeof capabilityKindSchema>;
export type DesiredState = Static<typeof desiredStateSchema>;
export type Condition = Static<typeof conditionSchema>;
export type CapabilitySelector = Static<typeof capabilitySelectorSchema>;
export type PolicyDecision = Static<typeof policyDecisionSchema>;
export type Profile = Static<typeof profileSchema>;
export type PromptFragment = Static<typeof promptFragmentSchema>;
export type PolicyRule = Static<typeof ruleSchema>;
export type ExtensionSettings = Static<typeof settingsSchema>;
export type SettingsDocument = Static<typeof settingsDocumentSchema>;

export const extensionSettingsDefinition = defineExtensionSettings({
    id: "pi-toggles",
    title: "Pi Toggles",
    description: "Central capability policy, profiles, conditions, and session overrides for Pi.",
    schemaId: "https://raw.githubusercontent.com/zigai/pi-toggles/HEAD/config.schema.json",
    schema: settingsSchema,
});

export function loadTogglesSettings(ctx: PiSettingsContext) {
    return loadPiExtensionSettings(extensionSettingsDefinition, ctx, {
        bundledSchema: {
            kind: "url",
            url: new URL("../config.schema.json", import.meta.url),
        },
    });
}

export default extensionSettingsDefinition;
