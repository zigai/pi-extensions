import { cloneAndFreezeDefinitions, compileTypedCommandDefinition } from "../compiler.js";
import {
    parseTypedCommandArgs,
    serializeTypedCommandArgs,
    toTypedParseResult,
} from "../parser.js";
import { formatCommandUsage, formatDetailedHelp } from "../usage.js";
import type {
    ArgumentDefinitions,
    SerializableArgumentValues,
} from "../types.js";
import type {
    DefinedTypedCommand,
    TypedCommandDefinition,
} from "../pi/command-types.js";
import { maybeFlattenGroupedValues } from "./grouped-values.js";
import { definitionError, registeredCommandForDefinition } from "./registered-command.js";

/** Define a typed command once, preserving literal argument inference and exposing pure helpers. */
export function defineTypedCommand<const TDefinitions extends ArgumentDefinitions>(
    definition: TypedCommandDefinition<TDefinitions>,
): DefinedTypedCommand<TDefinitions> {
    const compiled = compileTypedCommandDefinition(definition);
    if (!compiled.ok) {
        throw definitionError(definition.name, compiled.diagnostics);
    }

    const normalizedDefinition: TypedCommandDefinition<TDefinitions> = {
        ...definition,
        args: cloneAndFreezeDefinitions(definition.args),
    };
    const command = registeredCommandForDefinition(normalizedDefinition);
    const defined = {
        ...normalizedDefinition,
        parse(rawArgs: string) {
            return toTypedParseResult(command.compiled, parseTypedCommandArgs(command, rawArgs));
        },
        serialize(values: SerializableArgumentValues<TDefinitions>) {
            return serializeTypedCommandArgs(
                command,
                maybeFlattenGroupedValues(values, normalizedDefinition.args),
            );
        },
        formatUsage() {
            return formatCommandUsage(command);
        },
        formatHelp() {
            return formatDetailedHelp(command);
        },
    };
    return Object.freeze(defined);
}
