import { compileTypedCommandDefinition } from "../compiler.js";
import {
    parseTypedCommandInvocation,
    serializeTypedCommandArgs,
    toTypedParseResult,
} from "../parser.js";
import { formatCommandUsage, formatDetailedHelp } from "../usage.js";
import type { ArgumentDefinitions, SerializableArgumentValues } from "../types.js";
import type {
    DefinedTypedCommand,
    SerializableSubcommandInvocation,
    TypedCommandParseResult,
    TypedCommandDefinition,
    TypedSubcommandDefinitions,
} from "../pi/command-types.js";
import { definitionError, normalizeRegisteredCommand } from "./registered-command.js";

/** Define a typed command once, preserving literal argument inference and exposing pure helpers. */
export function defineTypedCommand<
    const TDefinitions extends ArgumentDefinitions,
    const TSubcommands extends TypedSubcommandDefinitions<TDefinitions>,
>(
    definition: TypedCommandDefinition<TDefinitions, TSubcommands>,
): DefinedTypedCommand<TDefinitions, TSubcommands> {
    const compiled = compileTypedCommandDefinition(definition);
    if (!compiled.ok) {
        throw definitionError(definition.name, compiled.diagnostics);
    }

    const normalizedDefinition: TypedCommandDefinition<TDefinitions, TSubcommands> = {
        ...definition,
        args: compiled.command.definitions,
    };
    const command = normalizeRegisteredCommand(normalizedDefinition);
    const defined = {
        ...normalizedDefinition,
        parse(rawArgs: string) {
            const invocation = parseTypedCommandInvocation(command, rawArgs);
            const grammar = invocation.route.command.compiled;
            if (grammar === undefined) {
                throw new TypeError("Selected typed-command grammar is unavailable");
            }
            const parsed = toTypedParseResult(grammar, invocation.parsed);
            if (invocation.route.status !== "subcommand") {
                // SAFETY: root parsing used the root generic grammar compiled from TDefinitions.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: route status proves the root grammar.
                return parsed as TypedCommandParseResult<TDefinitions, TSubcommands>;
            }
            // SAFETY: normalizeRegisteredCommand compiled every named TSubcommands branch from its
            // exact merged shared/local definitions; the route supplies that same canonical name.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: selected route and grammar are compiled from the same subcommand entry.
            return {
                ...parsed,
                subcommand: invocation.route.subcommand,
            } as TypedCommandParseResult<TDefinitions, TSubcommands>;
        },
        serialize(values: SerializableArgumentValues<TDefinitions>) {
            return serializeTypedCommandArgs(command, values);
        },
        serializeSubcommand(
            invocation: SerializableSubcommandInvocation<TDefinitions, TSubcommands>,
        ) {
            const name = String(invocation.subcommand);
            const subcommands = command.subcommands;
            if (subcommands === undefined || !Object.hasOwn(subcommands, name)) {
                throw new TypeError(`Unknown subcommand ${name}`);
            }
            const subcommand = subcommands[name];
            if (subcommand === undefined) {
                throw new TypeError(`Unknown subcommand ${name}`);
            }
            const serialized = serializeTypedCommandArgs(subcommand, invocation.args);
            if (serialized.length === 0) {
                return name;
            }
            return `${name} ${serialized}`;
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
