import { compileTypedCommandDefinition } from "../compiler.js";
import { diagnosticMessages } from "../diagnostics.js";
import type {
    ArgumentDefinitions,
    CompiledCommand,
    DefinitionDiagnostic,
    FlatArgumentDefinitions,
    TypedCommandRefinement,
} from "../types.js";
import type {
    DefinedTypedCommand,
    RegisteredTypedCommand,
    TypedCommandDefinition,
    TypedSubcommandDefinitions,
} from "../pi/command-types.js";
import { maybeWrapGroupedHandler, maybeWrapGroupedRefinement } from "./grouped-values.js";
import { DEFAULT_FORM_SYMBOLS } from "./symbols.js";

function invalidCommandSpelling(value: string): boolean {
    return value.length === 0 || /[\s\p{Cc}]/u.test(value) || value.startsWith("-");
}

/** Create a startup-style error for invalid typed command definitions. */
export function definitionError(name: string, diagnostics: readonly DefinitionDiagnostic[]): Error {
    return new Error(
        [`Invalid typed arguments for /${name}:`, ...diagnosticMessages(diagnostics)].join("\n"),
    );
}

/** Build registered metadata from the exact grammar already compiled for this definition. */
export function registeredCommandFromCompiledDefinition<TDefinitions extends ArgumentDefinitions>(
    definition: Pick<
        TypedCommandDefinition<TDefinitions>,
        "name" | "description" | "args" | "refine"
    >,
    compiled: CompiledCommand<TDefinitions>,
): RegisteredTypedCommand<TDefinitions> & { readonly compiled: CompiledCommand<TDefinitions> } {
    const refine = maybeWrapGroupedRefinement(definition.args, definition.refine);
    const refinementFields: {
        refine?: TypedCommandRefinement<FlatArgumentDefinitions>;
    } = {};
    if (refine !== undefined) {
        refinementFields.refine = refine;
    }
    const command: RegisteredTypedCommand<TDefinitions> & {
        readonly compiled: CompiledCommand<TDefinitions>;
    } = {
        name: definition.name,
        description: definition.description,
        args: compiled.args,
        compiled,
        hasRootHandler: true,
        formSymbols: DEFAULT_FORM_SYMBOLS,
        ...refinementFields,
    };
    return command;
}

function mergeArgumentDefinitions<
    TShared extends ArgumentDefinitions,
    TLocal extends ArgumentDefinitions,
>(shared: TShared, local: TLocal, subcommandName: string): TShared & TLocal {
    for (const name of Object.keys(local)) {
        if (Object.hasOwn(shared, name)) {
            throw new TypeError(
                `Subcommand ${subcommandName} argument ${name} conflicts with a shared argument`,
            );
        }
    }
    return { ...shared, ...local };
}

function combineRefinements(
    shared: TypedCommandRefinement<FlatArgumentDefinitions> | undefined,
    branch: TypedCommandRefinement<FlatArgumentDefinitions> | undefined,
): TypedCommandRefinement<FlatArgumentDefinitions> | undefined {
    if (shared === undefined) return branch;
    if (branch === undefined) return shared;
    return (args, context) => [...shared(args, context), ...branch(args, context)];
}

function normalizeSubcommands<
    TDefinitions extends ArgumentDefinitions,
    TSubcommands extends TypedSubcommandDefinitions<TDefinitions>,
>(
    definition:
        | TypedCommandDefinition<TDefinitions, TSubcommands>
        | DefinedTypedCommand<TDefinitions, TSubcommands>,
    sharedDefinitions: TDefinitions,
): Readonly<Record<string, RegisteredTypedCommand>> | undefined {
    const definitions = definition.subcommands;
    if (definitions === undefined) {
        return undefined;
    }

    const normalizedEntries: Array<readonly [string, RegisteredTypedCommand]> = [];
    const names = new Set<string>();
    const sharedRefine = maybeWrapGroupedRefinement(sharedDefinitions, definition.refine);
    for (const name in definitions) {
        if (!Object.hasOwn(definitions, name)) {
            continue;
        }
        const subcommand = definitions[name];
        if (invalidCommandSpelling(name)) {
            throw new TypeError(`Invalid subcommand name ${JSON.stringify(name)}`);
        }
        const spellings = [name, ...(subcommand.aliases ?? [])];
        for (const spelling of spellings) {
            if (invalidCommandSpelling(spelling)) {
                throw new TypeError(`Invalid subcommand alias ${JSON.stringify(spelling)}`);
            }
            if (names.has(spelling)) {
                throw new TypeError(`Duplicate subcommand name or alias ${spelling}`);
            }
            names.add(spelling);
        }

        const args = mergeArgumentDefinitions(sharedDefinitions, subcommand.args, name);
        const compiled = compileTypedCommandDefinition({
            name: `${definition.name} ${name}`,
            description: subcommand.description,
            args,
        });
        if (!compiled.ok) {
            throw definitionError(`${definition.name} ${name}`, compiled.diagnostics);
        }
        const branchRefine = maybeWrapGroupedRefinement(args, subcommand.refine);
        const refine = combineRefinements(sharedRefine, branchRefine);
        const subcommandFields: {
            refine?: TypedCommandRefinement<FlatArgumentDefinitions>;
            formTitle?: NonNullable<typeof subcommand.formTitle>;
            formPolicy?: NonNullable<typeof subcommand.formPolicy>;
            formPresets?: boolean;
            inlineHelp?: NonNullable<typeof subcommand.inlineHelp>;
            ghostText?: NonNullable<typeof subcommand.ghostText>;
        } = {};
        if (refine !== undefined) {
            subcommandFields.refine = refine;
        }
        if (subcommand.formTitle !== undefined) {
            subcommandFields.formTitle = subcommand.formTitle;
        }
        if (subcommand.formPolicy !== undefined) {
            subcommandFields.formPolicy = subcommand.formPolicy;
        }
        if (subcommand.formPresets !== undefined) {
            subcommandFields.formPresets = subcommand.formPresets;
        }
        if (subcommand.inlineHelp !== undefined) {
            subcommandFields.inlineHelp = subcommand.inlineHelp;
        }
        if (subcommand.ghostText !== undefined) {
            subcommandFields.ghostText = subcommand.ghostText;
        }
        normalizedEntries.push([
            name,
            {
                name: `${definition.name} ${name}`,
                description: subcommand.description,
                aliases: Object.freeze([...(subcommand.aliases ?? [])]),
                args: compiled.command.args,
                compiled: compiled.command,
                formSymbols: { ...DEFAULT_FORM_SYMBOLS, ...subcommand.formSymbols },
                source: "extension",
                target: {
                    kind: "extension",
                    run: maybeWrapGroupedHandler(args, subcommand.run),
                },
                ...subcommandFields,
            },
        ]);
    }
    if (normalizedEntries.length === 0) {
        throw new TypeError(`Typed command /${definition.name} must not define empty subcommands`);
    }
    return Object.freeze(Object.fromEntries(normalizedEntries));
}

