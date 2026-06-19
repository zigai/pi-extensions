import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Built-in dense-form widget names for typed command arguments.
 *
 * Omit `ui.widget` to let pi-typed-commands choose a widget from the argument type.
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

/** Scalar value produced by string, number, boolean, and enum arguments. */
export type PrimitiveArgumentValue = string | number | boolean;

/** Selected values produced by a `multi-enum` argument. */
export type MultiArgumentValue = string[];

/** Any concrete value a parsed argument can produce before optional `undefined` is added. */
export type ConcreteArgumentValue = PrimitiveArgumentValue | MultiArgumentValue;

/** Parsed, defaulted, or form-collected argument value; `undefined` means unset. */
export type ArgumentValue = ConcreteArgumentValue | undefined;

/** Theme helpers passed to custom dense-form widget renderers. */
export type ArgumentWidgetTheme = {
    /** Render text with terminal bold styling. */
    bold(text: string): string;
    /** Render text with a named Pi TUI colour such as `accent`, `muted`, or `warning`. */
    fg(color: string, text: string): string;
};

/** Context passed to a custom dense-form widget renderer. */
export type ArgumentWidgetRenderContext = {
    /** Argument key from the command's `args` map. */
    name: string;
    /** Normalized argument definition for this field. */
    definition: ArgumentDefinition;
    /** Current field value. */
    value: ArgumentValue;
    /** Whether this field currently has focus in the dense form. */
    selected: boolean;
    /** Available display width for the value cell. */
    width: number;
    /** Theme helpers matching the active Pi TUI theme. */
    theme: ArgumentWidgetTheme;
    /** Format an argument value the same way built-in widgets do. */
    formatValue(value: ArgumentValue): string;
};

/** Context passed to a custom dense-form widget input handler. */
export type ArgumentWidgetInputContext = {
    /** Argument key from the command's `args` map. */
    name: string;
    /** Normalized argument definition for this field. */
    definition: ArgumentDefinition;
    /** Current field value before the input is applied. */
    value: ArgumentValue;
    /** Raw terminal input sequence. */
    data: string;
    /** Update this field's value from the custom handler. */
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
    /** Widget override. Omit to choose a widget from the argument type. */
    widget?: ArgumentWidget;
    /** Preferred row count for multiline widgets such as `textarea` and `command`. */
    rows?: number;
    /** Optional field title for future renderers; currently the argument name is shown. */
    title?: string;
    /** Function-backed renderer/input hooks for TypeScript command definitions. */
    custom?: CustomArgumentWidget;
};

/** Shared fields accepted by every argument definition. */
export type BaseArgumentDefinition<TValue extends ConcreteArgumentValue> = {
    /** Text shown in detailed help, completions, and forms. */
    description?: string;
    /** Require the caller to explicitly provide a value. Mutually exclusive with `default`. */
    required?: boolean;
    /** Value used when the user leaves the argument unset. Mutually exclusive with `required`. */
    default?: TValue;
    /** Explicit CLI flag name without leading dashes. Defaults to the kebab-cased object key. */
    flag?: string;
    /** Additional CLI flag aliases without leading dashes. */
    aliases?: readonly string[];
    /** Value hint shown in usage text and forms. */
    placeholder?: string;
    /** Explicit positional index. Prefer this over legacy `positional: number`. */
    position?: number;
    /**
     * Parse this argument positionally instead of as a named flag.
     *
     * Use `true` for declaration order or a number for explicit positional order.
     */
    positional?: boolean | number;
    ui?: ArgumentUi;
};

/** Text argument definition, optionally constrained by length or regular expression. */
export type StringArgumentDefinition = BaseArgumentDefinition<string> & {
    type: "string";
    /** Minimum string length, inclusive. */
    minLength?: number;
    /** Maximum string length, inclusive. */
    maxLength?: number;
    /** Regular expression constraint. Strings must match the pattern. */
    pattern?: string | RegExp;
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

/** Single-choice string argument constrained to a fixed set of values. */
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
        /** Minimum selected item count, inclusive. */
        minItems?: number;
        /** Maximum selected item count, inclusive. */
        maxItems?: number;
    };

