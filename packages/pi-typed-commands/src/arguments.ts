import {
    ARGUMENT_GROUP,
    type ArgumentDefinition,
    type ArgumentDefinitions,
    type ArgumentGroupDefinition,
    type ArgumentValue,
    type BooleanArgumentDefinition,
    type EnumArgumentDefinition,
    type MultiEnumArgumentDefinition,
    type NumberArgumentDefinition,
    type StringArgumentDefinition,
} from "./types.js";

/** Create a string argument definition while preserving literal option types for inference. */
export function stringArgument<const TOptions extends Omit<StringArgumentDefinition, "type">>(
    options: TOptions,
): StringArgumentDefinition & TOptions;
export function stringArgument(): StringArgumentDefinition;
export function stringArgument(
    options: Omit<StringArgumentDefinition, "type"> = {},
): StringArgumentDefinition {
    return { type: "string", ...options };
}

/** Create a number argument definition while preserving literal option types for inference. */
export function numberArgument<const TOptions extends Omit<NumberArgumentDefinition, "type">>(
    options: TOptions,
): NumberArgumentDefinition & TOptions;
export function numberArgument(): NumberArgumentDefinition;
export function numberArgument(
    options: Omit<NumberArgumentDefinition, "type"> = {},
): NumberArgumentDefinition {
    return { type: "number", ...options };
}

/** Create a boolean flag definition while preserving literal option types for inference. */
export function booleanArgument<const TOptions extends Omit<BooleanArgumentDefinition, "type">>(
    options: TOptions,
): BooleanArgumentDefinition & TOptions;
export function booleanArgument(): BooleanArgumentDefinition;
export function booleanArgument(
    options: Omit<BooleanArgumentDefinition, "type"> = {},
): BooleanArgumentDefinition {
    return { type: "boolean", ...options };
}

/** Create an enum definition whose readonly values are reflected in handler value types. */
export function enumArgument<
    const TValues extends readonly string[],
    const TOptions extends Omit<EnumArgumentDefinition<TValues>, "type" | "values">,
>(values: TValues, options: TOptions): EnumArgumentDefinition<TValues> & TOptions;
export function enumArgument<const TValues extends readonly string[]>(
    values: TValues,
): EnumArgumentDefinition<TValues>;
export function enumArgument<const TValues extends readonly string[]>(
    values: TValues,
    options: Omit<EnumArgumentDefinition<TValues>, "type" | "values"> = {},
): EnumArgumentDefinition<TValues> {
    return { type: "enum", values, ...options };
}

/** Create a multi-enum definition whose readonly values are reflected in selected value types. */
export function multiEnumArgument<
    const TValues extends readonly string[],
    const TOptions extends Omit<MultiEnumArgumentDefinition<TValues>, "type" | "values">,
>(values: TValues, options: TOptions): MultiEnumArgumentDefinition<TValues> & TOptions;
export function multiEnumArgument<const TValues extends readonly string[]>(
    values: TValues,
): MultiEnumArgumentDefinition<TValues>;
export function multiEnumArgument<const TValues extends readonly string[]>(
    values: TValues,
    options: Omit<MultiEnumArgumentDefinition<TValues>, "type" | "values"> = {},
): MultiEnumArgumentDefinition<TValues> {
    return { type: "multi-enum", values, ...options };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Group nested argument definitions while preserving nested handler value inference. */
export function group<const TDefinitions extends ArgumentDefinitions>(
    args: TDefinitions,
    options: Pick<ArgumentGroupDefinition<TDefinitions>, "title" | "description"> = {},
): ArgumentDefinition & ArgumentGroupDefinition<TDefinitions> {
    return {
        ...options,
        args,
        [ARGUMENT_GROUP]: args,
    } as unknown as ArgumentDefinition & ArgumentGroupDefinition<TDefinitions>;
}

/** Return whether an unknown value is a grouped definition produced by `group()`. */
export function isArgumentGroupDefinition(
    definition: unknown,
): definition is ArgumentGroupDefinition {
    return isRecord(definition) && ARGUMENT_GROUP in definition && isRecord(definition.args);
}

/** Return whether an argument definition map contains at least one grouped definition. */
export function hasArgumentGroups(definitions: ArgumentDefinitions): boolean {
    return Object.values(definitions).some(isArgumentGroupDefinition);
}

function groupedKey(prefix: string, name: string): string {
    if (prefix.length === 0) {
        return name;
    }
    return `${prefix}.${name}`;
}

/** Flatten grouped definitions into parser-facing dotted argument names such as `database.host`. */
export function flattenGroupedArgumentDefinitions(
    definitions: ArgumentDefinitions,
    prefix = "",
): ArgumentDefinitions {
    const flattened: ArgumentDefinitions = {};
    for (const [name, definition] of Object.entries(definitions)) {
        const key = groupedKey(prefix, name);
        if (isArgumentGroupDefinition(definition)) {
            Object.assign(flattened, flattenGroupedArgumentDefinitions(definition.args, key));
            continue;
        }
        flattened[key] = definition;
    }
    return flattened;
}

/** Flatten nested handler values into dotted parser/serializer values using the definition tree. */
export function flattenGroupedArgumentValues(
    values: Readonly<Record<string, unknown>>,
    definitions: ArgumentDefinitions,
    prefix = "",
): Record<string, ArgumentValue> {
    const flattened: Record<string, ArgumentValue> = {};
    for (const [name, definition] of Object.entries(definitions)) {
        const key = groupedKey(prefix, name);
        if (isArgumentGroupDefinition(definition)) {
            const nested = values[name];
            if (isRecord(nested)) {
                Object.assign(
                    flattened,
                    flattenGroupedArgumentValues(nested, definition.args, key),
                );
            }
            continue;
        }
        flattened[key] = values[name] as ArgumentValue;
    }
    return flattened;
}

/** Expand dotted parser values back into nested handler values using the definition tree. */
export function expandGroupedArgumentValues(
    values: Readonly<Record<string, ArgumentValue>>,
    definitions: ArgumentDefinitions,
    prefix = "",
): Record<string, unknown> {
    const expanded: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(definitions)) {
        const key = groupedKey(prefix, name);
        if (isArgumentGroupDefinition(definition)) {
            expanded[name] = expandGroupedArgumentValues(values, definition.args, key);
            continue;
        }
        expanded[name] = values[key];
    }
    return expanded;
}
