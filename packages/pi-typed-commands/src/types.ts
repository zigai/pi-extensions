import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type PrimitiveArgumentValue = string | number | boolean;
export type ArgumentValue = PrimitiveArgumentValue | undefined;

export type BaseArgumentDefinition<TValue extends PrimitiveArgumentValue> = {
    description?: string;
    required?: boolean;
    default?: TValue;
    aliases?: readonly string[];
    placeholder?: string;
};

export type StringArgumentDefinition = BaseArgumentDefinition<string> & {
    type: "string";
};

export type NumberArgumentDefinition = BaseArgumentDefinition<number> & {
    type: "number";
    integer?: boolean;
    min?: number;
    max?: number;
};

export type BooleanArgumentDefinition = BaseArgumentDefinition<boolean> & {
    type: "boolean";
};

export type EnumArgumentDefinition<TValues extends readonly string[] = readonly string[]> =
    BaseArgumentDefinition<TValues[number]> & {
        type: "enum";
        values: TValues;
    };

export type ArgumentDefinition =
    | StringArgumentDefinition
    | NumberArgumentDefinition
    | BooleanArgumentDefinition
    | EnumArgumentDefinition;

export type ArgumentDefinitions = Record<string, ArgumentDefinition>;

type HasDefault<TDefinition> = TDefinition extends { default: PrimitiveArgumentValue }
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
          : never;

type MaybeOptional<TDefinition, TValue> =
    IsRequired<TDefinition> extends true
        ? TValue
        : HasDefault<TDefinition> extends true
          ? TValue
          : TValue | undefined;

export type InferArgumentValue<TDefinition> = MaybeOptional<TDefinition, BaseValue<TDefinition>>;

export type InferArguments<TDefinitions extends ArgumentDefinitions> = {
    [TKey in keyof TDefinitions]: InferArgumentValue<TDefinitions[TKey]>;
};

export type TypedCommandHandler<TDefinitions extends ArgumentDefinitions> = (
    args: InferArguments<TDefinitions>,
    ctx: ExtensionCommandContext,
) => Promise<void> | void;

export type RawCommandHandler = (
    args: string,
    ctx: ExtensionCommandContext,
) => Promise<void> | void;

export type TypedCommandToggle = boolean | (() => boolean);

export type TypedCommandOptions<TDefinitions extends ArgumentDefinitions> = {
    description: string;
    args: TDefinitions;
    handler: TypedCommandHandler<TDefinitions>;
    fallbackHandler?: RawCommandHandler;
    typedArgsEnabled?: TypedCommandToggle;
    manualWizardToken?: string;
    helpToken?: string;
    openWizardWhenInvalid?: boolean;
    openWizardWhenMissingRequired?: boolean;
};

export type RegisteredTypedCommand<TDefinitions extends ArgumentDefinitions = ArgumentDefinitions> =
    {
        name: string;
        description: string;
        args: TDefinitions;
        handler: TypedCommandHandler<TDefinitions>;
        fallbackHandler?: RawCommandHandler;
        typedArgsEnabled: TypedCommandToggle;
        manualWizardToken: string;
        helpToken: string;
        openWizardWhenInvalid: boolean;
        openWizardWhenMissingRequired: boolean;
    };

export type ParseIssueKind =
    | "invalid-value"
    | "missing-required"
    | "missing-value"
    | "unknown-argument"
    | "unexpected-positional"
    | "unterminated-quote";

export type ParseIssue = {
    kind: ParseIssueKind;
    message: string;
    name?: string;
    token?: string;
};

export type ParsedCommandArguments = {
    values: Record<string, ArgumentValue>;
    provided: Set<string>;
    issues: ParseIssue[];
    mode: "run" | "wizard" | "help";
};

export type WizardMode = "missing" | "all";
