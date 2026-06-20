import { compileArgumentBehavior } from "./behavior.js";
import { flattenGroupedArgumentDefinitions } from "./arguments.js";
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
        const clone: Record<PropertyKey, unknown> = {};
        for (const key of Reflect.ownKeys(value)) {
            clone[key] = cloneValue((value as Record<PropertyKey, unknown>)[key]);
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

/** Deep-clone and freeze argument definitions so later caller mutation cannot affect compiled commands. */
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

class ImmutableReadonlyMap<TKey, TValue> implements ReadonlyMap<TKey, TValue> {
    readonly #entriesByKey: ReadonlyMap<TKey, TValue>;

    constructor(entries: Iterable<readonly [TKey, TValue]>) {
        this.#entriesByKey = new Map(entries);
        Object.freeze(this);
    }

    get size(): number {
        return this.#entriesByKey.size;
    }

    [Symbol.iterator](): MapIterator<[TKey, TValue]> {
        return this.#entriesByKey[Symbol.iterator]();
    }

    entries(): MapIterator<[TKey, TValue]> {
        return this.#entriesByKey.entries();
    }

    forEach(callbackfn: (value: TValue, key: TKey, map: ReadonlyMap<TKey, TValue>) => void): void {
        this.#entriesByKey.forEach((value, key) => callbackfn(value, key, this));
    }

    get(key: TKey): TValue | undefined {
        return this.#entriesByKey.get(key);
    }

    has(key: TKey): boolean {
        return this.#entriesByKey.has(key);
    }

    keys(): MapIterator<TKey> {
        return this.#entriesByKey.keys();
    }

    values(): MapIterator<TValue> {
        return this.#entriesByKey.values();
    }
}

/** Build immutable parser/completion metadata for an already accepted argument definition map. */
export function compileTypedCommandGrammar<const TDefinitions extends ArgumentDefinitions>(
    definition: Pick<TypedCommandDefinition<TDefinitions>, "name" | "description" | "args">,
): CompiledCommand<TDefinitions> {
    const flattenedDefinitions = flattenGroupedArgumentDefinitions(definition.args);
    const args = cloneAndFreezeDefinitions(flattenedDefinitions) as Readonly<TDefinitions>;
    const lookup = createArgumentLookup(args as ArgumentDefinitions);
    const argumentEntries = orderedArgumentEntries(args as ArgumentDefinitions);
    const compiledArguments = Object.freeze(
        argumentEntries.map(([name, argumentDefinition]) =>
            compileArgumentBehavior(name, argumentDefinition),
        ),
    );
    return Object.freeze({
        name: definition.name,
        description: definition.description,
        args,
        arguments: compiledArguments,
        argumentByName: new ImmutableReadonlyMap(
            compiledArguments.map((argument) => [argument.key, argument] as const),
        ),
        argumentOrder: Object.freeze(
            argumentEntries.map(([name]) => name),
        ) as readonly (keyof TDefinitions & string)[],
        positionalOrder: Object.freeze(
            positionalArgumentEntries(args as ArgumentDefinitions).map(([name]) => name),
        ) as readonly (keyof TDefinitions & string)[],
        flagToName: new ImmutableReadonlyMap(
            lookup.byFlag as ReadonlyMap<string, keyof TDefinitions & string>,
        ),
        diagnostics: Object.freeze([]),
    });
}

/** Compile and validate a command definition into immutable parser/completion metadata. */
export function compileTypedCommandDefinition<const TDefinitions extends ArgumentDefinitions>(
    definition: Pick<TypedCommandDefinition<TDefinitions>, "name" | "description" | "args">,
): CompileResult<TDefinitions> {
    const flattenedDefinitions = flattenGroupedArgumentDefinitions(definition.args);
    const diagnostics = validateArgumentDefinitions(flattenedDefinitions).map(definitionDiagnostic);
    if (diagnostics.length > 0) {
        return { ok: false, diagnostics };
    }

    return { ok: true, command: compileTypedCommandGrammar(definition) };
}

/** Compile a command definition or throw a startup-style error containing all diagnostics. */
export function assertCompiles<const TDefinitions extends ArgumentDefinitions>(
    definition: Pick<TypedCommandDefinition<TDefinitions>, "name" | "description" | "args">,
): CompiledCommand<TDefinitions> {
    const result = compileTypedCommandDefinition(definition);
    if (result.ok) {
        return result.command;
    }
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
}
