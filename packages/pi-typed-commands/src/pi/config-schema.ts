import Type from "typebox";
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PiTypedCommandsConfigSchema = Type.Object(
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
                                            focusedField: Type.Optional(Type.String()),
                                            selectedCheckbox: Type.Optional(Type.String()),
                                            unselectedCheckbox: Type.Optional(Type.String()),
                                            selectedRadio: Type.Optional(Type.String()),
                                            unselectedRadio: Type.Optional(Type.String()),
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
                                            leftPadding: Type.Optional(Type.Number()),
                                            fieldGap: Type.Optional(Type.Number()),
                                            minNameWidth: Type.Optional(Type.Number()),
                                            maxNameWidth: Type.Optional(Type.Number()),
                                            minValueWidth: Type.Optional(Type.Number()),
                                            maxValueWidth: Type.Optional(Type.Number()),
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
                                            tokenPrefix: Type.Optional(Type.String()),
                                            tokenSuffix: Type.Optional(Type.String()),
                                            groupSeparator: Type.Optional(Type.String()),
                                            itemSeparator: Type.Optional(Type.String()),
                                            typeSeparator: Type.Optional(Type.String()),
                                            valueSeparator: Type.Optional(Type.String()),
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

export function piTypedCommandsConfigJsonSchema(): unknown {
    const schema = structuredClone(PiTypedCommandsConfigSchema);
    if (!isRecord(schema)) return schema;
    return {
        $schema: JSON_SCHEMA_DRAFT_URI,
        $id: PI_TYPED_COMMANDS_CONFIG_SCHEMA_ID,
        ...schema,
    };
}
