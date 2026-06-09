import { formatFlagName, normalizeFlagName, toKebabCase } from "./names.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentValue,
    ParseIssue,
    RegisteredTypedCommand,
} from "./types.js";

export type ArgumentLookup = {
    byFlag: Map<string, string>;
    definitions: ArgumentDefinitions;
};

export type CoercedArgumentValue =
    | { ok: true; value: ArgumentValue }
    | { ok: false; issue: ParseIssue };

export type ArgumentValueValidation = { ok: true } | { ok: false; message: string };

export function createParseIssue(
    kind: ParseIssue["kind"],
    message: string,
    name?: string,
    token?: string,
): ParseIssue {
    const result: ParseIssue = { kind, message };
    if (name !== undefined) {
        result.name = name;
    }
    if (token !== undefined) {
        result.token = token;
    }
    return result;
}

export function booleanFromString(value: string): boolean | undefined {
    const normalized = value.toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) {
        return true;
    }
    if (["0", "false", "no", "n", "off"].includes(normalized)) {
        return false;
    }
    return undefined;
}

export function isPositionalArgument(definition: ArgumentDefinition): boolean {
    return definition.positional !== undefined && definition.positional !== false;
}

export function orderedArgumentEntries(
    definitions: ArgumentDefinitions,
): Array<[string, ArgumentDefinition]> {
    return Object.entries(definitions)
        .map(([name, definition], index) => ({ name, definition, index }))
        .sort((left, right) => {
            const leftIsPositional = isPositionalArgument(left.definition);
            const rightIsPositional = isPositionalArgument(right.definition);
            if (leftIsPositional !== rightIsPositional) {
                if (leftIsPositional) {
                    return -1;
                }
                return 1;
            }

            let leftPosition = left.index;
            if (typeof left.definition.positional === "number") {
                leftPosition = left.definition.positional;
            }
            let rightPosition = right.index;
            if (typeof right.definition.positional === "number") {
                rightPosition = right.definition.positional;
            }
            return leftPosition - rightPosition;
        })
        .map((entry) => [entry.name, entry.definition]);
}

export function orderedCommandArgumentEntries<
    TDefinitions extends Record<string, ArgumentDefinition>,
>(command: RegisteredTypedCommand<TDefinitions>): Array<[string, ArgumentDefinition]> {
    return orderedArgumentEntries(command.args);
}

export function positionalArgumentEntries(
    definitions: ArgumentDefinitions,
): Array<[string, ArgumentDefinition]> {
    return orderedArgumentEntries(definitions).filter(([, definition]) =>
        isPositionalArgument(definition),
    );
}

export function createArgumentLookup(definitions: ArgumentDefinitions): ArgumentLookup {
    const byFlag = new Map<string, string>();

    for (const [name, definition] of Object.entries(definitions)) {
        if (isPositionalArgument(definition)) {
            continue;
        }
        byFlag.set(normalizeFlagName(name), name);
        byFlag.set(toKebabCase(name), name);
        if (definition.aliases !== undefined) {
            for (const alias of definition.aliases) {
                byFlag.set(normalizeFlagName(alias), name);
            }
        }
    }

    return { byFlag, definitions };
}

export function findArgumentName(lookup: ArgumentLookup, flag: string): string | undefined {
    return lookup.byFlag.get(normalizeFlagName(flag));
}

export function applyArgumentDefault(definition: ArgumentDefinition): ArgumentValue {
    if (definition.default !== undefined) {
        return definition.default;
    }
    return undefined;
}

export function applyArgumentDefaults(
    definitions: ArgumentDefinitions,
    values: Record<string, ArgumentValue>,
): Record<string, ArgumentValue> {
    const next: Record<string, ArgumentValue> = { ...values };
    for (const [name, definition] of Object.entries(definitions)) {
        if (next[name] !== undefined) {
            continue;
        }
        const defaultValue = applyArgumentDefault(definition);
        if (defaultValue !== undefined) {
            next[name] = defaultValue;
        }
    }
    return next;
}

