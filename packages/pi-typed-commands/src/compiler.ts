import { compileArgumentBehavior } from "./behavior.js";
import { flattenGroupedArgumentDefinitions, isArgumentGroupDefinition } from "./arguments.js";
import { diagnosticMessages } from "./diagnostics.js";
import {
    createArgumentLookup,
    orderedArgumentEntries,
    positionalArgumentEntries,
    validateArgumentDefinitions,
} from "./schema.js";
import {
    ARGUMENT_GROUP,
    type ArgumentDefinition,
    type ArgumentDefinitions,
    type ArgumentGroupDefinition,
    type ArgumentUi,
    type CompileResult,
    type CompiledCommand,
    type CoreCommandDefinition,
    type CustomArgumentWidget,
} from "./types.js";

function cloneArgumentUi(ui: ArgumentUi): ArgumentUi {
    const cloned: ArgumentUi = {};
    if (ui.widget !== undefined) {
        cloned.widget = ui.widget;
    }

    if (ui.rows !== undefined) {
        cloned.rows = ui.rows;
    }

    if (ui.title !== undefined) {
        cloned.title = ui.title;
    }

    if (ui.readOnly !== undefined) {
        cloned.readOnly = ui.readOnly;
    }

    if (ui.hidden !== undefined) {
        cloned.hidden = ui.hidden;
    }

    if (ui.visibleWhen !== undefined) {
        cloned.visibleWhen = ui.visibleWhen;
    }

    if (ui.enabledWhen !== undefined) {
        cloned.enabledWhen = ui.enabledWhen;
    }

    if (ui.requiredWhen !== undefined) {
        cloned.requiredWhen = ui.requiredWhen;
    }

    if (ui.compute !== undefined) {
        cloned.compute = ui.compute;
    }

    if (ui.disabled !== undefined) {
        cloned.disabled = ui.disabled;
    }

    if (ui.section !== undefined) {
        cloned.section = ui.section;
    }

    if (ui.advanced !== undefined) {
        cloned.advanced = ui.advanced;
    }

    if (ui.copyFrom !== undefined) {
        cloned.copyFrom = ui.copyFrom;
    }

    if (ui.custom !== undefined) {
        const custom: CustomArgumentWidget = {};
        if (ui.custom.renderValue !== undefined) {
            custom.renderValue = ui.custom.renderValue;
        }

        if (ui.custom.handleInput !== undefined) {
            custom.handleInput = ui.custom.handleInput;
        }

        cloned.custom = custom;
    }

    return cloned;
}

function cloneArgumentDefinition(definition: ArgumentDefinition): ArgumentDefinition {
    const cloned: ArgumentDefinition = { ...definition };
    if (definition.aliases !== undefined) {
        cloned.aliases = [...definition.aliases];
    }

    if (definition.examples !== undefined) {
        cloned.examples = [...definition.examples];
    }

    if (definition.ui !== undefined) {
        cloned.ui = cloneArgumentUi(definition.ui);
    }

    if (definition.complete !== undefined) {
        cloned.complete = definition.complete;
    }

    if (definition.completeAsync !== undefined) {
        cloned.completeAsync = definition.completeAsync;
    }

    if (
        cloned.type === "string" &&
        definition.type === "string" &&
        definition.pattern instanceof RegExp
    ) {
        cloned.pattern = new RegExp(definition.pattern.source, definition.pattern.flags);
    }

    if (
        cloned.type === "multi-enum" &&
        definition.type === "multi-enum" &&
        definition.default !== undefined
    ) {
        cloned.default = [...definition.default];
    }

    if (
        cloned.type === "string-list" &&
        definition.type === "string-list" &&
        definition.default !== undefined
    ) {
        cloned.default = [...definition.default];
    }

    if (
        cloned.type === "key-value" &&
        definition.type === "key-value" &&
        definition.default !== undefined
    ) {
        cloned.default = { ...definition.default };
    }

    if (cloned.type === "enum" && definition.type === "enum") {
        cloned.values = [...definition.values];
        if (definition.optionDescriptions !== undefined) {
            cloned.optionDescriptions = { ...definition.optionDescriptions };
        }
    }

    if (cloned.type === "multi-enum" && definition.type === "multi-enum") {
        cloned.values = [...definition.values];
    }

    return cloned;
}

type ArgumentGroupMetadata = {
    description?: string;
    title?: string;
};

