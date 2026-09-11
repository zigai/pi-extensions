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

/** How fixed enum choices are presented in inline help. */
export type InlineHelpChoiceDisplay = "contextual" | "inline";

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
    choiceDisplay?: InlineHelpChoiceDisplay;
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
    choiceDisplay: InlineHelpChoiceDisplay;
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

const FORM_SYMBOL_KEYS = [
    "focusedField",
    "selectedCheckbox",
    "unselectedCheckbox",
    "selectedRadio",
    "unselectedRadio",
] as const satisfies readonly (keyof ResolvedFormSymbols)[];

const DEFAULT_FORM_COLORS = {
    title: "accent",
    focusedLabel: "accent",
    focusedValue: "accent",
    unsetValue: "muted",
    description: "dim",
    instructions: "dim",
    issue: "warning",
    editorBorder: "accent",
    selectedOption: "accent",
} satisfies Record<FormAppearanceColorSlot, PiThemeColorName>;

const DEFAULT_FORM_SYMBOLS: ResolvedFormSymbols = {
    focusedField: "›",
    selectedCheckbox: "■",
    unselectedCheckbox: "□",
    selectedRadio: "●",
    unselectedRadio: "○",
};

const DEFAULT_INLINE_HELP_COLORS = {
    active: "accent",
    required: "warning",
    available: "dim",
    type: "syntaxType",
    metadata: "muted",
    issue: "error",
} satisfies Record<InlineHelpColorSlot, PiThemeColorName>;

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
        choiceDisplay: "contextual",
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
            choiceDisplay: DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp.choiceDisplay,
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

function mergeMetadata(
    settings: HelpMetadataSettings | undefined,
    defaults: ResolvedHelpMetadata,
): ResolvedHelpMetadata {
    if (settings === undefined) {
        return { ...defaults };
    }

    return {
        types: settings.types ?? defaults.types,
        defaults: settings.defaults ?? defaults.defaults,
        required: settings.required ?? defaults.required,
        aliases: settings.aliases ?? defaults.aliases,
        descriptions: settings.descriptions ?? defaults.descriptions,
        enumValues: settings.enumValues ?? defaults.enumValues,
    };
}

function parseFormColors(
    settings: FormAppearanceSettings["colors"] | undefined,
): ResolvedFormAppearance["colors"] {
    return {
        title: settings?.title ?? DEFAULT_FORM_COLORS.title,
        focusedLabel: settings?.focusedLabel ?? DEFAULT_FORM_COLORS.focusedLabel,
        focusedValue: settings?.focusedValue ?? DEFAULT_FORM_COLORS.focusedValue,
        unsetValue: settings?.unsetValue ?? DEFAULT_FORM_COLORS.unsetValue,
        description: settings?.description ?? DEFAULT_FORM_COLORS.description,
        instructions: settings?.instructions ?? DEFAULT_FORM_COLORS.instructions,
        issue: settings?.issue ?? DEFAULT_FORM_COLORS.issue,
        editorBorder: settings?.editorBorder ?? DEFAULT_FORM_COLORS.editorBorder,
        selectedOption: settings?.selectedOption ?? DEFAULT_FORM_COLORS.selectedOption,
    };
}

function parseInlineHelpColors(
    settings: InlineHelpAppearanceSettings["colors"] | undefined,
): ResolvedInlineHelpAppearance["colors"] {
    return {
        active: settings?.active ?? DEFAULT_INLINE_HELP_COLORS.active,
        required: settings?.required ?? DEFAULT_INLINE_HELP_COLORS.required,
        available: settings?.available ?? DEFAULT_INLINE_HELP_COLORS.available,
        type: settings?.type ?? DEFAULT_INLINE_HELP_COLORS.type,
        metadata: settings?.metadata ?? DEFAULT_INLINE_HELP_COLORS.metadata,
        issue: settings?.issue ?? DEFAULT_INLINE_HELP_COLORS.issue,
    };
}

function parseFormSymbolOverrides(
    settings: FormAppearanceSettings["symbols"] | undefined,
): Partial<ResolvedFormSymbols> {
    if (settings === undefined) {
        return {};
    }

    const overrides: Partial<ResolvedFormSymbols> = {};
    for (const key of FORM_SYMBOL_KEYS) {
        const value = settings[key];
        if (value !== undefined) {
            overrides[key] = value;
        }
    }

    return overrides;
}

