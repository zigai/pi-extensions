/**
 * Built-in dense-form widget names for typed command arguments.
 *
 * Omit `ui.widget` to let pi-typed-args choose a widget from the argument type.
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
export type MultiArgumentValue = readonly string[];

export const ARGUMENT_GROUP: unique symbol = Symbol.for("pi-typed-args.argument-group");

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
    /** Read-only snapshot of the whole form's current values. */
    values: Readonly<Record<string, ArgumentValue>>;
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
    /** Read-only snapshot of the whole form's current values. */
    values: Readonly<Record<string, ArgumentValue>>;
    /** Raw terminal input sequence. */
    data: string;
    /** Update this field's value from the custom handler. */
    setValue(value: ArgumentValue): void;
    /** Update one or more form values from the custom handler. */
    setValues(values: Readonly<Record<string, ArgumentValue>>): void;
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
    /** Optional field title shown by form renderers. */
    title?: string;
    /** Whether this field should be immutable in forms. */
    readOnly?: boolean | ((values: Readonly<Record<string, ArgumentValue>>) => boolean);
    /** Whether this field should be hidden in forms. */
    hidden?: boolean | ((values: Readonly<Record<string, ArgumentValue>>) => boolean);
    /** Compute this field's form value from the current whole-form state. */
    compute?: (values: Readonly<Record<string, ArgumentValue>>) => ArgumentValue;
    /** Function-backed renderer/input hooks for TypeScript command definitions. */
    custom?: CustomArgumentWidget;
};

/** Shared fields accepted by every argument definition. */
export type ArgumentOccurrencePolicy = "error" | "first" | "last" | "append";

export type TypedCompletionReplacementRange = {
    start: number;
    end: number;
};

export type TypedCompletionItem = {
    /** Candidate value before adapter-specific quoting or prefix replacement. */
    value: string;
    label?: string;
    description?: string;
    /** Optional text to insert instead of `value` when the provider already computed quoting. */
    replacement?: string;
    /** Optional source span, relative to the raw argument string, that `replacement` should cover. */
    replaceRange?: TypedCompletionReplacementRange;
};

export type TypedCompletionContext<TDefinitions extends ArgumentDefinitions = ArgumentDefinitions> =
    {
        readonly values: ParsedArgumentDraft<TDefinitions>;
        readonly provided: ReadonlySet<keyof TDefinitions & string>;
        readonly cwd?: string;
        readonly signal?: AbortSignal;
    };

export type TypedCompletionProvider<
    TDefinitions extends ArgumentDefinitions = ArgumentDefinitions,
> = (
    query: string,
    context: TypedCompletionContext<TDefinitions>,
) => readonly TypedCompletionItem[];

export type TypedAsyncCompletionProvider<
    TDefinitions extends ArgumentDefinitions = ArgumentDefinitions,
> = (
    query: string,
    context: TypedCompletionContext<TDefinitions>,
) => Promise<readonly TypedCompletionItem[]>;

type ArgumentPresence<TValue extends ConcreteArgumentValue> =
    | {
          /** Require the caller to explicitly provide a value. Mutually exclusive with `default`. */
          required: true;
          /** Required arguments may not define a default. */
          default?: never;
      }
    | {
          /** Omit or set false when the value may come from a default or remain unset. */
          required?: false;
          /** Value used when the user leaves the argument unset. Mutually exclusive with `required: true`. */
          default?: TValue;
      }
    | {
          /** Dynamic requiredness is allowed only when no default is present. */
          required?: boolean;
          /** Requiredness decided at runtime may not define a default. */
          default?: never;
      };

