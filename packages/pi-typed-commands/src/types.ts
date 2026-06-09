import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Built-in dense-form widget names for typed command arguments.
 *
 * Omit `ui.widget` to let pi-command-args choose a widget from the argument type.
 */
export type ArgumentWidget =
    | "text"
    | "textarea"
    | "number"
    | "toggle"
    | "select"
    | "radio"
    | "multiselect"
    | "path"
    | "command"
    | "readonly"
    | "computed"
    | "confirm"
    | "custom";

export type PrimitiveArgumentValue = string | number | boolean;
export type MultiArgumentValue = string[];
export type ConcreteArgumentValue = PrimitiveArgumentValue | MultiArgumentValue;

/** Parsed, defaulted, or form-collected argument value; `undefined` means unset. */
export type ArgumentValue = ConcreteArgumentValue | undefined;

/** Theme helpers passed to custom dense-form widget renderers. */
export type ArgumentWidgetTheme = {
    bold(text: string): string;
    /** Render text with a named Pi TUI colour such as `accent`, `muted`, or `warning`. */
    fg(color: string, text: string): string;
};

/** Context passed to a custom dense-form widget renderer. */
export type ArgumentWidgetRenderContext = {
    name: string;
    definition: ArgumentDefinition;
    value: ArgumentValue;
    selected: boolean;
    width: number;
    theme: ArgumentWidgetTheme;
    /** Format an argument value the same way built-in widgets do. */
    formatValue(value: ArgumentValue): string;
};

/** Context passed to a custom dense-form widget input handler. */
export type ArgumentWidgetInputContext = {
    name: string;
    definition: ArgumentDefinition;
    value: ArgumentValue;
    /** Raw terminal input sequence. */
    data: string;
    setValue(value: ArgumentValue): void;
};

/** Renderer and input hooks for a `custom` dense-form widget. */
export type CustomArgumentWidget = {
    /** Render the value cell. Return unpadded terminal text. */
    renderValue?: (ctx: ArgumentWidgetRenderContext) => string;
    /**
     * Handle terminal input for this field.
     *
     * Return `true` when the input was consumed; return `false` or `undefined` to let the form
     * handle it normally.
     */
    handleInput?: (ctx: ArgumentWidgetInputContext) => boolean | void;
};

/** Dense-form presentation options for a single argument. */
export type ArgumentUi = {
    widget?: ArgumentWidget;
    /** Preferred row count for multiline widgets such as `textarea` and `command`. */
    rows?: number;
    /** Optional field title for future renderers; currently the argument name is shown. */
    title?: string;
    custom?: CustomArgumentWidget;
};

/** Shared fields accepted by every argument definition. */
export type BaseArgumentDefinition<TValue extends ConcreteArgumentValue> = {
    description?: string;
    required?: boolean;
    default?: TValue;
    /** Additional flag names accepted by the parser, such as `"f"` for `-f`. */
    aliases?: readonly string[];
    /** Value hint shown in usage text and forms. */
    placeholder?: string;
    /**
     * Parse this argument positionally instead of as a named flag.
     *
     * Use `true` for declaration order or a number for explicit positional order.
     */
    positional?: boolean | number;
    ui?: ArgumentUi;
};

export type StringArgumentDefinition = BaseArgumentDefinition<string> & {
    type: "string";
};

/** Numeric argument definition, optionally constrained to integers or a range. */
export type NumberArgumentDefinition = BaseArgumentDefinition<number> & {
    type: "number";
    /** Require `Number.isInteger(value)`. */
    integer?: boolean;
    /** Minimum allowed value, inclusive. */
    min?: number;
    /** Maximum allowed value, inclusive. */
    max?: number;
};

/** Boolean flag definition supporting `--flag`, `--flag true`, and `--no-flag`. */
export type BooleanArgumentDefinition = BaseArgumentDefinition<boolean> & {
    type: "boolean";
};

export type EnumArgumentDefinition<TValues extends readonly string[] = readonly string[]> =
    BaseArgumentDefinition<TValues[number]> & {
        type: "enum";
        /** Allowed string values. Use `as const` to preserve literal inference. */
        values: TValues;
    };

/** Multi-choice string argument definition parsed from repeated or comma-separated flags. */
export type MultiEnumArgumentDefinition<TValues extends readonly string[] = readonly string[]> =
    BaseArgumentDefinition<Array<TValues[number]>> & {
        type: "multi-enum";
        /** Allowed string values. Use `as const` to preserve literal inference. */
        values: TValues;
    };

export type ArgumentDefinition =
    | StringArgumentDefinition
    | NumberArgumentDefinition
    | BooleanArgumentDefinition
    | EnumArgumentDefinition
    | MultiEnumArgumentDefinition;

export type ArgumentDefinitions = Record<string, ArgumentDefinition>;

type HasDefault<TDefinition> = TDefinition extends { default: ConcreteArgumentValue }
    ? true
    : false;
type IsRequired<TDefinition> = TDefinition extends { required: true } ? true : false;

type BaseValue<TDefinition> = TDefinition extends StringArgumentDefinition
    ? string
    : TDefinition extends NumberArgumentDefinition
      ? number
      : TDefinition extends BooleanArgumentDefinition
        ? boolean
        : TDefinition extends EnumArgumentDefinition<infer TValues>
          ? TValues[number]
          : TDefinition extends MultiEnumArgumentDefinition<infer TValues>
            ? Array<TValues[number]>
            : never;

