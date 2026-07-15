import Type, { type Static, type TSchema } from "typebox";
import Schema from "../typebox-schema.js";
import type { PiTypedCommandsAppearanceConfig } from "./config-schema.js";
import type { TypedCommandFormSymbols } from "../types.js";

/** Pi TUI theme colour roles accepted by pi-typed-args appearance settings. */
export const PI_THEME_COLOR_NAMES = [
    "accent",
    "border",
    "borderAccent",
    "borderMuted",
    "success",
    "error",
    "warning",
    "muted",
    "dim",
    "text",
    "thinkingText",
    "userMessageText",
    "customMessageText",
    "customMessageLabel",
    "toolTitle",
    "toolOutput",
    "mdHeading",
    "mdLink",
    "mdLinkUrl",
    "mdCode",
    "mdCodeBlock",
    "mdCodeBlockBorder",
    "mdQuote",
    "mdQuoteBorder",
    "mdHr",
    "mdListBullet",
    "toolDiffAdded",
    "toolDiffRemoved",
    "toolDiffContext",
    "syntaxComment",
    "syntaxKeyword",
    "syntaxFunction",
    "syntaxVariable",
    "syntaxString",
    "syntaxNumber",
    "syntaxType",
    "syntaxOperator",
    "syntaxPunctuation",
    "thinkingOff",
    "thinkingMinimal",
    "thinkingLow",
    "thinkingMedium",
    "thinkingHigh",
    "thinkingXhigh",
    "bashMode",
] as const;

/** Supported Pi TUI theme colour role name. */
export type PiThemeColorName = (typeof PI_THEME_COLOR_NAMES)[number];

/** Colour slots used by the dense argument form. */
export type FormAppearanceColorSlot =
    | "title"
    | "focusedLabel"
    | "focusedValue"
    | "unsetValue"
    | "description"
    | "instructions"
    | "issue"
    | "editorBorder"
    | "selectedOption";

/** Colour slots used by inline command help. */
export type InlineHelpColorSlot =
    | "active"
    | "required"
    | "available"
    | "type"
    | "metadata"
    | "issue";

/** Inline helper group ordering. */
export type InlineHelpOrder =
    | "active-required-available"
    | "active-available-required"
    | "required-active-available"
    | "required-available-active"
    | "available-active-required"
    | "available-required-active"
    | "definition";

/** Inline helper layout mode. */
export type InlineHelpLayout = "compact";

/** Dense-form argument description visibility mode. */
export type FormDescriptionMode = "inline" | "focused" | "hidden";

/** Dense-form footer instruction visibility mode. */
export type FormInstructionMode = "full" | "short" | "hidden";

/** Detailed help argument ordering. */
export type DetailedHelpOrder = "definition" | "required-first";

/** Metadata switches shared by inline and detailed help. */
export type HelpMetadataSettings = {
    types?: boolean;
    defaults?: boolean;
    required?: boolean;
    aliases?: boolean;
    descriptions?: boolean;
    enumValues?: boolean;
};

/** User-facing dense-form appearance settings from extension config. */
export type FormAppearanceSettings = {
    colors?: Partial<Record<FormAppearanceColorSlot, PiThemeColorName>>;
    symbols?: TypedCommandFormSymbols & { focusedField?: string };
    layout?: {
        leftPadding?: number;
        fieldGap?: number;
        minNameWidth?: number;
        maxNameWidth?: number;
        minValueWidth?: number;
        maxValueWidth?: number;
        descriptions?: FormDescriptionMode;
        instructions?: FormInstructionMode;
    };
};

/** User-facing inline-helper appearance settings from extension config. */
export type InlineHelpAppearanceSettings = {
    layout?: InlineHelpLayout;
    order?: InlineHelpOrder;
    metadata?: HelpMetadataSettings;
    colors?: Partial<Record<InlineHelpColorSlot, PiThemeColorName>>;
    format?: {
        tokenPrefix?: string;
        tokenSuffix?: string;
        groupSeparator?: string;
        itemSeparator?: string;
        typeSeparator?: string;
        valueSeparator?: string;
    };
};