/** Any supported typed argument definition. */
export type ArgumentDefinition =
    | StringArgumentDefinition
    | NumberArgumentDefinition
    | BooleanArgumentDefinition
    | EnumArgumentDefinition
    | MultiEnumArgumentDefinition;

/** Map from argument name to definition for a typed command or skill. */
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

/** Glyphs used for checkbox and radio widgets in the dense form. */
export type TypedCommandFormSymbols = {
    /** Marker used for selected checkbox and multiselect values. */
    selectedCheckbox?: string;
    /** Marker used for unselected checkbox and multiselect values. */
    unselectedCheckbox?: string;
    /** Marker used for the selected radio option. */
    selectedRadio?: string;
    /** Marker used for unselected radio options. */
    unselectedRadio?: string;
};

/** Options passed to `registerTypedCommand`. */
export type TypedCommandRefinementIssue = {
    /** Stable issue code for command-level validation. */
    code?: string;
    /** Human-readable message suitable for UI display. */
    message: string;
    /** Argument path most directly responsible for the issue. */
    path?: readonly string[];
    /** Other argument paths involved in the issue. */
    relatedPaths?: readonly (readonly string[])[];
};

export type TypedCommandRefinementContext<TDefinitions extends ArgumentDefinitions> = {
    provided: ReadonlySet<keyof TDefinitions & string>;
};

/** Command-level cross-field validation. */
export type TypedCommandRefinement<TDefinitions extends ArgumentDefinitions> = (
    args: Partial<InferArguments<TDefinitions>>,
    context: TypedCommandRefinementContext<TDefinitions>,
) => readonly TypedCommandRefinementIssue[];

export type TypedCommandOptions<TDefinitions extends ArgumentDefinitions> = {
    /** One-line command description used by Pi command listings and detailed help. */
    description: string;
    /** Argument definitions used for parsing, validation, completions, usage, and forms. */
    args: TDefinitions;
    /** Handler invoked with typed values when parsing and validation succeed. */
    handler: TypedCommandHandler<TDefinitions>;
    /** Cross-field validation invoked after individual arguments are parsed and validated. */
    refine?: TypedCommandRefinement<TDefinitions>;
    /** Optional raw fallback handler used when typed args are disabled or bypassed. */
    fallbackHandler?: RawCommandHandler;
    /** Enable or disable typed parsing, completions, forms, and helper UX for this command. */
    typedArgsEnabled?: TypedCommandToggle;
    /** Return `false` to bypass typed parsing for a specific raw invocation. */
    shouldUseTypedArgs?: TypedCommandRawSelector;
    /** Title shown at the top of the dense argument form. */
    formTitle?: TypedCommandFormTitle;
    /** Override checkbox and radio glyphs in the dense form. */
    formSymbols?: TypedCommandFormSymbols;
    /** Open the argument form automatically when provided arguments are invalid. */
    openFormWhenInvalid?: boolean;
    /** Open the argument form automatically when required arguments are missing. */
    openFormWhenMissingRequired?: boolean;
};

/** Normalized command metadata stored in the typed command registry. */
export type RegisteredTypedCommand<TDefinitions extends ArgumentDefinitions = ArgumentDefinitions> =
    TypedCommandOptions<TDefinitions> & {
        /** Slash command name without the leading `/`. */
        name: string;
        typedArgsEnabled: TypedCommandToggle;
        formSymbols: Required<TypedCommandFormSymbols>;
        openFormWhenInvalid: boolean;
        openFormWhenMissingRequired: boolean;
        /** Source adapter that owns this metadata. */
        source?: "extension" | "skill";
    };

/** Declaration-only object created by `defineTypedCommand`. */
export type TypedCommandDefinition<TDefinitions extends ArgumentDefinitions> = Omit<
    TypedCommandOptions<TDefinitions>,
    "handler"
