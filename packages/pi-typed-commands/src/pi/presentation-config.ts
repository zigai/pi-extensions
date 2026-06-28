import type { TypedCommandFormSymbols } from "../types.js";

/** Pi TUI theme colour roles accepted by pi-typed-commands appearance settings. */
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

/** User-facing dense-form appearance settings from Pi global settings. */
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

/** User-facing inline-helper appearance settings from Pi global settings. */
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

/** User-facing detailed-help appearance settings from Pi global settings. */
export type DetailedHelpAppearanceSettings = {
    metadata?: HelpMetadataSettings;
    order?: DetailedHelpOrder;
};

/** User-facing global appearance settings accepted at piTypedCommands.appearance. */
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

/** Fully resolved global pi-typed-commands appearance. */
export type ResolvedPiTypedCommandsAppearance = {
    form: ResolvedFormAppearance;
    inlineHelp: ResolvedInlineHelpAppearance;
    detailedHelp: ResolvedDetailedHelpAppearance;
};

const THEME_COLOR_NAMES = new Set<string>(PI_THEME_COLOR_NAMES);

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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parseThemeColor(value: unknown, fallback: PiThemeColorName): PiThemeColorName {
    if (typeof value === "string" && THEME_COLOR_NAMES.has(value)) {
        return value as PiThemeColorName;
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

function parseEnum<TValue extends string>(
    value: unknown,
    fallback: TValue,
    allowed: ReadonlySet<TValue>,
): TValue {
    if (typeof value === "string" && allowed.has(value as TValue)) {
        return value as TValue;
    }
    return fallback;
}

function mergeMetadata(input: unknown, defaults: ResolvedHelpMetadata): ResolvedHelpMetadata {
    if (!isRecord(input)) {
        return { ...defaults };
    }
    return {
        types: parseBoolean(input.types, defaults.types),
        defaults: parseBoolean(input.defaults, defaults.defaults),
        required: parseBoolean(input.required, defaults.required),
        aliases: parseBoolean(input.aliases, defaults.aliases),
        descriptions: parseBoolean(input.descriptions, defaults.descriptions),
        enumValues: parseBoolean(input.enumValues, defaults.enumValues),
    };
}

function parseFormColors(input: unknown): Record<FormAppearanceColorSlot, PiThemeColorName> {
    const colors = { ...DEFAULT_FORM_COLORS };
    if (!isRecord(input)) {
        return colors;
    }
    for (const key of Object.keys(colors) as FormAppearanceColorSlot[]) {
        colors[key] = parseThemeColor(input[key], colors[key]);
    }
    return colors;
}

function parseInlineHelpColors(input: unknown): Record<InlineHelpColorSlot, PiThemeColorName> {
    const colors = { ...DEFAULT_INLINE_HELP_COLORS };
    if (!isRecord(input)) {
        return colors;
    }
    for (const key of Object.keys(colors) as InlineHelpColorSlot[]) {
        colors[key] = parseThemeColor(input[key], colors[key]);
    }
    return colors;
}

function parseFormSymbolOverrides(input: unknown): Partial<ResolvedFormSymbols> {
    if (!isRecord(input)) {
        return {};
    }

    const overrides: Partial<ResolvedFormSymbols> = {};
    for (const key of Object.keys(DEFAULT_FORM_SYMBOLS) as Array<keyof ResolvedFormSymbols>) {
        if (!(key in input)) {
            continue;
        }
        const parsed = parseOptionalDisplayString(input[key]);
        if (parsed !== undefined) {
            overrides[key] = parsed;
        }
    }
    return overrides;
}

function parseFormLayout(input: unknown): ResolvedFormAppearance["layout"] {
    const layout = { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.form.layout };
    if (!isRecord(input)) {
        return layout;
    }

    const descriptionModes = new Set<FormDescriptionMode>(["inline", "focused", "hidden"]);
    const instructionModes = new Set<FormInstructionMode>(["full", "short", "hidden"]);
    layout.leftPadding = parseBoundedInteger(input.leftPadding, layout.leftPadding, 0, 12);
    layout.fieldGap = parseBoundedInteger(input.fieldGap, layout.fieldGap, 0, 12);
    layout.minNameWidth = parseBoundedInteger(input.minNameWidth, layout.minNameWidth, 1, 80);
    layout.maxNameWidth = parseBoundedInteger(input.maxNameWidth, layout.maxNameWidth, 1, 120);
    layout.minValueWidth = parseBoundedInteger(input.minValueWidth, layout.minValueWidth, 1, 80);
    layout.maxValueWidth = parseBoundedInteger(input.maxValueWidth, layout.maxValueWidth, 1, 120);
    layout.descriptions = parseEnum(input.descriptions, layout.descriptions, descriptionModes);
    layout.instructions = parseEnum(input.instructions, layout.instructions, instructionModes);

    if (layout.maxNameWidth < layout.minNameWidth) {
        layout.maxNameWidth = layout.minNameWidth;
    }
    if (layout.maxValueWidth < layout.minValueWidth) {
        layout.maxValueWidth = layout.minValueWidth;
    }
    return layout;
}

function parseInlineHelpOrder(value: unknown): InlineHelpOrder {
    const orders = new Set<InlineHelpOrder>([
        "active-required-available",
        "active-available-required",
        "required-active-available",
        "required-available-active",
        "available-active-required",
        "available-required-active",
        "definition",
    ]);
    return parseEnum(value, DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp.order, orders);
}

function parseInlineHelpFormat(input: unknown): ResolvedInlineHelpAppearance["format"] {
    const format = { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp.format };
    if (!isRecord(input)) {
        return format;
    }

    format.tokenPrefix = parseDisplayString(input.tokenPrefix, format.tokenPrefix, true);
    format.tokenSuffix = parseDisplayString(input.tokenSuffix, format.tokenSuffix, true);
    format.groupSeparator = parseDisplayString(input.groupSeparator, format.groupSeparator, true);
    format.itemSeparator = parseDisplayString(input.itemSeparator, format.itemSeparator, true);
    format.typeSeparator = parseDisplayString(input.typeSeparator, format.typeSeparator, true);
    format.valueSeparator = parseDisplayString(input.valueSeparator, format.valueSeparator, true);
    return format;
}

function parseFormAppearance(input: unknown): ResolvedFormAppearance {
    let colors = parseFormColors(undefined);
    let symbolOverrides: Partial<ResolvedFormSymbols> = {};
    let layout = parseFormLayout(undefined);
    if (isRecord(input)) {
        colors = parseFormColors(input.colors);
        symbolOverrides = parseFormSymbolOverrides(input.symbols);
        layout = parseFormLayout(input.layout);
    }
    return {
        colors,
        symbols: { ...DEFAULT_FORM_SYMBOLS, ...symbolOverrides },
        symbolOverrides,
        layout,
    };
}

function parseInlineHelpAppearance(input: unknown): ResolvedInlineHelpAppearance {
    const layoutModes = new Set<InlineHelpLayout>(["compact"]);
    const defaults = DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp;
    if (!isRecord(input)) {
        return {
            layout: defaults.layout,
            order: defaults.order,
            metadata: { ...defaults.metadata },
            colors: { ...defaults.colors },
            format: { ...defaults.format },
        };
    }

    return {
        layout: parseEnum(input.layout, defaults.layout, layoutModes),
        order: parseInlineHelpOrder(input.order),
        metadata: mergeMetadata(input.metadata, DEFAULT_INLINE_METADATA),
        colors: parseInlineHelpColors(input.colors),
        format: parseInlineHelpFormat(input.format),
    };
}

function parseDetailedHelpAppearance(input: unknown): ResolvedDetailedHelpAppearance {
    const orderModes = new Set<DetailedHelpOrder>(["definition", "required-first"]);
    if (!isRecord(input)) {
        return {
            metadata: { ...DEFAULT_DETAILED_METADATA },
            order: DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.detailedHelp.order,
            configured: false,
        };
    }
    return {
        metadata: mergeMetadata(input.metadata, DEFAULT_DETAILED_METADATA),
        order: parseEnum(
            input.order,
            DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.detailedHelp.order,
            orderModes,
        ),
        configured: true,
    };
}

/** Parse and normalize piTypedCommands.appearance from unknown Pi settings input. */
export function parsePiTypedCommandsAppearance(input: unknown): ResolvedPiTypedCommandsAppearance {
    if (!isRecord(input)) {
        return cloneDefaultAppearance();
    }

    return {
        form: parseFormAppearance(input.form),
        inlineHelp: parseInlineHelpAppearance(input.inlineHelp),
        detailedHelp: parseDetailedHelpAppearance(input.detailedHelp),
    };
}

/** Extract and parse global piTypedCommands.appearance from a settings object. */
export function parsePiTypedCommandsAppearanceFromSettings(
    settings: unknown,
): ResolvedPiTypedCommandsAppearance {
    if (!isRecord(settings)) {
        return cloneDefaultAppearance();
    }
    const typedCommands = settings.piTypedCommands;
    if (!isRecord(typedCommands)) {
        return cloneDefaultAppearance();
    }
    return parsePiTypedCommandsAppearance(typedCommands.appearance);
}
