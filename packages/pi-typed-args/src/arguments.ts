import {
    ARGUMENT_GROUP,
    type ArgumentDefinition,
    type ArgumentDefinitions,
    type ArgumentGroupDefinition,
    type BooleanArgumentDefinition,
    type EnumArgumentDefinition,
    type FlatArgumentDefinitions,
    type MultiEnumArgumentDefinition,
    type StringListArgumentDefinition,
    type KeyValueArgumentDefinition,
    type NumberArgumentDefinition,
    type StringArgumentDefinition,
} from "./types.ts";

type DistributiveOmit<TValue, TKey extends PropertyKey> = TValue extends unknown
    ? Omit<TValue, TKey>
    : never;

type ArgumentOptions<TDefinition extends ArgumentDefinition> = DistributiveOmit<
    TDefinition,
    "type"
>;

type EnumArgumentOptions<TValues extends readonly string[]> = DistributiveOmit<
    EnumArgumentDefinition<TValues>,
    "type" | "values"
>;

type MultiEnumArgumentOptions<TValues extends readonly string[]> = DistributiveOmit<
    MultiEnumArgumentDefinition<TValues>,
    "type" | "values"
>;

export function stringArgument<const TOptions extends ArgumentOptions<StringArgumentDefinition>>(
    options: TOptions,
): StringArgumentDefinition & TOptions;
export function stringArgument(): StringArgumentDefinition;
export function stringArgument(
    options: ArgumentOptions<StringArgumentDefinition> = {},
): StringArgumentDefinition {
    return { type: "string", ...options };
}

export function numberArgument<const TOptions extends ArgumentOptions<NumberArgumentDefinition>>(
    options: TOptions,
): NumberArgumentDefinition & TOptions;
export function numberArgument(): NumberArgumentDefinition;
export function numberArgument(
    options: ArgumentOptions<NumberArgumentDefinition> = {},
): NumberArgumentDefinition {
    return { type: "number", ...options };
}

export function booleanArgument<const TOptions extends ArgumentOptions<BooleanArgumentDefinition>>(
    options: TOptions,
): BooleanArgumentDefinition & TOptions;
export function booleanArgument(): BooleanArgumentDefinition;
export function booleanArgument(
    options: ArgumentOptions<BooleanArgumentDefinition> = {},
): BooleanArgumentDefinition {
    return { type: "boolean", ...options };
}

export function enumArgument<
    const TValues extends readonly string[],
    const TOptions extends EnumArgumentOptions<TValues>,
>(values: TValues, options: TOptions): EnumArgumentDefinition<TValues> & TOptions;
export function enumArgument<const TValues extends readonly string[]>(
    values: TValues,
): EnumArgumentDefinition<TValues>;
export function enumArgument<const TValues extends readonly string[]>(
    values: TValues,
    options: EnumArgumentOptions<TValues> = {},
): EnumArgumentDefinition<TValues> {
    return { type: "enum", values, ...options };
}

export function multiEnumArgument<
    const TValues extends readonly string[],
    const TOptions extends MultiEnumArgumentOptions<TValues>,
>(values: TValues, options: TOptions): MultiEnumArgumentDefinition<TValues> & TOptions;
export function multiEnumArgument<const TValues extends readonly string[]>(
    values: TValues,
): MultiEnumArgumentDefinition<TValues>;
export function multiEnumArgument<const TValues extends readonly string[]>(
    values: TValues,
    options: MultiEnumArgumentOptions<TValues> = {},
): MultiEnumArgumentDefinition<TValues> {
    return { type: "multi-enum", values, ...options };
}

export function stringListArgument<
    const TOptions extends ArgumentOptions<StringListArgumentDefinition>,
>(options: TOptions): StringListArgumentDefinition & TOptions;
export function stringListArgument(): StringListArgumentDefinition;
export function stringListArgument(
    options: ArgumentOptions<StringListArgumentDefinition> = {},
): StringListArgumentDefinition {
    return { type: "string-list", ...options };
}

export function keyValueArgument<
    const TOptions extends ArgumentOptions<KeyValueArgumentDefinition>,
