export { defineTypedCommand } from "../command/definition.js";
export { registerTypedCommand } from "./register.js";
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
} from "./command-types.js";
export type { InferArguments } from "../types.js";
