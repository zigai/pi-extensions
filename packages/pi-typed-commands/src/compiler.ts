import {
    createArgumentLookup,
    orderedArgumentEntries,
    positionalArgumentEntries,
    validateArgumentDefinitions,
} from "./schema.js";
import type {
    ArgumentDefinitions,
    CompileResult,
    CompiledCommand,
    DefinitionDiagnostic,
    TypedCommandDefinition,
} from "./types.js";

function cloneValue<T>(value: T): T {
    if (value instanceof RegExp) {
        return new RegExp(value.source, value.flags) as T;
    }
    if (Array.isArray(value)) {
        const items = value as readonly unknown[];
        return items.map((item) => cloneValue(item)) as T;
    }
    if (typeof value === "object" && value !== null) {
        const clone: Record<string, unknown> = {};
        for (const [key, nested] of Object.entries(value)) {
            clone[key] = cloneValue(nested);
        }
        return clone as T;
    }
    return value;
}

function freezeValue<T>(value: T): T {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
        return value;
    }
    for (const nested of Object.values(value)) {
        freezeValue(nested);
    }
    return Object.freeze(value);
}

export function cloneAndFreezeDefinitions<TDefinitions extends ArgumentDefinitions>(
    definitions: TDefinitions,
): Readonly<TDefinitions> {
    return freezeValue(cloneValue(definitions));
}

function diagnosticPathFromMessage(message: string): readonly (string | number)[] {
    const match = /^([^:\s]+)(?:[.:][^:\s]+)?/.exec(message);
    if (match?.[1] !== undefined) {
        return [match[1]];
    }
    return [];
}

function definitionDiagnostic(message: string): DefinitionDiagnostic {
    return {
        code: "definition.invalid",
        message,
        path: diagnosticPathFromMessage(message),
        severity: "error",
    };
}

export function compileTypedCommandDefinition<const TDefinitions extends ArgumentDefinitions>(
    definition: Pick<TypedCommandDefinition<TDefinitions>, "name" | "description" | "args">,
): CompileResult<TDefinitions> {
    const diagnostics = validateArgumentDefinitions(definition.args).map(definitionDiagnostic);
    if (diagnostics.length > 0) {
        return { ok: false, diagnostics };
    }

    const args = cloneAndFreezeDefinitions(definition.args) as Readonly<TDefinitions>;
    const lookup = createArgumentLookup(args as ArgumentDefinitions);
    const command: CompiledCommand<TDefinitions> = Object.freeze({
        name: definition.name,
        description: definition.description,
        args,
        argumentOrder: Object.freeze(
            orderedArgumentEntries(args as ArgumentDefinitions).map(([name]) => name),
        ) as readonly (keyof TDefinitions & string)[],
        positionalOrder: Object.freeze(
            positionalArgumentEntries(args as ArgumentDefinitions).map(([name]) => name),
        ) as readonly (keyof TDefinitions & string)[],
        flagToName: lookup.byFlag as ReadonlyMap<string, keyof TDefinitions & string>,
        diagnostics: Object.freeze([]),
    });
    return { ok: true, command };
}

export function assertCompiles<const TDefinitions extends ArgumentDefinitions>(
    definition: Pick<TypedCommandDefinition<TDefinitions>, "name" | "description" | "args">,
): CompiledCommand<TDefinitions> {
    const result = compileTypedCommandDefinition(definition);
    if (result.ok) {
        return result.command;
    }
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
}
