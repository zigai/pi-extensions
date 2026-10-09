export { defineTypedCommand } from "../command/definition.ts";
export { registerTypedCommand } from "./register.ts";
export type {
    DefinedTypedCommand,
    TypedCommandDefinition,
    TypedCommandHandle,
    TypedSubcommandDefinition,
    TypedSubcommandDefinitions,
    TypedCommandFormPolicy,
    TypedCommandGhostText,
    TypedCommandGhostTextContext,
    TypedCommandInlineHelp,
    TypedCommandParseResult,
    SerializableSubcommandInvocation,
} from "./command-types.ts";
export type { InferArguments } from "../types.ts";