/** User-facing detailed-help appearance settings from extension config. */
export type DetailedHelpAppearanceSettings = {
    metadata?: HelpMetadataSettings;
    order?: DetailedHelpOrder;
};

/** User-facing appearance settings accepted at appearance. */
export type PiTypedCommandsAppearanceSettings = {
    form?: FormAppearanceSettings;
    inlineHelp?: InlineHelpAppearanceSettings;
    detailedHelp?: DetailedHelpAppearanceSettings;
};

/** Resolved dense-form symbols after applying appearance defaults. */
export type ResolvedFormSymbols = Required<TypedCommandFormSymbols> & {
    focusedField: string;
};

/** Fully resolved dense-form appearance used by renderers. */
export type ResolvedFormAppearance = {
    colors: Record<FormAppearanceColorSlot, PiThemeColorName>;
    symbols: ResolvedFormSymbols;
    symbolOverrides: Partial<ResolvedFormSymbols>;
    layout: {
        leftPadding: number;
        fieldGap: number;
        minNameWidth: number;
        maxNameWidth: number;
        minValueWidth: number;
        maxValueWidth: number;
        descriptions: FormDescriptionMode;
        instructions: FormInstructionMode;
    };
};

/** Fully resolved inline-helper metadata switches. */
export type ResolvedHelpMetadata = Required<HelpMetadataSettings>;

/** Fully resolved inline-helper appearance used by renderers. */
export type ResolvedInlineHelpAppearance = {
    layout: InlineHelpLayout;
    order: InlineHelpOrder;
    metadata: ResolvedHelpMetadata;
    colors: Record<InlineHelpColorSlot, PiThemeColorName>;
    format: {
        tokenPrefix: string;
        tokenSuffix: string;
        groupSeparator: string;
        itemSeparator: string;
        typeSeparator: string;
        valueSeparator: string;
    };
};

/** Fully resolved detailed-help appearance used by --help renderers. */
export type ResolvedDetailedHelpAppearance = {
    metadata: ResolvedHelpMetadata;
    order: DetailedHelpOrder;
    configured: boolean;
};

/** Fully resolved global pi-typed-args appearance. */
export type ResolvedPiTypedCommandsAppearance = {
    form: ResolvedFormAppearance;
    inlineHelp: ResolvedInlineHelpAppearance;
    detailedHelp: ResolvedDetailedHelpAppearance;
};

const FORM_COLOR_SLOTS = [
    "title",
    "focusedLabel",
    "focusedValue",
    "unsetValue",
    "description",
    "instructions",
    "issue",
    "editorBorder",
    "selectedOption",
] as const satisfies readonly FormAppearanceColorSlot[];

const INLINE_HELP_COLOR_SLOTS = [
    "active",
    "required",
    "available",
    "type",
    "metadata",
    "issue",
] as const satisfies readonly InlineHelpColorSlot[];

const FORM_SYMBOL_KEYS = [
    "focusedField",
    "selectedCheckbox",
    "unselectedCheckbox",
    "selectedRadio",
    "unselectedRadio",
] as const satisfies readonly (keyof ResolvedFormSymbols)[];

const DEFAULT_FORM_COLORS: Record<FormAppearanceColorSlot, PiThemeColorName> = {
    title: "accent",
    focusedLabel: "accent",
    focusedValue: "accent",
    unsetValue: "muted",
    description: "dim",
    instructions: "dim",
    issue: "warning",
    editorBorder: "accent",
    selectedOption: "accent",
};

const DEFAULT_FORM_SYMBOLS: ResolvedFormSymbols = {
    focusedField: "›",
    selectedCheckbox: "■",
    unselectedCheckbox: "□",
    selectedRadio: "●",
    unselectedRadio: "○",
};

const DEFAULT_INLINE_HELP_COLORS: Record<InlineHelpColorSlot, PiThemeColorName> = {
    active: "accent",
    required: "warning",
    available: "dim",
    type: "syntaxType",
    metadata: "muted",
    issue: "error",
};

