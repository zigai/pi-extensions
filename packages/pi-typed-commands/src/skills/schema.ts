import Type, { type Static } from "typebox";

const ARGUMENT_NAME_PATTERN = "^[A-Za-z0-9_.-]+$";
const RESERVED_ARGUMENT_NAME_SEGMENT_PATTERN = "(^|\\.)(__proto__|constructor|prototype)(\\.|$)";

const OCCURRENCE_VALUES = ["error", "first", "last", "append"] as const;
const SCALAR_OCCURRENCE_VALUES = ["error", "first", "last"] as const;
const SKILL_WIDGET_VALUES = [
    "text",
    "textarea",
    "number",
    "toggle",
    "select",
    "radio",
    "multiselect",
    "path",
    "command",
    "readonly",
    "computed",
    "confirm",
] as const;

export const UnknownRecordYamlSchema = Type.Record(Type.String(), Type.Unknown());

const sharedArgumentYamlProperties = {
    description: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    required: Type.Optional(Type.Boolean()),
    placeholder: Type.Optional(Type.String()),
    occurrence: Type.Optional(Type.Enum(OCCURRENCE_VALUES)),
    position: Type.Optional(Type.Integer({ minimum: 0 })),
    rest: Type.Optional(Type.Boolean()),
};

const noRequiredDefaultConflict = {
    not: {
        required: ["required", "default"],
        properties: {
            required: { const: true },
        },
    },
};

/** YAML `ui` object accepted by typed skill argument frontmatter. */
export const SkillArgumentUiYamlSchema = Type.Object(
    {
        widget: Type.Optional(Type.Enum(SKILL_WIDGET_VALUES)),
        rows: Type.Optional(Type.Integer({ minimum: 1 })),
        title: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);

const sharedArgumentYamlPropertiesWithUi = {
    ...sharedArgumentYamlProperties,
    ui: Type.Optional(SkillArgumentUiYamlSchema),
};

const stringArraySchema = Type.Array(Type.String({ minLength: 1 }), {
    uniqueItems: true,
});

const nonEmptyStringArraySchema = Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    uniqueItems: true,
});

/** YAML DTO for a `type: string` skill argument. */
export const StringSkillArgumentYamlSchema = Type.Object(
    {
        type: Type.Literal("string"),
        ...sharedArgumentYamlPropertiesWithUi,
        occurrence: Type.Optional(Type.Enum(SCALAR_OCCURRENCE_VALUES)),
        default: Type.Optional(Type.String()),
        min_length: Type.Optional(Type.Integer({ minimum: 0 })),
        max_length: Type.Optional(Type.Integer({ minimum: 0 })),
        pattern: Type.Optional(Type.String()),
    },
    { additionalProperties: false, allOf: [noRequiredDefaultConflict] },
);

/** YAML DTO for a `type: number` skill argument. */
export const NumberSkillArgumentYamlSchema = Type.Object(
    {
        type: Type.Literal("number"),
        ...sharedArgumentYamlPropertiesWithUi,
        occurrence: Type.Optional(Type.Enum(SCALAR_OCCURRENCE_VALUES)),
        rest: Type.Optional(Type.Literal(false)),
        default: Type.Optional(Type.Number()),
        integer: Type.Optional(Type.Boolean()),
        min: Type.Optional(Type.Number()),
        max: Type.Optional(Type.Number()),
    },
    { additionalProperties: false, allOf: [noRequiredDefaultConflict] },
);

/** YAML DTO for a `type: boolean` skill argument. */
export const BooleanSkillArgumentYamlSchema = Type.Object(
    {
        type: Type.Literal("boolean"),
        ...sharedArgumentYamlPropertiesWithUi,
        occurrence: Type.Optional(Type.Enum(SCALAR_OCCURRENCE_VALUES)),
        rest: Type.Optional(Type.Literal(false)),
        default: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false, allOf: [noRequiredDefaultConflict] },
);

/** YAML DTO for a `type: enum` skill argument. */
export const EnumSkillArgumentYamlSchema = Type.Object(
    {
        type: Type.Literal("enum"),
        ...sharedArgumentYamlPropertiesWithUi,
        occurrence: Type.Optional(Type.Enum(SCALAR_OCCURRENCE_VALUES)),
        rest: Type.Optional(Type.Literal(false)),
        default: Type.Optional(Type.String()),
        values: nonEmptyStringArraySchema,
    },
    { additionalProperties: false, allOf: [noRequiredDefaultConflict] },
);