export type BaseArgumentDefinition<TValue extends ConcreteArgumentValue> =
    ArgumentPresence<TValue> & {
        /** Text shown in detailed help, completions, and forms. */
        description?: string;
        /** Explicit CLI flag name without leading dashes. Defaults to the kebab-cased object key. */
        flag?: string;
        /** Additional CLI flag aliases without leading dashes. */
        aliases?: readonly string[];
        /** Human-readable field title shown in forms and help; defaults to the argument key. */
        title?: string;
        /** Value hint shown in usage text and forms. */
        placeholder?: string;
        /** How repeated occurrences of this argument are handled. Defaults to error for scalars and append for multi-enum. */
        occurrence?: ArgumentOccurrencePolicy;
        /** Optional synchronous completion provider for editor and command completion paths. */
        complete?: TypedCompletionProvider;
        /** Optional asynchronous provider used only by Pi's async command-completion hook. */
        completeAsync?: TypedAsyncCompletionProvider;
        /** Maximum milliseconds to wait for async completions. Defaults to 1000; set to 0 to disable. */
        completionTimeoutMs?: number;
        /** Explicit positional index. */
        position?: number;
        /** Consume all remaining positional tokens into this positional argument. */
        rest?: boolean;
        /**
         * Collect this optional value only through Pi's expanded argument form.
         *
         * Form-only arguments have no CLI flag or positional spelling and are omitted from
         * generated usage, help, completions, and serialization. They must not define CLI
         * metadata, a default, or requiredness.
         */
        formOnly?: boolean;
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
    BaseArgumentDefinition<readonly TValues[number][]> & {
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

/** Explicit grouping marker produced by `group()` for nested handler values. */
export type ArgumentGroupDefinition<
    TDefinitions extends ArgumentDefinitions = ArgumentDefinitions,
> = {
    readonly [ARGUMENT_GROUP]: TDefinitions;
    readonly args: TDefinitions;
    readonly title?: string;
    readonly description?: string;
};

/** Map from argument name to definition for a typed command or skill. */
export interface ArgumentDefinitions {
    readonly [name: string]: ArgumentDefinition | ArgumentGroupDefinition;
}

/** Flattened parser-facing argument map after groups have been expanded to dotted names. */
export type FlatArgumentDefinitions = Readonly<Record<string, ArgumentDefinition>>;

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
            ? readonly TValues[number][]
            : never;

type MaybeOptional<TDefinition, TValue> =
    IsRequired<TDefinition> extends true
        ? TValue
        : HasDefault<TDefinition> extends true
          ? TValue
          : TValue | undefined;

/** Infer the handler value type for one argument definition or group definition. */
export type InferArgumentValue<TDefinition> =
    TDefinition extends ArgumentGroupDefinition<infer TGroup>
        ? InferArguments<TGroup>
        : MaybeOptional<TDefinition, BaseValue<TDefinition>>;

/** Infer the typed handler argument object for a command's `args` definition map. */
export type InferArguments<TDefinitions extends ArgumentDefinitions> = {
    [TKey in keyof TDefinitions]: InferArgumentValue<TDefinitions[TKey]>;
};

/** Partially parsed argument values used before every required/defaulted value is guaranteed. */
export type ParsedArgumentDraft<TDefinitions extends ArgumentDefinitions> = {
    readonly [TKey in keyof TDefinitions]?: InferArgumentValue<TDefinitions[TKey]>;
};

/** Dotted parser path for one leaf in a possibly grouped argument-definition tree. */
export type ArgumentPath<TDefinitions extends ArgumentDefinitions> = {
    [TKey in keyof TDefinitions & string]: TDefinitions[TKey] extends ArgumentGroupDefinition<
        infer TGroup
    >
        ? `${TKey}.${ArgumentPath<TGroup>}`
        : TKey;
}[keyof TDefinitions & string];

/** Values accepted by typed-command serializers, where callers may include only fields to emit. */
export type SerializableArgumentValues<TDefinitions extends ArgumentDefinitions> = {
    readonly [TKey in keyof TDefinitions]?: InferArgumentValue<TDefinitions[TKey]>;
};

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

/** Options for the Pi live typed-command UX bridge. */
export type TypedCommandFormTrigger = "tab" | "double-tab";
export type TypedCommandWidgetPlacement = "aboveEditor" | "belowEditor";

export type TypedCommandUxOptions = {
    /** Where the compact live helper is rendered. Defaults to `"aboveEditor"`. */
    helperPlacement?: TypedCommandWidgetPlacement;
    /** Keystroke sequence that opens the expanded argument form. Defaults to `"tab"`. */
    formTrigger?: TypedCommandFormTrigger;
};

/** Command-level refinement issue shown as a parse/form diagnostic. */
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
    provided: ReadonlySet<ArgumentPath<TDefinitions>>;
};

/** Command-level cross-field validation. */
export type TypedCommandRefinement<TDefinitions extends ArgumentDefinitions> = (
    args: ParsedArgumentDraft<TDefinitions>,
    context: TypedCommandRefinementContext<TDefinitions>,
) => readonly TypedCommandRefinementIssue[];

/** Framework-independent command metadata consumed by parser, usage, and completion policy. */
export type CoreRegisteredTypedCommand<
    TDefinitions extends ArgumentDefinitions = ArgumentDefinitions,
> = {
    readonly name: string;
    readonly description: string;
    readonly args: FlatArgumentDefinitions;
    readonly refine?: TypedCommandRefinement<FlatArgumentDefinitions>;
    readonly compiled?: CompiledCommand<TDefinitions>;
    readonly invocationName?: string;
};

/** Framework-independent command lookup consumed by completion policy. */
export type TypedCommandLookup = {
    get(name: string): CoreRegisteredTypedCommand | undefined;
    list(): readonly CoreRegisteredTypedCommand[];
};

/** Stable diagnostic produced while compiling a command definition. */
export type DefinitionDiagnostic = {
    readonly code: string;
    readonly message: string;
    readonly path: readonly (string | number)[];
    readonly severity: "error" | "warning";
};

export type CompileResult<TDefinitions extends ArgumentDefinitions> =
    | { ok: true; command: CompiledCommand<TDefinitions> }
    | { ok: false; diagnostics: readonly DefinitionDiagnostic[] };

export type RawArgumentOccurrence = {
    raw?: string;
    token?: string;
    source: "flag" | "positional";
    negated?: boolean;
};

export type DecodeResult =
    | { ok: true; value: ArgumentValue }
    | { ok: false; issues: readonly ParseIssue[]; value?: ArgumentValue };

export type ArgumentDescription = {
    key: string;
    type: ArgumentDefinition["type"];
    flag?: string;
    aliases: readonly string[];
    position?: number;
    required: boolean;
    defaultValue?: ArgumentValue;
    title?: string;
    description?: string;
};

export type FieldEditor<TValue = ArgumentValue> = {
    kind: "text" | "textarea" | "number" | "toggle" | "select" | "multiselect" | "custom";
    parse(input: string): TValue;
    format(value: TValue): string;
};

export type CompiledArgument<TValue extends ArgumentValue = ArgumentValue> = {
    readonly key: string;
    readonly definition: ArgumentDefinition;
    readonly flag?: string;
    readonly aliases: readonly string[];
    readonly position?: number;
    decode(occurrences: readonly RawArgumentOccurrence[]): DecodeResult;
    validate(value: unknown): readonly ParseIssue[];
    serialize(value: unknown): readonly string[];
    describe(): ArgumentDescription;
    complete?(
        query: string,
        context: TypedCompletionContext,
    ): readonly TypedCompletionItem[];
    completeAsync?(
        query: string,
        context: TypedCompletionContext,
    ): Promise<readonly TypedCompletionItem[]>;
    editor?: FieldEditor<TValue>;
};

/** Library-owned command metadata accepted by the core compiler. */
export type CoreCommandDefinition<TDefinitions extends ArgumentDefinitions> = {
    readonly name: string;
    readonly description: string;
    readonly args: TDefinitions;
};

/** Immutable internal representation consumed by parsing, formatting, completion, forms, and Pi. */
export type CompiledCommand<TDefinitions extends ArgumentDefinitions = ArgumentDefinitions> = {
    readonly name: string;
    readonly description: string;
    /** Immutable source definition tree whose type evidence this grammar was compiled from. */
    readonly definitions: TDefinitions;
    readonly args: FlatArgumentDefinitions;
    readonly arguments: readonly CompiledArgument[];
    readonly argumentByName: ReadonlyMap<string, CompiledArgument>;
    readonly argumentOrder: readonly string[];
    readonly positionalOrder: readonly string[];
    readonly flagToName: ReadonlyMap<string, string>;
    readonly diagnostics: readonly DefinitionDiagnostic[];
};

/** Machine-readable kind for a parser or validation issue. */
export type ParseIssueKind =
    | "invalid-value"
    | "missing-required"
    | "missing-value"
    | "duplicate-argument"
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

/** Parsed raw slash-command arguments before conversion to `TypedParseResult`. */
export type ParsedCommandArguments = {
    /** Exact compiled grammar that parsed this snapshot. */
    readonly grammar?: CompiledCommand;
    /** Parsed values plus defaults that could be applied without prompting. */
    readonly values: Readonly<Record<string, ArgumentValue>>;
    /** Argument names explicitly provided by the user, even when their value failed to parse. */
    readonly provided: ReadonlySet<string>;
    /** Value provenance when it is available. */
    readonly sources?: ReadonlyMap<string, "explicit" | "default">;
    /** Syntax, coercion, and validation issues found while parsing. */
    readonly issues: readonly ParseIssue[];
    /** Requested action: run handler or show help. */
    readonly mode: "run" | "help";
};

export type TypedParseResult<TDefinitions extends ArgumentDefinitions> =
    | {
          status: "success";
          value: InferArguments<TDefinitions>;
          provided: ReadonlySet<ArgumentPath<TDefinitions>>;
          sources: ReadonlyMap<ArgumentPath<TDefinitions>, "explicit" | "default">;
      }
    | { status: "help" }
    | {
          status: "error";
          issues: readonly ParseIssue[];
          partial: ParsedArgumentDraft<TDefinitions>;
          provided: ReadonlySet<ArgumentPath<TDefinitions>>;
      };

/** Which fields the argument form should show. */
export type FormMode = "missing" | "all";