/** Normalize a user command definition into metadata consumed by Pi registration and UX adapters. */
export function normalizeRegisteredCommand<
    TDefinitions extends ArgumentDefinitions,
    TSubcommands extends TypedSubcommandDefinitions<TDefinitions>,
>(
    definition:
        | TypedCommandDefinition<TDefinitions, TSubcommands>
        | DefinedTypedCommand<TDefinitions, TSubcommands>,
): RegisteredTypedCommand<TDefinitions> & { readonly compiled: CompiledCommand<TDefinitions> } {
    if (invalidCommandSpelling(definition.name)) {
        throw new TypeError(`Invalid command name ${JSON.stringify(definition.name)}`);
    }
    const compiled = compileTypedCommandDefinition({
        name: definition.name,
        description: definition.description,
        args: definition.args,
    });
    if (!compiled.ok) {
        throw definitionError(definition.name, compiled.diagnostics);
    }

    const refine = maybeWrapGroupedRefinement(definition.args, definition.refine);
    const formTitle = definition.formTitle;
    const optionalFields: {
        refine?: TypedCommandRefinement<FlatArgumentDefinitions>;
        formTitle?: NonNullable<TypedCommandDefinition<TDefinitions>["formTitle"]>;
        formPolicy?: NonNullable<TypedCommandDefinition<TDefinitions>["formPolicy"]>;
        formPresets?: boolean;
        inlineHelp?: NonNullable<TypedCommandDefinition<TDefinitions>["inlineHelp"]>;
        ghostText?: NonNullable<TypedCommandDefinition<TDefinitions>["ghostText"]>;
    } = {};
    if (refine !== undefined) {
        optionalFields.refine = refine;
    }
    if (formTitle !== undefined) {
        optionalFields.formTitle = formTitle;
    }
    if (definition.formPolicy !== undefined) {
        optionalFields.formPolicy = definition.formPolicy;
    }
    if (definition.formPresets !== undefined) {
        optionalFields.formPresets = definition.formPresets;
    }
    if (definition.inlineHelp !== undefined) {
        optionalFields.inlineHelp = definition.inlineHelp;
    }
    if (definition.ghostText !== undefined) {
        optionalFields.ghostText = definition.ghostText;
    }
    const run = definition.run;
    if (run === undefined && definition.subcommands === undefined) {
        throw new TypeError(`Typed command /${definition.name} must define run or subcommands`);
    }

    let target: RegisteredTypedCommand<TDefinitions>["target"];
    if (run !== undefined) {
        target = {
            kind: "extension",
            run: maybeWrapGroupedHandler(definition.args, run),
        };
    }
    const subcommands = normalizeSubcommands(definition, compiled.command.definitions);
    if (
        subcommands !== undefined &&
        Object.values(compiled.command.args).some((argument) => argument.position !== undefined)
    ) {
        throw new TypeError(
            `Typed command /${definition.name} may not combine shared positional arguments with subcommands`,
        );
    }
    const routingFields: {
        target?: NonNullable<RegisteredTypedCommand<TDefinitions>["target"]>;
        subcommands?: Readonly<Record<string, RegisteredTypedCommand>>;
    } = {};
    if (target !== undefined) {
        routingFields.target = target;
    }
    if (subcommands !== undefined) {
        routingFields.subcommands = subcommands;
    }
    const command: RegisteredTypedCommand<TDefinitions> & {
        readonly compiled: CompiledCommand<TDefinitions>;
    } = {
        name: definition.name,
        description: definition.description,
        args: compiled.command.args,
        compiled: compiled.command,
        formSymbols: { ...DEFAULT_FORM_SYMBOLS, ...definition.formSymbols },
        source: "extension",
        hasRootHandler: run !== undefined,
        ...optionalFields,
        ...routingFields,
    };
    return command;
}
