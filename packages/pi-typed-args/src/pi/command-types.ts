import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
    ArgumentDefinitions,
    CoreRegisteredTypedCommand,
    FlatArgumentDefinitions,
    InferArguments,
    SerializableArgumentValues,
    TypedCommandFormSymbols,
    TypedCommandRefinement,
    TypedParseResult,
} from "../types.ts";

export type TypedCommandHandler<TDefinitions extends ArgumentDefinitions> = (
    args: InferArguments<TDefinitions>,
    ctx: ExtensionCommandContext,
) => Promise<void> | void;

type MergeArgumentDefinitions<
    TShared extends ArgumentDefinitions,
    TLocal extends ArgumentDefinitions,
> = TShared & TLocal;

export type TypedCommandFormTitle = string | ((ctx: ExtensionContext) => string);
export type TypedCommandFormPolicy = "manual" | "missing" | "invalid" | "always";
export type TypedCommandInlineHelp = "auto" | "hidden";

export type TypedCommandGhostTextContext = {
    readonly ctx: ExtensionContext;
    readonly commandName: string;
    readonly subcommand?: string;
};

export type TypedCommandGhostText =
    | string
    | ((context: TypedCommandGhostTextContext) => string | undefined);

export type TypedCommandConfig<TDefinitions extends ArgumentDefinitions> = {
    description: string;
    args: TDefinitions;
    refine?: TypedCommandRefinement<TDefinitions>;
    formTitle?: TypedCommandFormTitle;
    formSymbols?: TypedCommandFormSymbols;

    /** Decide when command submission opens the form. Defaults to `missing`. */
    formPolicy?: TypedCommandFormPolicy;

    formPresets?: boolean;
    inlineHelp?: TypedCommandInlineHelp;
    ghostText?: TypedCommandGhostText;
};

export type TypedSubcommandDefinition<
    TShared extends ArgumentDefinitions,
    TLocal extends ArgumentDefinitions,
> = {
    description: string;
    aliases?: readonly string[];
    args: TLocal;
    refine?: TypedCommandRefinement<MergeArgumentDefinitions<TShared, TLocal>>;
    formTitle?: TypedCommandFormTitle;
    formSymbols?: TypedCommandFormSymbols;
    formPolicy?: TypedCommandFormPolicy;
    formPresets?: boolean;
    inlineHelp?: TypedCommandInlineHelp;
    ghostText?: TypedCommandGhostText;
    run: TypedCommandHandler<MergeArgumentDefinitions<TShared, TLocal>>;
};

export type TypedSubcommandDefinitions<_TShared extends ArgumentDefinitions = ArgumentDefinitions> =
    Readonly<Record<string, ArgumentDefinitions>>;

type TypedSubcommandsFor<
    TShared extends ArgumentDefinitions,
    TSubcommands extends TypedSubcommandDefinitions<TShared>,
> = {
    readonly [TName in keyof TSubcommands]: TypedSubcommandDefinition<TShared, TSubcommands[TName]>;
};

type SubcommandParseResult<
    TShared extends ArgumentDefinitions,
    TName extends PropertyKey,
    TLocal extends ArgumentDefinitions,
> =
    TypedParseResult<MergeArgumentDefinitions<TShared, TLocal>> extends infer TResult
        ? TResult extends object
            ? TResult & { readonly subcommand: TName }
            : never
        : never;

export type TypedCommandParseResult<
    TShared extends ArgumentDefinitions,
    TSubcommands extends TypedSubcommandDefinitions<TShared>,
> =
    | TypedParseResult<TShared>
    | {
          [TName in keyof TSubcommands]: SubcommandParseResult<TShared, TName, TSubcommands[TName]>;
      }[keyof TSubcommands];

export type SerializableSubcommandInvocation<
    TShared extends ArgumentDefinitions,
    TSubcommands extends TypedSubcommandDefinitions<TShared>,
> = {
    [TName in keyof TSubcommands]: {
        readonly subcommand: TName;

        readonly args: SerializableArgumentValues<
            MergeArgumentDefinitions<TShared, TSubcommands[TName]>
        >;
    };
}[keyof TSubcommands];

export type TypedCommandDefinition<
    TDefinitions extends ArgumentDefinitions,
    TSubcommands extends TypedSubcommandDefinitions<TDefinitions> =
        TypedSubcommandDefinitions<TDefinitions>,
> = TypedCommandConfig<TDefinitions> & {
    name: string;

    /** Root handler used when no subcommand token is present. */
    run?: TypedCommandHandler<TDefinitions>;

    subcommands?: TypedSubcommandsFor<TDefinitions, TSubcommands>;
};

export type DefinedTypedCommand<
    TDefinitions extends ArgumentDefinitions,
    TSubcommands extends TypedSubcommandDefinitions<TDefinitions> =
        TypedSubcommandDefinitions<TDefinitions>,
> = Readonly<TypedCommandDefinition<TDefinitions, TSubcommands>> & {
    parse(rawArgs: string): TypedCommandParseResult<TDefinitions, TSubcommands>;
    serialize(values: SerializableArgumentValues<TDefinitions>): string;

    serializeSubcommand(
        invocation: SerializableSubcommandInvocation<TDefinitions, TSubcommands>,
    ): string;

    formatUsage(): string;
    formatHelp(): string;
};

export type InvocationTarget<TDefinitions extends ArgumentDefinitions> =
    | {
          kind: "extension";
          run: TypedCommandHandler<TDefinitions>;
      }
    | {
          kind: "skill";
          render(args: InferArguments<TDefinitions>, additionalInput?: string): string;
      };

export type RegisteredTypedCommand<TDefinitions extends ArgumentDefinitions = ArgumentDefinitions> =
    CoreRegisteredTypedCommand<TDefinitions> & {
        readonly formTitle?: TypedCommandFormTitle;
        readonly target?: InvocationTarget<FlatArgumentDefinitions>;
        readonly registrationId?: symbol;
        readonly ownerId?: symbol;
        readonly formSymbols: Required<TypedCommandFormSymbols>;
        readonly source?: "extension" | "skill";
        readonly formPolicy?: TypedCommandFormPolicy;
        readonly formPresets?: boolean;
        readonly inlineHelp?: TypedCommandInlineHelp;
        readonly ghostText?: TypedCommandGhostText;
        readonly aliases?: readonly string[];
        readonly subcommands?: Readonly<Record<string, RegisteredTypedCommand>>;
    };

export type PiTypedCommandLookup = {
    get(name: string): RegisteredTypedCommand | undefined;
    list(): readonly RegisteredTypedCommand[];
};

export type TypedCommandHandle<
    TDefinitions extends ArgumentDefinitions,
    TSubcommands extends TypedSubcommandDefinitions<TDefinitions> =
        TypedSubcommandDefinitions<TDefinitions>,
> = {
    readonly definition: DefinedTypedCommand<TDefinitions, TSubcommands>;
    readonly invocationName: string;
    parse(rawArgs: string): TypedCommandParseResult<TDefinitions, TSubcommands>;
    serialize(values: SerializableArgumentValues<TDefinitions>): string;

    serializeSubcommand(
        invocation: SerializableSubcommandInvocation<TDefinitions, TSubcommands>,
    ): string;

    formatUsage(): string;
    formatHelp(): string;

    /** Remove wrapper-owned metadata and listeners. Safe to call more than once. */
    dispose(): void;
};