const DEFAULT_INLINE_METADATA: ResolvedHelpMetadata = {
    types: false,
    defaults: true,
    required: false,
    aliases: false,
    descriptions: false,
    enumValues: true,
};

const DEFAULT_DETAILED_METADATA: ResolvedHelpMetadata = {
    types: true,
    defaults: true,
    required: true,
    aliases: false,
    descriptions: true,
    enumValues: true,
};

/** Default global appearance that preserves legacy rendering when no settings are present. */
export const DEFAULT_PI_TYPED_COMMANDS_APPEARANCE: ResolvedPiTypedCommandsAppearance = {
    form: {
        colors: DEFAULT_FORM_COLORS,
        symbols: DEFAULT_FORM_SYMBOLS,
        symbolOverrides: {},
        layout: {
            leftPadding: 1,
            fieldGap: 1,
            minNameWidth: 12,
            maxNameWidth: 24,
            minValueWidth: 12,
            maxValueWidth: 32,
            descriptions: "inline",
            instructions: "full",
        },
    },
    inlineHelp: {
        layout: "compact",
        order: "active-required-available",
        metadata: DEFAULT_INLINE_METADATA,
        colors: DEFAULT_INLINE_HELP_COLORS,
        format: {
            tokenPrefix: "[",
            tokenSuffix: "]",
            groupSeparator: "  ",
            itemSeparator: " ",
            typeSeparator: ":",
            valueSeparator: "=",
        },
    },
    detailedHelp: {
        metadata: DEFAULT_DETAILED_METADATA,
        order: "definition",
        configured: false,
    },
};

