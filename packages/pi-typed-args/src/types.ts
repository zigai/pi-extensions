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
    | "file"
    | "directory"
    | "command"
    | "secret"
    | "list"
    | "key-value"
    | "duration"
    | "date"
    | "time"
    | "datetime"
    | "url"
    | "email"
    | "json"
    | "code"
    | "stepper"
    | "readonly"
    | "computed"
    | "confirm"
    | "custom";

export type PrimitiveArgumentValue = string | number | boolean;
export type MultiArgumentValue = readonly string[];
export type KeyValueArgumentValue = Readonly<Record<string, string>>;

export const ARGUMENT_GROUP: unique symbol = Symbol.for("pi-typed-args.argument-group");

export type ConcreteArgumentValue =
    | PrimitiveArgumentValue
    | MultiArgumentValue
    | KeyValueArgumentValue;

/** Parsed, defaulted, or form-collected argument value; `undefined` means unset. */
export type ArgumentValue = ConcreteArgumentValue | undefined;

export type ArgumentWidgetTheme = {
    bold(text: string): string;
    fg(color: string, text: string): string;
};

export type ArgumentWidgetRenderContext = {
    name: string;
    definition: ArgumentDefinition;
    value: ArgumentValue;
    values: Readonly<Record<string, ArgumentValue>>;
    selected: boolean;
    width: number;
    theme: ArgumentWidgetTheme;
    formatValue(value: ArgumentValue): string;
};

export type ArgumentWidgetInputContext = {
    name: string;
    definition: ArgumentDefinition;
    value: ArgumentValue;
    values: Readonly<Record<string, ArgumentValue>>;
    data: string;
    matchesKeybinding(action: ArgumentFormKeybinding): boolean;
    setValue(value: ArgumentValue): void;
    setValues(values: Readonly<Record<string, ArgumentValue>>): void;
};

export type ArgumentFormKeybinding =
    | "cursor-up"
    | "cursor-down"
    | "cursor-left"
    | "cursor-right"
    | "new-line"
    | "submit"
    | "tab"
    | "confirm"
    | "cancel";

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

export type ArgumentUi = {
    widget?: ArgumentWidget;
    rows?: number;
    title?: string;
    readOnly?: boolean | ((values: Readonly<Record<string, ArgumentValue>>) => boolean);
    hidden?: boolean | ((values: Readonly<Record<string, ArgumentValue>>) => boolean);
    visibleWhen?: boolean | ((values: Readonly<Record<string, ArgumentValue>>) => boolean);
    enabledWhen?: boolean | ((values: Readonly<Record<string, ArgumentValue>>) => boolean);
    requiredWhen?: boolean | ((values: Readonly<Record<string, ArgumentValue>>) => boolean);
    compute?: (values: Readonly<Record<string, ArgumentValue>>) => ArgumentValue;
    disabled?: boolean | ((values: Readonly<Record<string, ArgumentValue>>) => boolean);
    section?: string;
    advanced?: boolean;
    copyFrom?: string;
    custom?: CustomArgumentWidget;
};

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

          default?: never;
      }
    | {
          /** Omit or set false when the value may come from a default or remain unset. */
          required?: false;

          /** Value used when the user leaves the argument unset. Mutually exclusive with `required: true`. */
          default?: TValue;
      }
    | {
          required?: boolean;
          default?: never;
      };

