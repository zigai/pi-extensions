import { cloneAndFreezeDefinitions, compileTypedCommandDefinition } from "../compiler.js";
import { parseTypedCommandArgs, serializeTypedCommandArgs } from "../parser.js";
import { formatCommandUsage, formatDetailedHelp } from "../usage.js";
import type {
    ArgumentDefinitions,
    DefinedTypedCommand,
    SerializableArgumentValues,
    TypedCommandDefinition,
} from "../types.js";
import { maybeFlattenGroupedValues, typedParseResultForDefinition } from "./grouped-values.js";
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
            return typedParseResultForDefinition(
                parseTypedCommandArgs(command, rawArgs),
                normalizedDefinition.args,
            );
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