const FormColorSettingsSchema = Type.Object(
    {
        title: Type.Optional(Type.Unknown()),
        focusedLabel: Type.Optional(Type.Unknown()),
        focusedValue: Type.Optional(Type.Unknown()),
        unsetValue: Type.Optional(Type.Unknown()),
        description: Type.Optional(Type.Unknown()),
        instructions: Type.Optional(Type.Unknown()),
        issue: Type.Optional(Type.Unknown()),
        editorBorder: Type.Optional(Type.Unknown()),
        selectedOption: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);

const FormSymbolSettingsSchema = Type.Object(
    {
        focusedField: Type.Optional(Type.Unknown()),
        selectedCheckbox: Type.Optional(Type.Unknown()),
        unselectedCheckbox: Type.Optional(Type.Unknown()),
        selectedRadio: Type.Optional(Type.Unknown()),
        unselectedRadio: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);

const FormLayoutSettingsSchema = Type.Object(
    {
        leftPadding: Type.Optional(Type.Unknown()),
        fieldGap: Type.Optional(Type.Unknown()),
        minNameWidth: Type.Optional(Type.Unknown()),
        maxNameWidth: Type.Optional(Type.Unknown()),
        minValueWidth: Type.Optional(Type.Unknown()),
        maxValueWidth: Type.Optional(Type.Unknown()),
        descriptions: Type.Optional(Type.Unknown()),
        instructions: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);

const FormAppearanceSettingsSchema = Type.Object(
    {
        colors: Type.Optional(Type.Unknown()),
        symbols: Type.Optional(Type.Unknown()),
        layout: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);

const HelpMetadataSettingsSchema = Type.Object(
    {
        types: Type.Optional(Type.Unknown()),
        defaults: Type.Optional(Type.Unknown()),
        required: Type.Optional(Type.Unknown()),
        aliases: Type.Optional(Type.Unknown()),
        descriptions: Type.Optional(Type.Unknown()),
        enumValues: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);

const InlineHelpColorSettingsSchema = Type.Object(
    {
        active: Type.Optional(Type.Unknown()),
        required: Type.Optional(Type.Unknown()),
        available: Type.Optional(Type.Unknown()),
        type: Type.Optional(Type.Unknown()),
        metadata: Type.Optional(Type.Unknown()),
        issue: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);

const InlineHelpFormatSettingsSchema = Type.Object(
    {
        tokenPrefix: Type.Optional(Type.Unknown()),
        tokenSuffix: Type.Optional(Type.Unknown()),
        groupSeparator: Type.Optional(Type.Unknown()),
        itemSeparator: Type.Optional(Type.Unknown()),
        typeSeparator: Type.Optional(Type.Unknown()),
        valueSeparator: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);

const InlineHelpAppearanceSettingsSchema = Type.Object(
    {
        layout: Type.Optional(Type.Unknown()),
        order: Type.Optional(Type.Unknown()),
        metadata: Type.Optional(Type.Unknown()),
        colors: Type.Optional(Type.Unknown()),
        format: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);

const DetailedHelpAppearanceSettingsSchema = Type.Object(
    {
        metadata: Type.Optional(Type.Unknown()),
        order: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);

export const PiTypedCommandsAppearanceSettingsSchema = Type.Object(
    {
        form: Type.Optional(Type.Unknown()),
        inlineHelp: Type.Optional(Type.Unknown()),
        detailedHelp: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);

function parseSchema(
    schema: typeof FormColorSettingsSchema,
    input: unknown,
): Static<typeof FormColorSettingsSchema> | undefined;
function parseSchema(
    schema: typeof FormSymbolSettingsSchema,
    input: unknown,
): Static<typeof FormSymbolSettingsSchema> | undefined;
function parseSchema(
    schema: typeof FormLayoutSettingsSchema,
    input: unknown,
): Static<typeof FormLayoutSettingsSchema> | undefined;
function parseSchema(
    schema: typeof FormAppearanceSettingsSchema,
    input: unknown,
): Static<typeof FormAppearanceSettingsSchema> | undefined;
function parseSchema(
    schema: typeof HelpMetadataSettingsSchema,
    input: unknown,
): Static<typeof HelpMetadataSettingsSchema> | undefined;
function parseSchema(
    schema: typeof InlineHelpColorSettingsSchema,
    input: unknown,
): Static<typeof InlineHelpColorSettingsSchema> | undefined;
function parseSchema(
    schema: typeof InlineHelpFormatSettingsSchema,
    input: unknown,
): Static<typeof InlineHelpFormatSettingsSchema> | undefined;
function parseSchema(
    schema: typeof InlineHelpAppearanceSettingsSchema,
    input: unknown,
): Static<typeof InlineHelpAppearanceSettingsSchema> | undefined;
function parseSchema(
    schema: typeof DetailedHelpAppearanceSettingsSchema,
    input: unknown,
): Static<typeof DetailedHelpAppearanceSettingsSchema> | undefined;
function parseSchema(
    schema: typeof PiTypedCommandsAppearanceSettingsSchema,
    input: unknown,
): Static<typeof PiTypedCommandsAppearanceSettingsSchema> | undefined;
function parseSchema(schema: TSchema, input: unknown): unknown {
    if (!Schema.Check(schema, input)) {
        return undefined;
    }
    return input;
}

function cloneDefaultAppearance(): ResolvedPiTypedCommandsAppearance {
    return {
        form: {
            colors: { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.form.colors },
            symbols: { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.form.symbols },
            symbolOverrides: {},
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
            configured: false,
        },
    };
}

function isOneOf<const TValue extends string>(
    allowed: readonly TValue[],
    value: string,
): value is TValue {
    return allowed.some((candidate) => candidate === value);
}

function parseThemeColor(value: unknown, fallback: PiThemeColorName): PiThemeColorName {
    if (typeof value === "string" && isOneOf(PI_THEME_COLOR_NAMES, value)) {
        return value;
    }
    return fallback;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") {
        return value;
    }
    return fallback;
}

function parseBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    const integer = Math.floor(value);
    if (integer < min || integer > max) {
        return fallback;
    }
    return integer;
}

function parseDisplayString(value: unknown, fallback: string, allowEmpty = false): string {
    if (typeof value !== "string") {
        return fallback;
    }
    if (!allowEmpty && value.length === 0) {
        return fallback;
    }
    if (/\r|\n/.test(value)) {
        return fallback;
    }
    return value;
}

function parseOptionalDisplayString(value: unknown, allowEmpty = false): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    if (!allowEmpty && value.length === 0) {
        return undefined;
    }
    if (/\r|\n/.test(value)) {
        return undefined;
    }
    return value;
}

function parseEnum<const TValue extends string>(
    value: unknown,
    fallback: TValue,
    allowed: readonly TValue[],
): TValue {
    if (typeof value === "string" && isOneOf(allowed, value)) {
        return value;
    }
    return fallback;
}

function mergeMetadata(input: unknown, defaults: ResolvedHelpMetadata): ResolvedHelpMetadata {
    const settings = parseSchema(HelpMetadataSettingsSchema, input);
    if (settings === undefined) {
        return { ...defaults };
    }
    return {
        types: parseBoolean(settings.types, defaults.types),
        defaults: parseBoolean(settings.defaults, defaults.defaults),
        required: parseBoolean(settings.required, defaults.required),
        aliases: parseBoolean(settings.aliases, defaults.aliases),
        descriptions: parseBoolean(settings.descriptions, defaults.descriptions),
        enumValues: parseBoolean(settings.enumValues, defaults.enumValues),
    };
}

function parseFormColors(input: unknown): Record<FormAppearanceColorSlot, PiThemeColorName> {
    const colors = { ...DEFAULT_FORM_COLORS };
    const settings = parseSchema(FormColorSettingsSchema, input);
    if (settings === undefined) {
        return colors;
    }
    for (const key of FORM_COLOR_SLOTS) {
        colors[key] = parseThemeColor(settings[key], colors[key]);
    }
    return colors;
}

function parseInlineHelpColors(input: unknown): Record<InlineHelpColorSlot, PiThemeColorName> {
    const colors = { ...DEFAULT_INLINE_HELP_COLORS };
    const settings = parseSchema(InlineHelpColorSettingsSchema, input);
    if (settings === undefined) {
        return colors;
    }
    for (const key of INLINE_HELP_COLOR_SLOTS) {
        colors[key] = parseThemeColor(settings[key], colors[key]);
    }
    return colors;
}

function parseFormSymbolOverrides(input: unknown): Partial<ResolvedFormSymbols> {
    const settings = parseSchema(FormSymbolSettingsSchema, input);
    if (settings === undefined) {
        return {};
    }

    const overrides: Partial<ResolvedFormSymbols> = {};
    for (const key of FORM_SYMBOL_KEYS) {
        const parsed = parseOptionalDisplayString(settings[key]);
        if (parsed !== undefined) {
            overrides[key] = parsed;
        }
    }
    return overrides;
}

function parseFormLayout(input: unknown): ResolvedFormAppearance["layout"] {
    const layout = { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.form.layout };
    const settings = parseSchema(FormLayoutSettingsSchema, input);
    if (settings === undefined) {
        return layout;
    }

    const descriptionModes = ["inline", "focused", "hidden"] as const;
    const instructionModes = ["full", "short", "hidden"] as const;
    layout.leftPadding = parseBoundedInteger(settings.leftPadding, layout.leftPadding, 0, 12);
    layout.fieldGap = parseBoundedInteger(settings.fieldGap, layout.fieldGap, 0, 12);
    layout.minNameWidth = parseBoundedInteger(settings.minNameWidth, layout.minNameWidth, 1, 80);
    layout.maxNameWidth = parseBoundedInteger(settings.maxNameWidth, layout.maxNameWidth, 1, 120);
    layout.minValueWidth = parseBoundedInteger(settings.minValueWidth, layout.minValueWidth, 1, 80);
    layout.maxValueWidth = parseBoundedInteger(
        settings.maxValueWidth,
        layout.maxValueWidth,
        1,
        120,
    );
    layout.descriptions = parseEnum(settings.descriptions, layout.descriptions, descriptionModes);
    layout.instructions = parseEnum(settings.instructions, layout.instructions, instructionModes);

    if (layout.maxNameWidth < layout.minNameWidth) {
        layout.maxNameWidth = layout.minNameWidth;
    }
    if (layout.maxValueWidth < layout.minValueWidth) {
        layout.maxValueWidth = layout.minValueWidth;
    }
    return layout;
}

function parseInlineHelpOrder(value: unknown): InlineHelpOrder {
    const orders = [
        "active-required-available",
        "active-available-required",
        "required-active-available",
        "required-available-active",
        "available-active-required",
        "available-required-active",
        "definition",
    ] as const;
    return parseEnum(value, DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp.order, orders);
}

function parseInlineHelpFormat(input: unknown): ResolvedInlineHelpAppearance["format"] {
    const format = { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp.format };
    const settings = parseSchema(InlineHelpFormatSettingsSchema, input);
    if (settings === undefined) {
        return format;
    }

    format.tokenPrefix = parseDisplayString(settings.tokenPrefix, format.tokenPrefix, true);
    format.tokenSuffix = parseDisplayString(settings.tokenSuffix, format.tokenSuffix, true);
    format.groupSeparator = parseDisplayString(
        settings.groupSeparator,
        format.groupSeparator,
        true,
    );
    format.itemSeparator = parseDisplayString(settings.itemSeparator, format.itemSeparator, true);
    format.typeSeparator = parseDisplayString(settings.typeSeparator, format.typeSeparator, true);
    format.valueSeparator = parseDisplayString(
        settings.valueSeparator,
        format.valueSeparator,
        true,
    );
    return format;
}

function parseFormAppearance(input: unknown): ResolvedFormAppearance {
    let colors = parseFormColors(undefined);
    let symbolOverrides: Partial<ResolvedFormSymbols> = {};
    let layout = parseFormLayout(undefined);
    const settings = parseSchema(FormAppearanceSettingsSchema, input);
    if (settings !== undefined) {
        colors = parseFormColors(settings.colors);
        symbolOverrides = parseFormSymbolOverrides(settings.symbols);
        layout = parseFormLayout(settings.layout);
    }
    return {
        colors,
        symbols: { ...DEFAULT_FORM_SYMBOLS, ...symbolOverrides },
        symbolOverrides,
        layout,
    };
}

function parseInlineHelpAppearance(input: unknown): ResolvedInlineHelpAppearance {
    const layoutModes = ["compact"] as const;
    const defaults = DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp;
    const settings = parseSchema(InlineHelpAppearanceSettingsSchema, input);
    if (settings === undefined) {
        return {
            layout: defaults.layout,
            order: defaults.order,
            metadata: { ...defaults.metadata },
            colors: { ...defaults.colors },
            format: { ...defaults.format },
        };
    }

    return {
        layout: parseEnum(settings.layout, defaults.layout, layoutModes),
        order: parseInlineHelpOrder(settings.order),
        metadata: mergeMetadata(settings.metadata, DEFAULT_INLINE_METADATA),
        colors: parseInlineHelpColors(settings.colors),
        format: parseInlineHelpFormat(settings.format),
    };
}

function parseDetailedHelpAppearance(input: unknown): ResolvedDetailedHelpAppearance {
    const orderModes = ["definition", "required-first"] as const;
    const settings = parseSchema(DetailedHelpAppearanceSettingsSchema, input);
    if (settings === undefined) {
        return {
            metadata: { ...DEFAULT_DETAILED_METADATA },
            order: DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.detailedHelp.order,
            configured: false,
        };
    }
    return {
        metadata: mergeMetadata(settings.metadata, DEFAULT_DETAILED_METADATA),
        order: parseEnum(
            settings.order,
            DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.detailedHelp.order,
            orderModes,
        ),
        configured: true,
    };
}

/** Resolve appearance from a configuration value already parsed at the persisted-config seam. */
export function resolvePiTypedCommandsAppearance(
    input: PiTypedCommandsAppearanceConfig | undefined,
): ResolvedPiTypedCommandsAppearance {
    const settings = parseSchema(PiTypedCommandsAppearanceSettingsSchema, input);
    if (settings === undefined) {
        return cloneDefaultAppearance();
    }

    return {
        form: parseFormAppearance(settings.form),
        inlineHelp: parseInlineHelpAppearance(settings.inlineHelp),
        detailedHelp: parseDetailedHelpAppearance(settings.detailedHelp),
    };
}