export type BaseArgumentDefinition<TValue extends ConcreteArgumentValue> =
    ArgumentPresence<TValue> & {
        description?: string;
        examples?: readonly string[];

        /** Explicit CLI flag name without leading dashes. Defaults to the kebab-cased object key. */
        flag?: string;

        aliases?: readonly string[];
        title?: string;
        placeholder?: string;

        /** How repeated occurrences of this argument are handled. Defaults to error for scalars and append for multi-enum. */
        occurrence?: ArgumentOccurrencePolicy;

        complete?: TypedCompletionProvider;

        /** Optional asynchronous provider used only by Pi's async command-completion hook. */
        completeAsync?: TypedAsyncCompletionProvider;

        /** Maximum milliseconds to wait for async completions. Defaults to 1000; set to 0 to disable. */
        completionTimeoutMs?: number;

        position?: number;
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

export type StringArgumentDefinition = BaseArgumentDefinition<string> & {
    type: "string";
    minLength?: number;
    maxLength?: number;
    pattern?: string | RegExp;
    format?: "email" | "url" | "date" | "time" | "datetime" | "duration" | "json";

    /** Prevent this value from appearing in helper text or ordinary form summaries. */
    sensitive?: boolean;
};

export type NumberArgumentDefinition = BaseArgumentDefinition<number> & {
    type: "number";
    integer?: boolean;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
};

/** Boolean flag definition supporting `--flag`, `--flag true`, and `--no-flag`. */
export type BooleanArgumentDefinition = BaseArgumentDefinition<boolean> & {
    type: "boolean";
};

export type EnumOptionDescriptions<TValues extends readonly string[] = readonly string[]> =
    Readonly<Partial<Record<TValues[number], string>>>;

export type EnumArgumentDefinition<TValues extends readonly string[] = readonly string[]> =
    BaseArgumentDefinition<TValues[number]> & {
        type: "enum";

        /** Allowed string values. Use `as const` to preserve literal inference. */
        values: TValues;

        optionDescriptions?: EnumOptionDescriptions<TValues>;
    };

/** Multi-choice string argument definition parsed from repeated or comma-separated flags. */
export type MultiEnumArgumentDefinition<TValues extends readonly string[] = readonly string[]> =
    BaseArgumentDefinition<readonly TValues[number][]> & {
        type: "multi-enum";
        values: TValues;
        minItems?: number;
        maxItems?: number;
    };

export type StringListArgumentDefinition = BaseArgumentDefinition<readonly string[]> & {
    type: "string-list";
    minItems?: number;
    maxItems?: number;
};

export type KeyValueArgumentDefinition = BaseArgumentDefinition<KeyValueArgumentValue> & {
    type: "key-value";
    minItems?: number;
    maxItems?: number;
};

export type ArgumentDefinition =
    | StringArgumentDefinition
    | NumberArgumentDefinition
    | BooleanArgumentDefinition
    | EnumArgumentDefinition
    | MultiEnumArgumentDefinition
    | StringListArgumentDefinition
    | KeyValueArgumentDefinition;

export type ArgumentGroupDefinition<
    TDefinitions extends ArgumentDefinitions = ArgumentDefinitions,
> = {
    readonly [ARGUMENT_GROUP]: TDefinitions;
    readonly args: TDefinitions;
    readonly title?: string;
    readonly description?: string;
};

export interface ArgumentDefinitions {
    readonly [name: string]: ArgumentDefinition | ArgumentGroupDefinition;
}

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
            : TDefinition extends StringListArgumentDefinition
              ? readonly string[]
              : TDefinition extends KeyValueArgumentDefinition
                ? KeyValueArgumentValue
                : never;

type MaybeOptional<TDefinition, TValue> =
    IsRequired<TDefinition> extends true
        ? TValue
        : HasDefault<TDefinition> extends true
          ? TValue
          : TValue | undefined;

export type InferArgumentValue<TDefinition> =
    TDefinition extends ArgumentGroupDefinition<infer TGroup>
        ? InferArguments<TGroup>
        : MaybeOptional<TDefinition, BaseValue<TDefinition>>;

export type InferArguments<TDefinitions extends ArgumentDefinitions> = {
    [TKey in keyof TDefinitions]: InferArgumentValue<TDefinitions[TKey]>;
};

export type ParsedArgumentDraft<TDefinitions extends ArgumentDefinitions> = {
    readonly [TKey in keyof TDefinitions]?: InferArgumentValue<TDefinitions[TKey]>;
};

export type ArgumentPath<TDefinitions extends ArgumentDefinitions> = {
    [TKey in keyof TDefinitions & string]: TDefinitions[TKey] extends ArgumentGroupDefinition<
        infer TGroup
    >
        ? `${TKey}.${ArgumentPath<TGroup>}`
        : TKey;
}[keyof TDefinitions & string];

export type SerializableArgumentValues<TDefinitions extends ArgumentDefinitions> = {
    readonly [TKey in keyof TDefinitions]?: InferArgumentValue<TDefinitions[TKey]>;
};

export type TypedCommandFormSymbols = {
    selectedCheckbox?: string;
    unselectedCheckbox?: string;
    selectedRadio?: string;
    unselectedRadio?: string;
};

export type TypedCommandFormTrigger = "tab" | "double-tab";
export type TypedCommandWidgetPlacement = "aboveEditor" | "belowEditor";

/** Options for the Pi live typed-command UX bridge. */
export type TypedCommandUxOptions = {
    /** Where the compact live helper is rendered. Defaults to `"aboveEditor"`. */
    helperPlacement?: TypedCommandWidgetPlacement;

    /** Keystroke sequence that opens the expanded argument form. Defaults to `"tab"`. */
    formTrigger?: TypedCommandFormTrigger;
};

export type TypedCommandRefinementIssue = {
    code?: string;
    message: string;
    path?: readonly string[];
    relatedPaths?: readonly (readonly string[])[];
};

export type TypedCommandRefinementContext<TDefinitions extends ArgumentDefinitions> = {
    provided: ReadonlySet<ArgumentPath<TDefinitions>>;
};

export type TypedCommandRefinement<TDefinitions extends ArgumentDefinitions> = (
    args: ParsedArgumentDraft<TDefinitions>,
    context: TypedCommandRefinementContext<TDefinitions>,
) => readonly TypedCommandRefinementIssue[];

export type CoreRegisteredTypedCommand<
    TDefinitions extends ArgumentDefinitions = ArgumentDefinitions,
> = {
    readonly name: string;
    readonly description: string;
    readonly args: FlatArgumentDefinitions;
    readonly refine?: TypedCommandRefinement<FlatArgumentDefinitions>;
    readonly compiled?: CompiledCommand<TDefinitions>;
    readonly invocationName?: string;
    readonly aliases?: readonly string[];
    readonly subcommands?: Readonly<Record<string, CoreRegisteredTypedCommand>>;

    /** Whether raw arguments without a subcommand select the root grammar. */
    readonly hasRootHandler?: boolean;
};

export type TypedCommandLookup = {
    get(name: string): CoreRegisteredTypedCommand | undefined;
    list(): readonly CoreRegisteredTypedCommand[];
};

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
    complete?(query: string, context: TypedCompletionContext): readonly TypedCompletionItem[];

    completeAsync?(
        query: string,
        context: TypedCompletionContext,
    ): Promise<readonly TypedCompletionItem[]>;

    editor?: FieldEditor<TValue>;
};