>(options: TOptions): KeyValueArgumentDefinition & TOptions;
export function keyValueArgument(): KeyValueArgumentDefinition;
export function keyValueArgument(
    options: ArgumentOptions<KeyValueArgumentDefinition> = {},
): KeyValueArgumentDefinition {
    return { type: "key-value", ...options };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function group<const TDefinitions extends ArgumentDefinitions>(
    args: TDefinitions,
    options: Pick<ArgumentGroupDefinition<TDefinitions>, "title" | "description"> = {},
): ArgumentGroupDefinition<TDefinitions> {
    return {
        ...options,
        args,
        [ARGUMENT_GROUP]: args,
    };
}

export function isArgumentGroupDefinition(
    definition: unknown,
): definition is ArgumentGroupDefinition {
    return isRecord(definition) && ARGUMENT_GROUP in definition && isRecord(definition.args);
}

export function hasArgumentGroups(definitions: ArgumentDefinitions): boolean {
    return Object.values(definitions).some(isArgumentGroupDefinition);
}

function groupedKey(prefix: string, name: string): string {
    if (prefix.length === 0) {
        return name;
    }

    return `${prefix}.${name}`;
}

export type UnknownGroupedArgumentDefinitionEntry = {
    readonly key: string;
    readonly definition: unknown;
    readonly sourcePath: readonly string[];
};

/** Collect parser-facing paths without erasing duplicate canonical keys. */
export function collectUnknownGroupedArgumentDefinitions(
    definitions: Readonly<Record<string, unknown>>,
    prefix = "",
    sourcePrefix: readonly string[] = [],
): readonly UnknownGroupedArgumentDefinitionEntry[] {
    const entries: UnknownGroupedArgumentDefinitionEntry[] = [];
    for (const [name, definition] of Object.entries(definitions)) {
        const key = groupedKey(prefix, name);
        const sourcePath = [...sourcePrefix, name];
        if (isRecord(definition) && ARGUMENT_GROUP in definition && isRecord(definition.args)) {
            entries.push(
                ...collectUnknownGroupedArgumentDefinitions(definition.args, key, sourcePath),
            );
            continue;
        }

        entries.push({ key, definition, sourcePath });
    }

    return entries;
}

function assignUniqueDefinition(
    flattened: Record<string, ArgumentDefinition>,
    key: string,
    definition: ArgumentDefinition,
): void {
    if (Object.hasOwn(flattened, key)) {
        throw new TypeError(`Duplicate canonical argument path ${key}`);
    }

    Object.defineProperty(flattened, key, {
        configurable: true,
        enumerable: true,
        value: definition,
        writable: true,
    });
}

function flattenGroupedArgumentDefinitionsInto(
    flattened: Record<string, ArgumentDefinition>,
    definitions: ArgumentDefinitions,
    prefix: string,
    section?: string,
): void {
    for (const [name, definition] of Object.entries(definitions)) {
        const key = groupedKey(prefix, name);
        if (isArgumentGroupDefinition(definition)) {
            const ownSection = definition.title ?? key;
            let nextSection = ownSection;
            if (section !== undefined) {
                nextSection = `${section} › ${ownSection}`;
            }

            flattenGroupedArgumentDefinitionsInto(flattened, definition.args, key, nextSection);
            continue;
        }

        if (section !== undefined && definition.ui?.section === undefined) {
            assignUniqueDefinition(flattened, key, {
                ...definition,
                ui: { ...definition.ui, section },
            });
            continue;
        }

        assignUniqueDefinition(flattened, key, definition);
    }
}

export function flattenGroupedArgumentDefinitions(
    definitions: ArgumentDefinitions,
    prefix = "",
): FlatArgumentDefinitions {
    const flattened: Record<string, ArgumentDefinition> = {};
    flattenGroupedArgumentDefinitionsInto(flattened, definitions, prefix);
    return flattened;
}

function flattenGroupedArgumentValuesUnchecked(
    values: Readonly<Record<string, unknown>>,
    definitions: ArgumentDefinitions,
    prefix: string,
): Record<string, unknown> {
    const flattened: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(definitions)) {
        const key = groupedKey(prefix, name);
        if (isArgumentGroupDefinition(definition)) {
            const nested = values[name];
            if (isRecord(nested)) {
                const nestedValues = flattenGroupedArgumentValuesUnchecked(
                    nested,
                    definition.args,
                    key,
                );
                for (const [nestedName, nestedValue] of Object.entries(nestedValues)) {
                    Object.defineProperty(flattened, nestedName, {
                        configurable: true,
                        enumerable: true,
                        value: nestedValue,
                        writable: true,
                    });
                }
            }
            continue;
        }

        let value: unknown;
        if (Object.hasOwn(values, name)) {
            value = values[name];
        }

        Object.defineProperty(flattened, key, {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
        });
    }

    return flattened;
}

export function flattenGroupedArgumentValues(
    values: Readonly<Record<string, unknown>>,
    definitions: ArgumentDefinitions,
    prefix = "",
): Record<string, unknown> {
    flattenGroupedArgumentDefinitions(definitions, prefix);
    return flattenGroupedArgumentValuesUnchecked(values, definitions, prefix);
}

function expandGroupedArgumentValuesUnchecked(
    values: Readonly<Record<string, unknown>>,
    definitions: ArgumentDefinitions,
    prefix: string,
): Record<string, unknown> {
    const expanded: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(definitions)) {
        const key = groupedKey(prefix, name);
        let value: unknown;
        if (Object.hasOwn(values, key)) {
            value = values[key];
        }

        if (isArgumentGroupDefinition(definition)) {
            value = expandGroupedArgumentValuesUnchecked(values, definition.args, key);
        }

        Object.defineProperty(expanded, name, {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
        });
    }

    return expanded;
}

export function expandGroupedArgumentValues(
    values: Readonly<Record<string, unknown>>,
    definitions: ArgumentDefinitions,
    prefix = "",
): Record<string, unknown> {
    flattenGroupedArgumentDefinitions(definitions, prefix);
    return expandGroupedArgumentValuesUnchecked(values, definitions, prefix);
}
