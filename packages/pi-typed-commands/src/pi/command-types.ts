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
} from "../types.js";

/** Handler called after typed arguments have been parsed, defaulted, and validated. */
export type TypedCommandHandler<TDefinitions extends ArgumentDefinitions> = (
    args: InferArguments<TDefinitions>,
    ctx: ExtensionCommandContext,
) => Promise<void> | void;

/** Dense-form title, or a callback that derives one from the active extension session. */
export type TypedCommandFormTitle = string | ((ctx: ExtensionContext) => string);

export type TypedCommandConfig<TDefinitions extends ArgumentDefinitions> = {
    description: string;
    args: TDefinitions;
    refine?: TypedCommandRefinement<TDefinitions>;
    formTitle?: TypedCommandFormTitle;
    formSymbols?: TypedCommandFormSymbols;
};

export type TypedCommandDefinition<TDefinitions extends ArgumentDefinitions> =
    TypedCommandConfig<TDefinitions> & {
        name: string;
        run: TypedCommandHandler<TDefinitions>;
    };

export type DefinedTypedCommand<TDefinitions extends ArgumentDefinitions> = Readonly<
    TypedCommandDefinition<TDefinitions>
> & {
    parse(rawArgs: string): TypedParseResult<TDefinitions>;
    serialize(values: SerializableArgumentValues<TDefinitions>): string;
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

/** Pi-owned command metadata layered over the framework-independent command snapshot. */
export type RegisteredTypedCommand<TDefinitions extends ArgumentDefinitions = ArgumentDefinitions> =
    CoreRegisteredTypedCommand<TDefinitions> & {
        readonly formTitle?: TypedCommandFormTitle;
        readonly target?: InvocationTarget<FlatArgumentDefinitions>;
        readonly registrationId?: symbol;
        readonly ownerId?: symbol;
        readonly formSymbols: Required<TypedCommandFormSymbols>;
        readonly source?: "extension" | "skill";
    };

export type PiTypedCommandLookup = {
    get(name: string): RegisteredTypedCommand | undefined;
    list(): readonly RegisteredTypedCommand[];
};

export type TypedCommandHandle<TDefinitions extends ArgumentDefinitions> = {
    readonly definition: DefinedTypedCommand<TDefinitions>;
    readonly invocationName: string;
    parse(rawArgs: string): TypedParseResult<TDefinitions>;
    serialize(values: SerializableArgumentValues<TDefinitions>): string;
    formatUsage(): string;
    formatHelp(): string;
    /** Remove wrapper-owned metadata and listeners. Safe to call more than once. */
    dispose(): void;
};