export function coerceArgumentValue(
    definition: ArgumentDefinition,
    raw: string,
    name: string,
): CoercedArgumentValue {
    if (definition.type === "string") {
        return { ok: true, value: raw };
    }

    if (definition.type === "boolean") {
        const parsed = booleanFromString(raw);
        if (parsed === undefined) {
            return {
                ok: false,
                issue: createParseIssue(
                    "invalid-value",
                    `${formatFlagName(name)} expects a boolean value`,
                    name,
                    raw,
                ),
            };
        }
        return { ok: true, value: parsed };
    }

    if (definition.type === "number") {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
            return {
                ok: false,
                issue: createParseIssue(
                    "invalid-value",
                    `${formatFlagName(name)} expects a number`,
                    name,
                    raw,
                ),
            };
        }
        if (definition.integer === true && !Number.isInteger(parsed)) {
            return {
                ok: false,
                issue: createParseIssue(
                    "invalid-value",
                    `${formatFlagName(name)} expects an integer`,
                    name,
                    raw,
                ),
            };
        }
        if (definition.min !== undefined && parsed < definition.min) {
            return {
                ok: false,
                issue: createParseIssue(
                    "invalid-value",
                    `${formatFlagName(name)} must be at least ${definition.min}`,
                    name,
                    raw,
                ),
            };
        }
        if (definition.max !== undefined && parsed > definition.max) {
            return {
                ok: false,
                issue: createParseIssue(
                    "invalid-value",
                    `${formatFlagName(name)} must be at most ${definition.max}`,
                    name,
                    raw,
                ),
            };
        }
        return { ok: true, value: parsed };
    }

    if (definition.type === "multi-enum") {
        const values = raw
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
        const invalid = values.find((item) => !definition.values.includes(item));
        if (invalid !== undefined) {
            return {
                ok: false,
                issue: createParseIssue(
                    "invalid-value",
                    `${formatFlagName(name)} must use values from: ${definition.values.join(", ")}`,
                    name,
                    invalid,
                ),
            };
        }
        return { ok: true, value: values };
    }

    if (!definition.values.includes(raw)) {
        return {
            ok: false,
            issue: createParseIssue(
                "invalid-value",
                `${formatFlagName(name)} must be one of: ${definition.values.join(", ")}`,
                name,
                raw,
            ),
        };
    }

    return { ok: true, value: raw };
}

export function validateArgumentValue(
    name: string,
    definition: ArgumentDefinition,
    value: ArgumentValue,
): ArgumentValueValidation {
    if (definition.required === true && value === undefined) {
        return { ok: false, message: `${formatFlagName(name)} is required` };
    }

    if (value === undefined) {
        return { ok: true };
    }

    if (definition.type === "string") {
        if (typeof value === "string") {
            return { ok: true };
        }
        return { ok: false, message: `${formatFlagName(name)} expects text` };
    }

    if (definition.type === "boolean") {
        if (typeof value === "boolean") {
            return { ok: true };
        }
        return { ok: false, message: `${formatFlagName(name)} expects true or false` };
    }

    if (definition.type === "enum") {
        if (typeof value === "string" && definition.values.includes(value)) {
            return { ok: true };
        }
        return {
            ok: false,
            message: `${formatFlagName(name)} must be one of: ${definition.values.join(", ")}`,
        };
    }

    if (definition.type === "multi-enum") {
        if (Array.isArray(value) && value.every((item) => definition.values.includes(item))) {
            return { ok: true };
        }
        return {
            ok: false,
            message: `${formatFlagName(name)} must use values from: ${definition.values.join(", ")}`,
        };
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, message: `${formatFlagName(name)} expects a number` };
    }
    if (definition.integer === true && !Number.isInteger(value)) {
        return { ok: false, message: `${formatFlagName(name)} expects an integer` };
    }
    if (definition.min !== undefined && value < definition.min) {
        return { ok: false, message: `${formatFlagName(name)} must be at least ${definition.min}` };
    }
    if (definition.max !== undefined && value > definition.max) {
        return { ok: false, message: `${formatFlagName(name)} must be at most ${definition.max}` };
    }
    return { ok: true };
}

export function selectableArgumentValues(definition: ArgumentDefinition): ArgumentValue[] {
    if (definition.type === "boolean") {
        const values: ArgumentValue[] = [true, false];
        if (definition.required !== true && definition.default === undefined) {
            values.push(undefined);
        }
        return values;
    }

    if (definition.type === "enum") {
        const values: ArgumentValue[] = [...definition.values];
        if (definition.required !== true && definition.default === undefined) {
            values.push(undefined);
        }
        return values;
    }

    if (definition.type === "multi-enum") {
        return [...definition.values];
    }

    return [];
}

export function completionValuesForArgument(definition: ArgumentDefinition): string[] {
    if (definition.type === "boolean") {
        return ["true", "false"];
    }
    if (definition.type === "enum") {
        return [...definition.values];
    }
    return [];
}

export function normalizeTextArgumentInput(
    definition: ArgumentDefinition,
    input: string,
): ArgumentValue {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return applyArgumentDefault(definition);
    }
    if (definition.type === "string") {
        return input;
    }
    if (definition.type === "number") {
        return Number(trimmed);
    }
    return undefined;
}

export function argumentTypeHint(definition: ArgumentDefinition): string {
    if (definition.type === "number" && definition.integer === true) {
        return "int";
    }
    return definition.type;
}

export function argumentValueHint(definition: ArgumentDefinition, name?: string): string {
    if (definition.placeholder !== undefined) {
        return definition.placeholder;
    }

    if (definition.type === "string") {
        if (name === undefined) {
            return "string";
        }
        return toKebabCase(name);
    }

    if (definition.type === "number") {
        return argumentTypeHint(definition);
    }

    if (definition.type === "boolean") {
        return "boolean";
    }

    if (definition.type === "multi-enum") {
        return definition.values.join(",");
    }

    return definition.values.join("|");
}

export function formatArgumentDefault(definition: ArgumentDefinition): string {
    if (definition.default === undefined) {
        return "";
    }
    if (Array.isArray(definition.default)) {
        return `=${definition.default.join(",")}`;
    }
    return `=${String(definition.default)}`;
}
