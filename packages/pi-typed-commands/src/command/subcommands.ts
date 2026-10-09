import { lexTypedArgumentString } from "../parser.js";
import type { CoreRegisteredTypedCommand } from "../types.js";

export type TypedCommandRoute<TCommand extends CoreRegisteredTypedCommand> = {
    readonly root: TCommand;
    readonly command: CoreRegisteredTypedCommand;
    readonly rawArgs: string;
    readonly subcommand?: string;
    readonly token?: string;
    readonly status: "root" | "subcommand" | "missing" | "unknown";
};

/** Resolve the first argument token against a command's CLI-style subcommands. */
export function resolveTypedCommandRoute<TCommand extends CoreRegisteredTypedCommand>(
    command: TCommand,
    rawArgs: string,
): TypedCommandRoute<TCommand> {
    const subcommands = command.subcommands;
    if (subcommands === undefined) {
        return { root: command, command, rawArgs, status: "root" };
    }

    const first = lexTypedArgumentString(rawArgs).tokens[0];
    if (first !== undefined && first.quote === undefined && !first.value.startsWith("-")) {
        for (const [name, subcommand] of Object.entries(subcommands)) {
            if (first.value === name || subcommand.aliases?.includes(first.value) === true) {
                return {
                    root: command,
                    command: subcommand,
                    rawArgs: rawArgs.slice(first.end).trimStart(),
                    subcommand: name,
                    token: first.value,
                    status: "subcommand",
                };
            }
        }

        return {
            root: command,
            command,
            rawArgs,
            token: first.value,
            status: "unknown",
        };
    }

    if (command.hasRootHandler === true) {
        return { root: command, command, rawArgs, status: "root" };
    }

    return { root: command, command, rawArgs, status: "missing" };
}

/** Return a subcommand by canonical name or alias. */
export function findTypedSubcommand(
    command: CoreRegisteredTypedCommand,
    spelling: string,
): readonly [string, CoreRegisteredTypedCommand] | undefined {
    for (const [name, subcommand] of Object.entries(command.subcommands ?? {})) {
        if (name === spelling || subcommand.aliases?.includes(spelling) === true) {
            return [name, subcommand];
        }
    }

    return undefined;
}
