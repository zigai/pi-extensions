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
} from "../pi/command-types.js";
import { maybeWrapGroupedHandler, maybeWrapGroupedRefinement } from "./grouped-values.js";
import { DEFAULT_FORM_SYMBOLS } from "./symbols.js";

/** Create a startup-style error for invalid typed command definitions. */
export function definitionError(name: string, diagnostics: readonly DefinitionDiagnostic[]): Error {
    return new Error(
        [`Invalid typed arguments for /${name}:`, ...diagnosticMessages(diagnostics)].join("\n"),
    );
}

/** Compile a definition into normalized registered-command metadata used by pure helpers. */
export function registeredCommandForDefinition<TDefinitions extends ArgumentDefinitions>(
    definition: Pick<
        TypedCommandDefinition<TDefinitions>,
        "name" | "description" | "args" | "refine"
    >,
): RegisteredTypedCommand<TDefinitions> & { readonly compiled: CompiledCommand<TDefinitions> } {
    const compiled = compileTypedCommandDefinition(definition);
    if (!compiled.ok) {
        throw definitionError(definition.name, compiled.diagnostics);
    }
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
        args: compiled.command.args,
        compiled: compiled.command,
        formSymbols: DEFAULT_FORM_SYMBOLS,
        ...refinementFields,
    };
    return command;
}

/** Normalize a user command definition into metadata consumed by Pi registration and UX adapters. */
export function normalizeRegisteredCommand<TDefinitions extends ArgumentDefinitions>(
    definition: TypedCommandDefinition<TDefinitions> | DefinedTypedCommand<TDefinitions>,
): RegisteredTypedCommand<TDefinitions> & { readonly compiled: CompiledCommand<TDefinitions> } {
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
    } = {};
    if (refine !== undefined) {
        optionalFields.refine = refine;
    }
    if (formTitle !== undefined) {
        optionalFields.formTitle = formTitle;
    }
    const command: RegisteredTypedCommand<TDefinitions> & {
        readonly compiled: CompiledCommand<TDefinitions>;
    } = {
        name: definition.name,
        description: definition.description,
        args: compiled.command.args,
        compiled: compiled.command,
        target: {
            kind: "extension",
            run: maybeWrapGroupedHandler(definition.args, definition.run),
        },
        formSymbols: { ...DEFAULT_FORM_SYMBOLS, ...definition.formSymbols },
        source: "extension",
        ...optionalFields,
    };
    return command;
}
