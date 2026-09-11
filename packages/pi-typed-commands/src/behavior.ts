import { casesHandled } from "./exhaustive.js";
import {
    coerceArgumentValue,
    completionValuesForArgument,
    createParseIssue,
    formatArgumentFlagName,
    isFormOnlyArgument,
    isPositionalArgument,
    validateArgumentValue,
} from "./schema.js";
import type {
    ArgumentDefinition,
    ArgumentValue,
    CompiledArgument,
    RawArgumentOccurrence,
    DecodeResult,
    ArgumentDescription,
    ParseIssue,
    TypedCompletionContext,
    TypedCompletionItem,
} from "./types.js";

function occurrencePolicy(definition: ArgumentDefinition): "error" | "first" | "last" | "append" {
    if (definition.occurrence !== undefined) {
        return definition.occurrence;
    }

    switch (definition.type) {
        case "string":
        case "number":
        case "boolean":
        case "enum":
            return "error";
        case "multi-enum":
        case "string-list":
        case "key-value":
            return "append";
        default:
            return casesHandled(definition);
    }
}

function positionFor(definition: ArgumentDefinition): number | undefined {
    return definition.position;
}

function duplicateIssue(name: string, definition: ArgumentDefinition): ParseIssue {
    return {
        kind: "duplicate-argument",
        name,
        message: `${formatArgumentFlagName(name, definition)} was provided more than once`,
    };
}