> & {
    /** Slash command name without the leading `/`. */
    name: string;
    /** Preferred handler spelling for declaration-style commands. */
    run?: TypedCommandHandler<TDefinitions>;
    /** Backward-compatible handler spelling. */
    handler?: TypedCommandHandler<TDefinitions>;
};

/** A command definition with convenience pure-core methods attached. */
export type DefinedTypedCommand<TDefinitions extends ArgumentDefinitions> = Readonly<
    TypedCommandDefinition<TDefinitions>
> & {
    parse(rawArgs: string): TypedParseResult<TDefinitions>;
    formatUsage(): string;
    formatHelp(): string;
};

/** Stable diagnostic produced while compiling a command definition. */
export type DefinitionDiagnostic = {
    code: string;
    message: string;
    path: readonly (string | number)[];
    severity: "error" | "warning";
};

export type CompileResult<TDefinitions extends ArgumentDefinitions> =
    | { ok: true; command: CompiledCommand<TDefinitions> }
    | { ok: false; diagnostics: readonly DefinitionDiagnostic[] };

/** Immutable internal representation consumed by parsing, formatting, completion, forms, and Pi. */
export type CompiledCommand<TDefinitions extends ArgumentDefinitions = ArgumentDefinitions> = {
    readonly name: string;
    readonly description: string;
    readonly args: Readonly<TDefinitions>;
    readonly argumentOrder: readonly (keyof TDefinitions & string)[];
    readonly positionalOrder: readonly (keyof TDefinitions & string)[];
    readonly flagToName: ReadonlyMap<string, keyof TDefinitions & string>;
    readonly diagnostics: readonly DefinitionDiagnostic[];
};

export type TypedCommandHandle<TDefinitions extends ArgumentDefinitions> = {
    readonly definition: DefinedTypedCommand<TDefinitions>;
    readonly invocationName: string;
    parse(rawArgs: string): TypedParseResult<TDefinitions>;
    formatUsage(): string;
    formatHelp(): string;
    /** Remove wrapper-owned metadata and listeners. Safe to call more than once. */
    dispose(): void;
};

/** Machine-readable kind for a parser or validation issue. */
export type ParseIssueKind =
    | "invalid-value"
    | "missing-required"
    | "missing-value"
    | "unknown-argument"
    | "unexpected-positional"
    | "unterminated-quote";

/** One parser validation or syntax issue. */
export type ParseIssue = {
    /** Stable issue category for programmatic handling. */
    kind: ParseIssueKind;
    /** Human-readable error message suitable for UI display. */
    message: string;
    /** Argument name when the issue can be attributed to a definition. */
    name?: string;
    /** Raw token that caused a syntax-level issue, when available. */
    token?: string;
};

/** Result returned by `parseTypedCommandArgs`. */
export type ParsedCommandArguments = {
    /** Parsed values plus defaults that could be applied without prompting. */
    values: Record<string, ArgumentValue>;
    /** Argument names explicitly provided by the user, even when their value failed to parse. */
    provided: Set<string>;
    /** Value provenance when it is available. */
    sources?: Map<string, "explicit" | "default">;
    /** Syntax, coercion, and validation issues found while parsing. */
    issues: ParseIssue[];
    /** Requested action: run handler or show help. */
    mode: "run" | "help";
};

export type TypedParseResult<TDefinitions extends ArgumentDefinitions> =
    | {
          status: "success";
          value: InferArguments<TDefinitions>;
          provided: ReadonlySet<keyof TDefinitions & string>;
          sources: ReadonlyMap<keyof TDefinitions & string, "explicit" | "default">;
      }
    | { status: "help" }
    | {
          status: "error";
          issues: readonly ParseIssue[];
          partial: Partial<InferArguments<TDefinitions>>;
          provided: ReadonlySet<keyof TDefinitions & string>;
      };

/** Which fields the argument form should show. */
export type FormMode = "missing" | "all";
