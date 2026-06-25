import { flattenGroupedArgumentDefinitions } from "../arguments.js";
import { compileTypedCommandDefinition } from "../compiler.js";
import { diagnosticMessages } from "../diagnostics.js";
import type {
    ArgumentDefinitions,
    DefinitionDiagnostic,
    DefinedTypedCommand,
    RegisteredTypedCommand,
    TypedCommandDefinition,
} from "../types.js";
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
): RegisteredTypedCommand<TDefinitions> {
    const compiled = compileTypedCommandDefinition(definition);
    if (!compiled.ok) {
        throw definitionError(definition.name, compiled.diagnostics);
    }
    const command: RegisteredTypedCommand<TDefinitions> = {
        name: definition.name,
        description: definition.description,
        args: compiled.command.args as TDefinitions,
        compiled: compiled.command,
        target: { kind: "extension", run: () => {} },
        formSymbols: DEFAULT_FORM_SYMBOLS,
    };
    const refine = maybeWrapGroupedRefinement(definition.args, definition.refine);
    if (refine !== undefined) {
        command.refine = refine;
    }
    return command;
}

/** Normalize a user command definition into metadata consumed by Pi registration and UX adapters. */
export function normalizeRegisteredCommand<TDefinitions extends ArgumentDefinitions>(
    definition: TypedCommandDefinition<TDefinitions> | DefinedTypedCommand<TDefinitions>,
): RegisteredTypedCommand<TDefinitions> {
    const runtimeArgs = flattenGroupedArgumentDefinitions(definition.args) as TDefinitions;
    const compiled = compileTypedCommandDefinition({
        name: definition.name,
        description: definition.description,
        args: runtimeArgs,
    });
    if (!compiled.ok) {
        throw definitionError(definition.name, compiled.diagnostics);
    }

    const command: RegisteredTypedCommand<TDefinitions> = {
        name: definition.name,
        description: definition.description,
        args: compiled.command.args as TDefinitions,
        compiled: compiled.command,
        target: {
            kind: "extension",
            run: maybeWrapGroupedHandler(definition.args, definition.run),
        },
        formSymbols: { ...DEFAULT_FORM_SYMBOLS, ...definition.formSymbols },
        source: "extension",
    };

    const refine = maybeWrapGroupedRefinement(definition.args, definition.refine);
    if (refine !== undefined) {
        command.refine = refine;
    }
    if (definition.formTitle !== undefined) {
        command.formTitle = definition.formTitle;
    }
    return command;
}
