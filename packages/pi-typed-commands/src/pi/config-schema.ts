import Type, { type Static } from "typebox";
import { DEFAULT_HELPER_PLACEMENT } from "./helper.js";
import {
    DEFAULT_PI_TYPED_COMMANDS_APPEARANCE,
    PI_THEME_COLOR_NAMES,
} from "./presentation-config.js";

export const PI_TYPED_COMMANDS_CONFIG_SCHEMA_REFERENCE = "./config.schema.json";
const JSON_SCHEMA_DRAFT_URI = "https://json-schema.org/draft/2020-12/schema";
const PI_TYPED_COMMANDS_CONFIG_SCHEMA_ID =
    "https://github.com/zigai/pi-typed-commands/config.schema.json";

export const DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON = {
    $schema: PI_TYPED_COMMANDS_CONFIG_SCHEMA_REFERENCE,
    helperPlacement: DEFAULT_HELPER_PLACEMENT,
    appearance: {
        form: {
            colors: { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.form.colors },
            symbols: { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.form.symbols },
            layout: { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.form.layout },
        },
        inlineHelp: {
            layout: DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp.layout,
            choiceDisplay: DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp.choiceDisplay,
            order: DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp.order,
            metadata: { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp.metadata },
            colors: { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp.colors },
            format: { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp.format },
        },
        detailedHelp: {
            metadata: { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.detailedHelp.metadata },
            order: DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.detailedHelp.order,
        },
    },
} as const;

const ThemeColorSchema = Type.Enum(PI_THEME_COLOR_NAMES);
const WidgetPlacementSchema = Type.Enum(["aboveEditor", "belowEditor"] as const);
const InlineHelpChoiceDisplaySchema = Type.Enum(["contextual", "inline"] as const);
const InlineHelpOrderSchema = Type.Enum([
    "active-required-available",
    "active-available-required",
    "required-active-available",
    "required-available-active",
    "available-active-required",
    "available-required-active",
    "definition",
] as const);
const FormDescriptionsSchema = Type.Enum(["inline", "focused", "hidden"] as const);
const FormInstructionsSchema = Type.Enum(["full", "short", "hidden"] as const);
const DetailedHelpOrderSchema = Type.Enum(["definition", "required-first"] as const);
const DisplayStringSchema = Type.String({ minLength: 1, pattern: "^[^\\r\\n]*$" });
const OptionalEmptyDisplayStringSchema = Type.String({ pattern: "^[^\\r\\n]*$" });
const LeftPaddingSchema = Type.Integer({ minimum: 0, maximum: 12 });
const FieldGapSchema = Type.Integer({ minimum: 0, maximum: 12 });
const MinNameWidthSchema = Type.Integer({ minimum: 1, maximum: 80 });
const MaxNameWidthSchema = Type.Integer({ minimum: 1, maximum: 120 });
const MinValueWidthSchema = Type.Integer({ minimum: 1, maximum: 80 });
const MaxValueWidthSchema = Type.Integer({ minimum: 1, maximum: 120 });

const HelpMetadataSchema = Type.Object(
    {
        types: Type.Optional(Type.Boolean()),
        defaults: Type.Optional(Type.Boolean()),
        required: Type.Optional(Type.Boolean()),
        aliases: Type.Optional(Type.Boolean()),
        descriptions: Type.Optional(Type.Boolean()),
        enumValues: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: true },
);