/** YAML DTO for a `type: multi_enum` or `type: multi-enum` skill argument. */
export const MultiEnumSkillArgumentYamlSchema = Type.Object(
    {
        type: Type.Enum(["multi_enum", "multi-enum"] as const),
        ...sharedArgumentYamlPropertiesWithUi,
        default: Type.Optional(stringArraySchema),
        values: nonEmptyStringArraySchema,
        min_items: Type.Optional(Type.Integer({ minimum: 0 })),
        max_items: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false, allOf: [noRequiredDefaultConflict] },
);

/** YAML DTO for one concrete typed skill argument. */
export const SkillArgumentYamlSchema = Type.Union([
    StringSkillArgumentYamlSchema,
    NumberSkillArgumentYamlSchema,
    BooleanSkillArgumentYamlSchema,
    EnumSkillArgumentYamlSchema,
    MultiEnumSkillArgumentYamlSchema,
]);

/** YAML frontmatter fields consumed by typed skill support. */
export const SkillFrontmatterYamlSchema = Type.Object(
    {
        name: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        form_title: Type.Optional(Type.String()),
        arguments: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);

/** Recursive top-level YAML `arguments` map schema used for the published JSON Schema. */
export const SkillArgumentsYamlSchema = Type.Object(
    {},
    {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://github.com/zigai/pi-typed-args/schemas/skill-arguments.schema.json",
        title: "Pi Typed Args Skill Arguments",
        description:
            "Schema for the top-level `arguments` field in SKILL.md frontmatter used by pi-typed-args.",
        propertyNames: Type.String({
            allOf: [
                { pattern: ARGUMENT_NAME_PATTERN },
                { not: { pattern: RESERVED_ARGUMENT_NAME_SEGMENT_PATTERN } },
            ],
        }),
        additionalProperties: Type.Ref("#/$defs/argumentOrNamespace"),
        $defs: {
            argumentName: Type.String({
                allOf: [
                    { pattern: ARGUMENT_NAME_PATTERN },
                    { not: { pattern: RESERVED_ARGUMENT_NAME_SEGMENT_PATTERN } },
                ],
            }),
            argumentOrNamespace: Type.Union([
                Type.Ref("#/$defs/argument"),
                Type.Object(
                    {},
                    {
                        propertyNames: Type.Ref("#/$defs/argumentName"),
                        additionalProperties: Type.Ref("#/$defs/argumentOrNamespace"),
                    },
                ),
            ]),
            shared: Type.Object(sharedArgumentYamlProperties, {
                allOf: [{ not: { required: ["aliases"] } }, noRequiredDefaultConflict],
            }),
            ui: SkillArgumentUiYamlSchema,
            stringArgument: StringSkillArgumentYamlSchema,
            numberArgument: NumberSkillArgumentYamlSchema,
            booleanArgument: BooleanSkillArgumentYamlSchema,
            enumArgument: EnumSkillArgumentYamlSchema,
            multiEnumArgument: MultiEnumSkillArgumentYamlSchema,
            argument: Type.Union([
                Type.Ref("#/$defs/stringArgument"),
                Type.Ref("#/$defs/numberArgument"),
                Type.Ref("#/$defs/booleanArgument"),
                Type.Ref("#/$defs/enumArgument"),
                Type.Ref("#/$defs/multiEnumArgument"),
            ]),
        },
    },
);

export type SkillArgumentUiYaml = Static<typeof SkillArgumentUiYamlSchema>;
export type StringSkillArgumentYaml = Static<typeof StringSkillArgumentYamlSchema>;
export type NumberSkillArgumentYaml = Static<typeof NumberSkillArgumentYamlSchema>;
export type BooleanSkillArgumentYaml = Static<typeof BooleanSkillArgumentYamlSchema>;
export type EnumSkillArgumentYaml = Static<typeof EnumSkillArgumentYamlSchema>;
export type MultiEnumSkillArgumentYaml = Static<typeof MultiEnumSkillArgumentYamlSchema>;
export type SkillArgumentYaml = Static<typeof SkillArgumentYamlSchema>;
export type SkillFrontmatterYaml = Static<typeof SkillFrontmatterYamlSchema>;

/** Return the JSON Schema published at `pi-typed-args/schema`. */
export function skillArgumentsJsonSchema(): typeof SkillArgumentsYamlSchema {
    return SkillArgumentsYamlSchema;
}