export type CoreCommandDefinition<TDefinitions extends ArgumentDefinitions> = {
    readonly name: string;
    readonly description: string;
    readonly args: TDefinitions;
};

export type CompiledCommand<TDefinitions extends ArgumentDefinitions = ArgumentDefinitions> = {
    readonly name: string;
    readonly description: string;
    readonly definitions: TDefinitions;
    readonly args: FlatArgumentDefinitions;
    readonly arguments: readonly CompiledArgument[];
    readonly argumentByName: ReadonlyMap<string, CompiledArgument>;
    readonly argumentOrder: readonly string[];
    readonly positionalOrder: readonly string[];
    readonly flagToName: ReadonlyMap<string, string>;
    readonly diagnostics: readonly DefinitionDiagnostic[];
};

export type ParseIssueKind =
    | "invalid-value"
    | "missing-required"
    | "missing-value"
    | "duplicate-argument"
    | "unknown-argument"
    | "unexpected-positional"
    | "unterminated-quote"
    | "missing-subcommand"
    | "unknown-subcommand";

export type ParseIssue = {
    kind: ParseIssueKind;
    message: string;
    name?: string;
    token?: string;
    code?: string;
    relatedNames?: readonly string[];
};

export type ParsedCommandArguments = {
    readonly grammar?: CompiledCommand;

    /** Parsed values plus defaults that could be applied without prompting. */
    readonly values: Readonly<Record<string, ArgumentValue>>;

    /** Argument names explicitly provided by the user, even when their value failed to parse. */
    readonly provided: ReadonlySet<string>;

    readonly sources?: ReadonlyMap<string, "explicit" | "default">;
    readonly issues: readonly ParseIssue[];
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

export type FormMode = "missing" | "all";
