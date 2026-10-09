import type { ArgumentDefinitions, SerializableArgumentValues } from "../types.js";
import type {
    DefinedTypedCommand,
    RegisteredTypedCommand,
    TypedCommandHandle,
    TypedSubcommandDefinitions,
} from "../pi/command-types.js";

/** Create the disposable handle returned from typed command registration. */
export function createCommandHandle<
    TDefinitions extends ArgumentDefinitions,
    TSubcommands extends TypedSubcommandDefinitions<TDefinitions>,
>(
    definition: DefinedTypedCommand<TDefinitions, TSubcommands>,
    command: RegisteredTypedCommand<TDefinitions>,
    invocationName: string,
    unregister: (command: RegisteredTypedCommand<TDefinitions>) => void,
): TypedCommandHandle<TDefinitions, TSubcommands> {
    let disposed = false;

    return Object.freeze({
        definition,
        invocationName,
        parse(rawArgs: string) {
            return definition.parse(rawArgs);
        },
        serialize(values: SerializableArgumentValues<TDefinitions>) {
            return definition.serialize(values);
        },
        serializeSubcommand(invocation) {
            return definition.serializeSubcommand(invocation);
        },
        formatUsage() {
            return definition.formatUsage();
        },
        formatHelp() {
            return definition.formatHelp();
        },
        dispose() {
            if (disposed) {
                return;
            }

            disposed = true;
            unregister(command);
        },
    });
}