export const PiTypedCommandsConfigSchema = Type.Object(
    {
        helperPlacement: Type.Optional(WidgetPlacementSchema),
        appearance: Type.Optional(
            Type.Object(
                {
                    form: Type.Optional(
                        Type.Object(
                            {
                                colors: Type.Optional(
                                    Type.Object(
                                        {
                                            title: Type.Optional(ThemeColorSchema),
                                            focusedLabel: Type.Optional(ThemeColorSchema),
                                            focusedValue: Type.Optional(ThemeColorSchema),
                                            unsetValue: Type.Optional(ThemeColorSchema),
                                            description: Type.Optional(ThemeColorSchema),
                                            instructions: Type.Optional(ThemeColorSchema),
                                            issue: Type.Optional(ThemeColorSchema),
                                            editorBorder: Type.Optional(ThemeColorSchema),
                                            selectedOption: Type.Optional(ThemeColorSchema),
                                        },
                                        {
                                            additionalProperties: true,
                                            default:
                                                DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON.appearance
                                                    .form.colors,
                                        },
                                    ),
                                ),
                                symbols: Type.Optional(
                                    Type.Object(
                                        {
                                            focusedField: Type.Optional(DisplayStringSchema),
                                            selectedCheckbox: Type.Optional(DisplayStringSchema),
                                            unselectedCheckbox: Type.Optional(DisplayStringSchema),
                                            selectedRadio: Type.Optional(DisplayStringSchema),
                                            unselectedRadio: Type.Optional(DisplayStringSchema),
                                        },
                                        {
                                            additionalProperties: true,
                                            default:
                                                DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON.appearance
                                                    .form.symbols,
                                        },
                                    ),
                                ),
                                layout: Type.Optional(
                                    Type.Object(
                                        {
                                            leftPadding: Type.Optional(LeftPaddingSchema),
                                            fieldGap: Type.Optional(FieldGapSchema),
                                            minNameWidth: Type.Optional(MinNameWidthSchema),
                                            maxNameWidth: Type.Optional(MaxNameWidthSchema),
                                            minValueWidth: Type.Optional(MinValueWidthSchema),
                                            maxValueWidth: Type.Optional(MaxValueWidthSchema),
                                            descriptions: Type.Optional(FormDescriptionsSchema),
                                            instructions: Type.Optional(FormInstructionsSchema),
                                        },
                                        {
                                            additionalProperties: true,
                                            default:
                                                DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON.appearance
                                                    .form.layout,
                                        },
                                    ),
                                ),
                            },
                            {
                                additionalProperties: true,
                                default: DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON.appearance.form,
                            },
                        ),
                    ),
                    inlineHelp: Type.Optional(
                        Type.Object(
                            {
                                layout: Type.Optional(Type.Literal("compact")),
                                choiceDisplay: Type.Optional(InlineHelpChoiceDisplaySchema),
                                order: Type.Optional(InlineHelpOrderSchema),
                                metadata: Type.Optional(HelpMetadataSchema),
                                colors: Type.Optional(
                                    Type.Object(
                                        {
                                            active: Type.Optional(ThemeColorSchema),
                                            required: Type.Optional(ThemeColorSchema),
                                            available: Type.Optional(ThemeColorSchema),
                                            type: Type.Optional(ThemeColorSchema),
                                            metadata: Type.Optional(ThemeColorSchema),
                                            issue: Type.Optional(ThemeColorSchema),
                                        },
                                        {
                                            additionalProperties: true,
                                            default:
                                                DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON.appearance
                                                    .inlineHelp.colors,
                                        },
                                    ),
                                ),
                                format: Type.Optional(
                                    Type.Object(
                                        {
                                            tokenPrefix: Type.Optional(
                                                OptionalEmptyDisplayStringSchema,
                                            ),
                                            tokenSuffix: Type.Optional(
                                                OptionalEmptyDisplayStringSchema,
                                            ),
                                            groupSeparator: Type.Optional(
                                                OptionalEmptyDisplayStringSchema,
                                            ),
                                            itemSeparator: Type.Optional(
                                                OptionalEmptyDisplayStringSchema,
                                            ),
                                            typeSeparator: Type.Optional(
                                                OptionalEmptyDisplayStringSchema,
                                            ),
                                            valueSeparator: Type.Optional(
                                                OptionalEmptyDisplayStringSchema,
                                            ),
                                        },
                                        {
                                            additionalProperties: true,
                                            default:
                                                DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON.appearance
                                                    .inlineHelp.format,
                                        },
                                    ),
                                ),
                            },
                            {
                                additionalProperties: true,
                                default:
                                    DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON.appearance.inlineHelp,
                            },
                        ),
                    ),
                    detailedHelp: Type.Optional(
                        Type.Object(
                            {
                                metadata: Type.Optional(HelpMetadataSchema),
                                order: Type.Optional(DetailedHelpOrderSchema),
                            },
                            {
                                additionalProperties: true,
                                default:
                                    DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON.appearance.detailedHelp,
                            },
                        ),
                    ),
                },
                {
                    additionalProperties: true,
                    default: DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON.appearance,
                },
            ),
        ),
    },
    { additionalProperties: true },
);

/** Parsed extension configuration after TypeBox has checked the JSON boundary value. */
export type PiTypedCommandsConfig = Static<typeof PiTypedCommandsConfigSchema>;
export type PiTypedCommandsAppearanceConfig = NonNullable<PiTypedCommandsConfig["appearance"]>;

/** JSON Schema document published for persisted pi-typed-args configuration. */
export type PiTypedCommandsConfigJsonSchema = typeof PiTypedCommandsConfigSchema & {
    readonly $schema: typeof JSON_SCHEMA_DRAFT_URI;
    readonly $id: typeof PI_TYPED_COMMANDS_CONFIG_SCHEMA_ID;
};

export function piTypedCommandsConfigJsonSchema(): PiTypedCommandsConfigJsonSchema {
    return {
        $schema: JSON_SCHEMA_DRAFT_URI,
        $id: PI_TYPED_COMMANDS_CONFIG_SCHEMA_ID,
        ...structuredClone(PiTypedCommandsConfigSchema),
    };
}