function isStringArrayValue(value: ArgumentValue): value is string[] {
    return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

function isKeyValueArgumentValue(value: ArgumentValue): value is Readonly<Record<string, string>> {
    return value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function acceptsImplicitBooleanValue(definition: ArgumentDefinition): boolean {
    switch (definition.type) {
        case "string":
        case "number":
        case "enum":
        case "multi-enum":
        case "string-list":
        case "key-value":
            return false;
        case "boolean":
            return true;
        default:
            return casesHandled(definition);
    }
}

function appendsOccurrenceValues(
    definition: ArgumentDefinition,
    policy: ReturnType<typeof occurrencePolicy>,
): boolean {
    switch (definition.type) {
        case "string":
        case "number":
        case "boolean":
        case "enum":
            return false;
        case "multi-enum":
        case "string-list":
        case "key-value":
            return policy === "append";
        default:
            return casesHandled(definition);
    }
}

function appendValues(
    definition: ArgumentDefinition,
    current: ArgumentValue,
    next: ArgumentValue,
): ArgumentValue {
    if (isKeyValueArgumentValue(next)) {
        let previous: Readonly<Record<string, string>> = {};
        if (isKeyValueArgumentValue(current)) {
            previous = current;
        }

        return { ...previous, ...next };
    }

    if (!isStringArrayValue(next)) {
        return next;
    }

    let values: string[] = [];
    if (isStringArrayValue(current)) {
        values = current;
    }

    if (definition.type === "string-list") {
        return [...values, ...next];
    }

    const combined = [...values];
    for (const item of next) {
        if (!combined.includes(item)) {
            combined.push(item);
        }
    }

    return combined;
}

function decodeOccurrences(
    name: string,
    definition: ArgumentDefinition,
    occurrences: readonly RawArgumentOccurrence[],
): DecodeResult {
    let value: ArgumentValue;
    const issues: ParseIssue[] = [];
    const policy = occurrencePolicy(definition);

    for (const occurrence of occurrences) {
        let next: ArgumentValue;
        if (occurrence.negated === true) {
            if (occurrence.raw !== undefined) {
                issues.push(
                    createParseIssue(
                        "invalid-value",
                        `${occurrence.token ?? formatArgumentFlagName(name, definition)} does not accept a value`,
                        name,
                        occurrence.token,
                    ),
                );
                continue;
            }

            if (acceptsImplicitBooleanValue(definition)) {
                next = false;
            } else {
                issues.push(
                    createParseIssue(
                        "invalid-value",
                        `${formatArgumentFlagName(name, definition)} is not a boolean flag`,
                        name,
                        occurrence.token,
                    ),
                );
                continue;
            }
        } else if (acceptsImplicitBooleanValue(definition) && occurrence.raw === undefined) {
            next = true;
        } else if (occurrence.raw === undefined) {
            issues.push(
                createParseIssue(
                    "missing-value",
                    `${formatArgumentFlagName(name, definition)} needs a value`,
                    name,
                    occurrence.token,
                ),
            );
            continue;
        } else {
            const coerced = coerceArgumentValue(definition, occurrence.raw, name);
            if (!coerced.ok) {
                issues.push(coerced.issue);
                continue;
            }

            next = coerced.value;
        }

        if (value !== undefined) {
            if (policy === "error") {
                issues.push(duplicateIssue(name, definition));
                continue;
            }

            if (policy === "first") {
                continue;
            }
        }

        if (appendsOccurrenceValues(definition, policy)) {
            value = appendValues(definition, value, next);
        } else {
            value = next;
        }
    }

    if (issues.length > 0) {
        return { ok: false, issues, value };
    }

    return { ok: true, value };
}

export function quoteSerializedValue(value: string, force = false): string {
    if (
        !force &&
        value.length > 0 &&
        !/\s|["'\\]/.test(value) &&
        value !== "--" &&
        value !== "--help" &&
        value !== "-h"
    ) {
        return value;
    }

    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function serializeValue(definition: ArgumentDefinition, name: string, value: unknown): string[] {
    if (value === undefined) {
        return [];
    }

    const validation = validateArgumentValue(name, definition, value);
    if (!validation.ok) {
        throw new TypeError(validation.message);
    }

    switch (definition.type) {
        case "boolean": {
            if (value === true) {
                return [formatArgumentFlagName(name, definition)];
            }

            if (value === false) {
                return [`--no-${formatArgumentFlagName(name, definition).slice(2)}`];
            }

            return [];
        }
        case "multi-enum": {
            if (!Array.isArray(value)) {
                return [];
            }

            if (value.length === 0) {
                return [`${formatArgumentFlagName(name, definition)}=""`];
            }

            return [
                `${formatArgumentFlagName(name, definition)}=${quoteSerializedValue(value.join(","))}`,
            ];
        }
        case "string-list": {
            if (!Array.isArray(value)) {
                return [];
            }

            if (value.length === 0) {
                return [`${formatArgumentFlagName(name, definition)}=""`];
            }

            return [
                `${formatArgumentFlagName(name, definition)}=${quoteSerializedValue(value.join(","))}`,
            ];
        }
        case "key-value": {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                return [];
            }

            const entries = Object.entries(value);
            if (entries.length === 0) {
                return [`${formatArgumentFlagName(name, definition)}=""`];
            }

            return entries.map(
                ([key, entryValue]) =>
                    `${formatArgumentFlagName(name, definition)}=${quoteSerializedValue(`${key}=${entryValue}`)}`,
            );
        }
        case "string":
        case "enum":
            if (typeof value !== "string") {
                return [];
            }

            if (definition.type === "string" && definition.sensitive === true) {
                return [];
            }

            return [`${formatArgumentFlagName(name, definition)}=${quoteSerializedValue(value)}`];
        case "number": {
            if (typeof value !== "number") {
                return [];
            }

            let text = String(value);
            if (Object.is(value, -0)) {
                text = "-0";
            }

            return [`${formatArgumentFlagName(name, definition)}=${quoteSerializedValue(text)}`];
        }
        default:
            return casesHandled(definition);
    }
}

function staticCompletionItems(
    definition: ArgumentDefinition,
    query: string,
): TypedCompletionItem[] {
    return completionValuesForArgument(definition)
        .filter((value) => value.startsWith(query))
        .map((value) => ({ value, label: value }));
}

export function compileArgumentBehavior(
    key: string,
    definition: ArgumentDefinition,
): CompiledArgument {
    const positional = isPositionalArgument(definition);
    let flag: string | undefined;
    let aliases: string[] = [];
    const formOnly = isFormOnlyArgument(definition);

    if (!positional && !formOnly) {
        flag = formatArgumentFlagName(key, definition).slice(2);
        aliases = [...(definition.aliases ?? [])];
    }

    const compiled: Omit<CompiledArgument, "flag" | "position"> & {
        flag?: string;
        position?: number;
    } = {
        key,
        definition,
        aliases,
        decode(occurrences) {
            return decodeOccurrences(key, definition, occurrences);
        },
        validate(value) {
            const validation = validateArgumentValue(key, definition, value);
            if (validation.ok) {
                return [];
            }

            let kind: ParseIssue["kind"] = "invalid-value";
            if (definition.required === true && value === undefined) {
                kind = "missing-required";
            }

            return [
                {
                    kind,
                    name: key,
                    message: validation.message,
                },
            ];
        },
        serialize(value) {
            if (formOnly) {
                if (value !== undefined) {
                    const validation = validateArgumentValue(key, definition, value);
                    if (!validation.ok) {
                        throw new TypeError(validation.message);
                    }
                }

                return [];
            }

            return serializeValue(definition, key, value);
        },
        describe(): ArgumentDescription {
            const description: ArgumentDescription = {
                key,
                type: definition.type,
                aliases,
                required: definition.required === true,
            };
            if (flag !== undefined) {
                description.flag = flag;
            }

            const position = positionFor(definition);
            if (position !== undefined) {
                description.position = position;
            }

            if (definition.default !== undefined) {
                description.defaultValue = definition.default;
            }

            const title = definition.title ?? definition.ui?.title;
            if (title !== undefined) {
                description.title = title;
            }

            if (definition.description !== undefined) {
                description.description = definition.description;
            }

            return description;
        },
    };
    if (flag !== undefined) {
        compiled.flag = flag;
    }

    const position = positionFor(definition);
    if (position !== undefined) {
        compiled.position = position;
    }

    if (definition.complete !== undefined) {
        compiled.complete = (query: string, context: TypedCompletionContext) =>
            definition.complete?.(query, context) ?? [];
    } else if (completionValuesForArgument(definition).length > 0) {
        compiled.complete = (query: string) => staticCompletionItems(definition, query);
    }

    const completeAsync = definition.completeAsync;
    if (completeAsync !== undefined) {
        compiled.completeAsync = async (query: string, context: TypedCompletionContext) =>
            completeAsync(query, context);
    }

    return Object.freeze(compiled);
}