function parseFormLayout(
    settings: FormAppearanceSettings["layout"] | undefined,
): ResolvedFormAppearance["layout"] {
    const layout = { ...DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.form.layout };
    if (settings === undefined) {
        return layout;
    }

    layout.leftPadding = settings.leftPadding ?? layout.leftPadding;
    layout.fieldGap = settings.fieldGap ?? layout.fieldGap;
    layout.minNameWidth = settings.minNameWidth ?? layout.minNameWidth;
    layout.maxNameWidth = settings.maxNameWidth ?? layout.maxNameWidth;
    layout.minValueWidth = settings.minValueWidth ?? layout.minValueWidth;
    layout.maxValueWidth = settings.maxValueWidth ?? layout.maxValueWidth;
    layout.descriptions = settings.descriptions ?? layout.descriptions;
    layout.instructions = settings.instructions ?? layout.instructions;
    if (layout.maxNameWidth < layout.minNameWidth) {
        layout.maxNameWidth = layout.minNameWidth;
    }

    if (layout.maxValueWidth < layout.minValueWidth) {
        layout.maxValueWidth = layout.minValueWidth;
    }

    return layout;
}

function parseInlineHelpFormat(
    settings: InlineHelpAppearanceSettings["format"] | undefined,
): ResolvedInlineHelpAppearance["format"] {
    const defaults = DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp.format;

    return {
        tokenPrefix: settings?.tokenPrefix ?? defaults.tokenPrefix,
        tokenSuffix: settings?.tokenSuffix ?? defaults.tokenSuffix,
        groupSeparator: settings?.groupSeparator ?? defaults.groupSeparator,
        itemSeparator: settings?.itemSeparator ?? defaults.itemSeparator,
        typeSeparator: settings?.typeSeparator ?? defaults.typeSeparator,
        valueSeparator: settings?.valueSeparator ?? defaults.valueSeparator,
    };
}

function parseFormAppearance(settings: FormAppearanceSettings | undefined): ResolvedFormAppearance {
    const colors = parseFormColors(settings?.colors);
    const symbolOverrides = parseFormSymbolOverrides(settings?.symbols);
    const layout = parseFormLayout(settings?.layout);
    return {
        colors,
        symbols: { ...DEFAULT_FORM_SYMBOLS, ...symbolOverrides },
        symbolOverrides,
        layout,
    };
}

function parseInlineHelpAppearance(
    settings: InlineHelpAppearanceSettings | undefined,
): ResolvedInlineHelpAppearance {
    const defaults = DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp;
    if (settings === undefined) {
        return {
            layout: defaults.layout,
            choiceDisplay: defaults.choiceDisplay,
            order: defaults.order,
            metadata: { ...defaults.metadata },
            colors: { ...defaults.colors },
            format: { ...defaults.format },
        };
    }

    return {
        layout: settings.layout ?? defaults.layout,
        choiceDisplay: settings.choiceDisplay ?? defaults.choiceDisplay,
        order: settings.order ?? defaults.order,
        metadata: mergeMetadata(settings.metadata, DEFAULT_INLINE_METADATA),
        colors: parseInlineHelpColors(settings.colors),
        format: parseInlineHelpFormat(settings.format),
    };
}

function parseDetailedHelpAppearance(
    settings: DetailedHelpAppearanceSettings | undefined,
): ResolvedDetailedHelpAppearance {
    if (settings === undefined) {
        return {
            metadata: { ...DEFAULT_DETAILED_METADATA },
            order: DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.detailedHelp.order,
            configured: false,
        };
    }

    return {
        metadata: mergeMetadata(settings.metadata, DEFAULT_DETAILED_METADATA),
        order: settings.order ?? DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.detailedHelp.order,
        configured: true,
    };
}

/** Resolve appearance from a configuration value already parsed at the persisted-config seam. */
export function resolvePiTypedCommandsAppearance(
    input: PiTypedCommandsAppearanceConfig | undefined,
): ResolvedPiTypedCommandsAppearance {
    if (input === undefined) {
        return cloneDefaultAppearance();
    }

    return {
        form: parseFormAppearance(input.form),
        inlineHelp: parseInlineHelpAppearance(input.inlineHelp),
        detailedHelp: parseDetailedHelpAppearance(input.detailedHelp),
    };
}