function cloneDefinitionGraph(definitions: ArgumentDefinitions): ArgumentDefinitions {
    const cloned: Record<string, ArgumentDefinition | ArgumentGroupDefinition> = {};
    for (const [name, definition] of Object.entries(definitions)) {
        if (isArgumentGroupDefinition(definition)) {
            const args = cloneDefinitionGraph(definition.args);
            const metadata: ArgumentGroupMetadata = {};
            if (definition.title !== undefined) {
                metadata.title = definition.title;
            }

            if (definition.description !== undefined) {
                metadata.description = definition.description;
            }

            cloned[name] = {
                ...metadata,
                args,
                [ARGUMENT_GROUP]: args,
            };

            continue;
        }

        cloned[name] = cloneArgumentDefinition(definition);
    }

    return cloned;
}

function freezeArgumentDefinition(definition: ArgumentDefinition): void {
    if (definition.aliases !== undefined) {
        Object.freeze(definition.aliases);
    }

    if (definition.examples !== undefined) {
        Object.freeze(definition.examples);
    }

    if (definition.type === "multi-enum" && definition.default !== undefined) {
        Object.freeze(definition.default);
    }

    if (
        (definition.type === "string-list" || definition.type === "key-value") &&
        definition.default !== undefined
    ) {
        Object.freeze(definition.default);
    }

    if (definition.type === "enum" || definition.type === "multi-enum") {
        Object.freeze(definition.values);
    }

    if (definition.type === "enum" && definition.optionDescriptions !== undefined) {
        Object.freeze(definition.optionDescriptions);
    }

    if (definition.ui?.custom !== undefined) {
        Object.freeze(definition.ui.custom);
    }

    if (definition.ui !== undefined) {
        Object.freeze(definition.ui);
    }

    if (definition.type === "string" && definition.pattern instanceof RegExp) {
        Object.freeze(definition.pattern);
    }

    Object.freeze(definition);
}

function freezeDefinitionGraph(definitions: ArgumentDefinitions): void {
    for (const definition of Object.values(definitions)) {
        if (isArgumentGroupDefinition(definition)) {
            freezeDefinitionGraph(definition.args);
            Object.freeze(definition);
            continue;
        }

        freezeArgumentDefinition(definition);
    }

    Object.freeze(definitions);
}

/** Deep-clone and freeze argument definitions so later caller mutation cannot affect compiled commands. */
export function cloneAndFreezeDefinitions<TDefinitions extends ArgumentDefinitions>(
    definitions: TDefinitions,
): TDefinitions {
    const cloned = cloneDefinitionGraph(definitions);
    freezeDefinitionGraph(cloned);
    // SAFETY: cloneDefinitionGraph reconstructs every member of the closed ArgumentDefinitions
    // graph without changing keys, discriminants, literals, or behavior-hook references.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the closed graph is reconstructed from the same generic definition tree.
    return cloned as TDefinitions;
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
    definition: CoreCommandDefinition<TDefinitions>,
): CompiledCommand<TDefinitions> {
    const definitions = cloneAndFreezeDefinitions(definition.args);
    const args = Object.freeze(flattenGroupedArgumentDefinitions(definitions));
    const lookup = createArgumentLookup(args);
    const argumentEntries = orderedArgumentEntries(args);
    const compiledArguments = Object.freeze(
        argumentEntries.map(([name, argumentDefinition]) =>
            compileArgumentBehavior(name, argumentDefinition),
        ),
    );

    return Object.freeze({
        name: definition.name,
        description: definition.description,
        definitions,
        args,
        arguments: compiledArguments,
        argumentByName: new ImmutableReadonlyMap(
            compiledArguments.map((argument) => [argument.key, argument] as const),
        ),
        argumentOrder: Object.freeze(argumentEntries.map(([name]) => name)),
        positionalOrder: Object.freeze(positionalArgumentEntries(args).map(([name]) => name)),
        flagToName: new ImmutableReadonlyMap(lookup.byFlag),
        diagnostics: Object.freeze([]),
    });
}

/** Compile and validate a command definition into immutable parser/completion metadata. */
export function compileTypedCommandDefinition<const TDefinitions extends ArgumentDefinitions>(
    definition: CoreCommandDefinition<TDefinitions>,
): CompileResult<TDefinitions> {
    const diagnostics = validateArgumentDefinitions(definition.args);
    if (diagnostics.length > 0) {
        return { ok: false, diagnostics };
    }

    return { ok: true, command: compileTypedCommandGrammar(definition) };
}

/** Compile a command definition or throw a startup-style error containing all diagnostics. */
export function assertCompiles<const TDefinitions extends ArgumentDefinitions>(
    definition: CoreCommandDefinition<TDefinitions>,
): CompiledCommand<TDefinitions> {
    const result = compileTypedCommandDefinition(definition);
    if (result.ok) {
        return result.command;
    }

    throw new Error(diagnosticMessages(result.diagnostics).join("\n"));
}