type MaybeOptional<TDefinition, TValue> =
    IsRequired<TDefinition> extends true
        ? TValue
        : HasDefault<TDefinition> extends true
          ? TValue
          : TValue | undefined;

/** Infer the handler value type for one argument definition. */
export type InferArgumentValue<TDefinition> = MaybeOptional<TDefinition, BaseValue<TDefinition>>;

/** Infer the typed handler argument object for a command's `args` definition map. */
export type InferArguments<TDefinitions extends ArgumentDefinitions> = {
    [TKey in keyof TDefinitions]: InferArgumentValue<TDefinitions[TKey]>;
};

/** Handler called after typed arguments have been parsed, defaulted, and validated. */
export type TypedCommandHandler<TDefinitions extends ArgumentDefinitions> = (
    args: InferArguments<TDefinitions>,
    ctx: ExtensionCommandContext,
) => Promise<void> | void;

/** Handler called with Pi's raw argument string when typed parsing is disabled or bypassed. */
export type RawCommandHandler = (
    args: string,
    ctx: ExtensionCommandContext,
) => Promise<void> | void;

/** Boolean or callback used to enable typed args globally, for UX, or per command. */
export type TypedCommandToggle = boolean | ((ctx?: ExtensionContext) => boolean);

/** Decide per invocation whether raw args should be parsed as typed args. */
export type TypedCommandRawSelector = (rawArgs: string, ctx: ExtensionCommandContext) => boolean;

/** Dense-form title, or a callback that derives one from the command context. */
export type TypedCommandFormTitle = string | ((ctx: ExtensionCommandContext) => string);

/** @deprecated Use TypedCommandFormTitle. */
export type TypedCommandWizardTitle = TypedCommandFormTitle;

/** Glyphs used for checkbox and radio widgets in the dense form. */
export type TypedCommandFormSymbols = {
    selectedCheckbox?: string;
    unselectedCheckbox?: string;
    selectedRadio?: string;
    unselectedRadio?: string;
};

/** Options passed to `registerTypedCommand`. */
export type TypedCommandOptions<TDefinitions extends ArgumentDefinitions> = {
    description: string;
    args: TDefinitions;
    handler: TypedCommandHandler<TDefinitions>;
    /** Optional raw fallback handler used when typed args are disabled or bypassed. */
    fallbackHandler?: RawCommandHandler;
    /** Enable or disable typed parsing, completions, forms, and helper UX for this command. */
    typedArgsEnabled?: TypedCommandToggle;
    /** Return `false` to bypass typed parsing for a specific raw invocation. */
    shouldUseTypedArgs?: TypedCommandRawSelector;
    /** Token that opens the full argument form, defaults to `?`. */
    manualFormToken?: string;
    /** @deprecated Use manualFormToken. */
    manualWizardToken?: string;
    /** Token that shows detailed help, defaults to `??`; `--help` and `-h` also work. */
    helpToken?: string;
    /** Title shown at the top of the dense argument form. */
    formTitle?: TypedCommandFormTitle;
    /** @deprecated Use formTitle. */
    wizardTitle?: TypedCommandWizardTitle;
    /** Override checkbox and radio glyphs in the dense form. */
    formSymbols?: TypedCommandFormSymbols;
    /** Open the argument form automatically when provided arguments are invalid. */
    openFormWhenInvalid?: boolean;
    /** @deprecated Use openFormWhenInvalid. */
    openWizardWhenInvalid?: boolean;
    /** Open the argument form automatically when required arguments are missing. */
    openFormWhenMissingRequired?: boolean;
    /** @deprecated Use openFormWhenMissingRequired. */
    openWizardWhenMissingRequired?: boolean;
};

/** Normalized command metadata stored in the typed command registry. */
export type RegisteredTypedCommand<TDefinitions extends ArgumentDefinitions = ArgumentDefinitions> =
    TypedCommandOptions<TDefinitions> & {
        /** Slash command name without the leading `/`. */
        name: string;
        typedArgsEnabled: TypedCommandToggle;
        manualFormToken: string;
        /** @deprecated Use manualFormToken. */
        manualWizardToken: string;
        helpToken: string;
        formSymbols: Required<TypedCommandFormSymbols>;
        openFormWhenInvalid: boolean;
        /** @deprecated Use openFormWhenInvalid. */
        openWizardWhenInvalid: boolean;
        openFormWhenMissingRequired: boolean;
        /** @deprecated Use openFormWhenMissingRequired. */
        openWizardWhenMissingRequired: boolean;
    };

export type ParseIssueKind =
    | "invalid-value"
    | "missing-required"
    | "missing-value"
    | "unknown-argument"
    | "unexpected-positional"
    | "unterminated-quote";

/** One parser validation or syntax issue. */
export type ParseIssue = {
    kind: ParseIssueKind;
    message: string;
    name?: string;
    token?: string;
};

/** Result returned by `parseTypedCommandArgs`. */
export type ParsedCommandArguments = {
    /** Parsed values plus defaults that could be applied without prompting. */
    values: Record<string, ArgumentValue>;
    /** Argument names explicitly provided by the user. */
    provided: Set<string>;
    issues: ParseIssue[];
    /** Requested action: run handler, open form, or show help. */
    mode: "run" | "form" | "wizard" | "help";
};

/** Which fields the argument form should show. */
export type FormMode = "missing" | "all";

/** @deprecated Use FormMode. */
export type WizardMode = FormMode;
