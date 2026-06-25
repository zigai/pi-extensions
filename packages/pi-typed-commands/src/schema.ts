import { flattenGroupedArgumentDefinitions } from "./arguments.js";
import { formatFlagName, normalizeFlagName, toKebabCase } from "./names.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentValue,
    ParseIssue,
    RegisteredTypedCommand,
} from "./types.js";

const ARGUMENT_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const RESERVED_ARGUMENT_NAME_SEGMENTS: ReadonlySet<string> = new Set([
    "__proto__",
    "constructor",
    "prototype",
]);

/** Parser lookup for non-positional flags, keyed by canonical flag name without leading dashes. */
export type ArgumentLookup = {
    byFlag: Map<string, string>;
    definitions: ArgumentDefinitions;
};

/** Result of turning one raw CLI token into a typed argument value. */
export type CoercedArgumentValue =
    | { ok: true; value: ArgumentValue }
    | { ok: false; issue: ParseIssue };

/** Validation result for an already-coerced, defaulted, or form-collected value. */
export type ArgumentValueValidation = { ok: true } | { ok: false; message: string };

/** Presentation options for human-readable argument error messages. */
export type ArgumentMessageOptions = {
    nameStyle?: "flag" | "field";
};

function formatArgumentMessageName(
    name: string,
    definition?: ArgumentDefinition,
    options?: ArgumentMessageOptions,
): string {
    if (options?.nameStyle === "field") {
        return toKebabCase(name);
    }
    if (definition !== undefined) {
        // eslint-disable-next-line no-use-before-define
        return formatArgumentFlagName(name, definition);
    }
    return formatFlagName(name);
}

/** Create a parse issue while omitting absent optional fields from the result object. */
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

/** Parse the boolean spellings accepted by CLI values, such as `yes`, `no`, `on`, and `off`. */
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

/** Return whether a definition is parsed positionally instead of as a named flag. */
export function isPositionalArgument(definition: ArgumentDefinition): boolean {
    return definition.position !== undefined;
}

/** Return the canonical no-leading-dash flag name for an argument definition. */
export function argumentFlagName(name: string, definition: ArgumentDefinition): string {
    return normalizeFlagName(definition.flag ?? name);
}

/** Return the canonical primary flag and all aliases for an argument definition. */
export function argumentFlagNames(name: string, definition: ArgumentDefinition): string[] {
    const names = [argumentFlagName(name, definition)];
    for (const alias of definition.aliases ?? []) {
        names.push(normalizeFlagName(alias));
    }
    return names;
}

/** Format an argument definition's primary flag with leading `--`. */
export function formatArgumentFlagName(name: string, definition: ArgumentDefinition): string {
    return `--${argumentFlagName(name, definition)}`;
}

/** Order flattened arguments as the parser and help output see them: positionals first, then flags. */
export function orderedArgumentEntries(
    definitions: ArgumentDefinitions,
): Array<[string, ArgumentDefinition]> {
    const flatDefinitions = flattenGroupedArgumentDefinitions(definitions);
    return Object.entries(flatDefinitions)
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
            if (typeof left.definition.position === "number") {
                leftPosition = left.definition.position;
            }
            let rightPosition = right.index;
            if (typeof right.definition.position === "number") {
                rightPosition = right.definition.position;
            }
            return leftPosition - rightPosition;
        })
        .map((entry) => [entry.name, entry.definition]);
}

/** Return a registered command's arguments in parser/help order. */
export function orderedCommandArgumentEntries<
    TDefinitions extends Record<string, ArgumentDefinition>,
>(command: RegisteredTypedCommand<TDefinitions>): Array<[string, ArgumentDefinition]> {
    return orderedArgumentEntries(command.args);
}

/** Return only positional arguments after applying the same flattening and ordering rules. */
export function positionalArgumentEntries(
    definitions: ArgumentDefinitions,
): Array<[string, ArgumentDefinition]> {
    return orderedArgumentEntries(definitions).filter(([, definition]) =>
        isPositionalArgument(definition),
    );
}

function reservedArgumentNameSegment(name: string): string | undefined {
    for (const segment of name.split(".")) {
        if (RESERVED_ARGUMENT_NAME_SEGMENTS.has(segment)) {
            return segment;
        }
    }
    return undefined;
}

const FLAG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const SUPPORTED_WIDGETS: ReadonlySet<string> = new Set([
    "text",
    "textarea",
    "number",
    "toggle",
    "select",
    "radio",
    "multiselect",
    "path",
    "command",
    "readonly",
    "computed",
    "confirm",
    "custom",
]);

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validateFlagName(
    owner: string,
    flag: string,
    flags: Map<string, string>,
    warnings: string[],
): void {
    if (!FLAG_NAME_PATTERN.test(flag)) {
        warnings.push(`${owner}: flag --${flag} must contain only letters, numbers, and hyphens`);
        return;
    }
    if (flag === "help") {
        warnings.push(`${owner}: argument flag --help is reserved for generated help`);
    }
    if (flag.startsWith("no-")) {
        warnings.push(`${owner}: argument flags may not start with no-`);
    }
    const existing = flags.get(flag);
    if (existing === owner) {
        warnings.push(`${owner}: flag --${flag} is defined more than once`);
        return;
    }
    if (existing !== undefined) {
        warnings.push(`${owner}: flag --${flag} collides with ${existing}`);
        return;
    }
    flags.set(flag, owner);
}

function validateDefault(name: string, definition: ArgumentDefinition, warnings: string[]): void {
    if (definition.default === undefined) {
        return;
    }
    // eslint-disable-next-line no-use-before-define
    const validation = validateArgumentValue(name, definition, definition.default);
    if (!validation.ok) {
        warnings.push(`${name}.default ${validation.message}`);
    }
}

function validateUi(name: string, definition: ArgumentDefinition, warnings: string[]): void {
    const ui = definition.ui;
    if (ui === undefined) {
        return;
    }
    if (ui.widget !== undefined) {
        if (!SUPPORTED_WIDGETS.has(ui.widget)) {
            warnings.push(`${name}.ui.widget must be one of: ${[...SUPPORTED_WIDGETS].join(", ")}`);
        }
        if (ui.widget === "number" && definition.type !== "number") {
            warnings.push(`${name}.ui.widget number requires a number argument`);
        }
        if ((ui.widget === "toggle" || ui.widget === "confirm") && definition.type !== "boolean") {
            warnings.push(`${name}.ui.widget ${ui.widget} requires a boolean argument`);
        }
        if ((ui.widget === "select" || ui.widget === "radio") && definition.type !== "enum") {
            warnings.push(`${name}.ui.widget ${ui.widget} requires an enum argument`);
        }
        if (ui.widget === "multiselect" && definition.type !== "multi-enum") {
            warnings.push(`${name}.ui.widget multiselect requires a multi-enum argument`);
        }
    }
    if (ui.rows !== undefined && !isPositiveInteger(ui.rows)) {
        warnings.push(`${name}.ui.rows must be a positive integer`);
    }
}

function validateTypeSpecificRules(
    name: string,
    definition: ArgumentDefinition,
    warnings: string[],
): void {
    if (definition.title !== undefined && typeof definition.title !== "string") {
        warnings.push(`${name}.title must be a string`);
    }
    if (
        definition.occurrence !== undefined &&
        !["error", "first", "last", "append"].includes(definition.occurrence)
    ) {
        warnings.push(`${name}.occurrence must be one of: error, first, last, append`);
    }
    if (definition.occurrence === "append" && definition.type !== "multi-enum") {
        warnings.push(`${name}.occurrence append is only valid for multi-enum arguments`);
    }
    if (
        definition.completionTimeoutMs !== undefined &&
        !isNonNegativeInteger(definition.completionTimeoutMs)
    ) {
        warnings.push(`${name}.completionTimeoutMs must be a non-negative integer`);
    }

    if (definition.required === true && definition.default !== undefined) {
        warnings.push(`${name}: required arguments may not define a default`);
    }

    if (definition.position !== undefined) {
        if (!isNonNegativeInteger(definition.position)) {
            warnings.push(`${name}.position must be a non-negative integer`);
        }
    }
    if (definition.rest === true) {
        if (!isPositionalArgument(definition)) {
            warnings.push(`${name}.rest requires a positional argument`);
        }
        if (definition.type !== "string" && definition.type !== "multi-enum") {
            warnings.push(`${name}.rest is only valid for string or multi-enum arguments`);
        }
    }
    if (definition.type === "string") {
        if (definition.minLength !== undefined && !isNonNegativeInteger(definition.minLength)) {
            warnings.push(`${name}.minLength must be a non-negative integer`);
        }
        if (definition.maxLength !== undefined && !isNonNegativeInteger(definition.maxLength)) {
            warnings.push(`${name}.maxLength must be a non-negative integer`);
        }
        if (
            definition.minLength !== undefined &&
            definition.maxLength !== undefined &&
            definition.minLength > definition.maxLength
        ) {
            warnings.push(`${name}.minLength must be less than or equal to maxLength`);
        }
        if (definition.pattern !== undefined) {
            try {
                if (typeof definition.pattern === "string") {
                    new RegExp(definition.pattern);
                }
            } catch {
                warnings.push(`${name}.pattern must be a valid regular expression`);
            }
        }
    }

    if (definition.type === "number") {
        if (definition.min !== undefined && !Number.isFinite(definition.min)) {
            warnings.push(`${name}.min must be a finite number`);
        }
        if (definition.max !== undefined && !Number.isFinite(definition.max)) {
            warnings.push(`${name}.max must be a finite number`);
        }
        if (
            definition.min !== undefined &&
            definition.max !== undefined &&
            definition.min > definition.max
        ) {
            warnings.push(`${name}.min must be less than or equal to max`);
        }
    }

    if (definition.type === "enum" || definition.type === "multi-enum") {
        if (definition.values.length === 0) {
            warnings.push(`${name}.values must be a non-empty list of strings`);
        }
        const seen = new Set<string>();
        for (const value of definition.values) {
            if (value.length === 0) {
                warnings.push(`${name}.values may not contain empty strings`);
            }
            if (definition.type === "multi-enum" && value.includes(",")) {
                warnings.push(`${name}.values may not contain commas`);
            }
            if (seen.has(value)) {
                warnings.push(`${name}.values contains duplicate value ${value}`);
            }
            seen.add(value);
        }
    }

    if (definition.type === "multi-enum") {
        if (definition.minItems !== undefined && !isNonNegativeInteger(definition.minItems)) {
            warnings.push(`${name}.minItems must be a non-negative integer`);
        }
        if (definition.maxItems !== undefined && !isNonNegativeInteger(definition.maxItems)) {
            warnings.push(`${name}.maxItems must be a non-negative integer`);
        }
        if (
            definition.minItems !== undefined &&
            definition.maxItems !== undefined &&
            definition.minItems > definition.maxItems
        ) {
            warnings.push(`${name}.minItems must be less than or equal to maxItems`);
        }
    }

    validateDefault(name, definition, warnings);
    validateUi(name, definition, warnings);
}

function validatePositionals(definitions: ArgumentDefinitions, warnings: string[]): void {
    const flatDefinitions = flattenGroupedArgumentDefinitions(definitions);
    const positions = new Map<number, string>();
    for (const [name, definition] of Object.entries(flatDefinitions)) {
        const position = definition.position;
        const label = "position";
        if (position === undefined || !isNonNegativeInteger(position)) {
            continue;
        }
        const existing = positions.get(position);
        if (existing !== undefined) {
            warnings.push(`${name}.${label} duplicates position ${position} from ${existing}`);
            continue;
        }
        positions.set(position, name);
    }

    let optionalBeforeRequired: string | undefined;
    let restArgument: string | undefined;
    for (const [name, definition] of positionalArgumentEntries(definitions)) {
        if (restArgument !== undefined) {
            warnings.push(
                `${name}: positional arguments may not follow rest argument ${restArgument}`,
            );
        }
        if (definition.rest === true) {
            restArgument = name;
        }
        const required = definition.required === true && definition.default === undefined;
        if (!required) {
            optionalBeforeRequired = name;
            continue;
        }
        if (optionalBeforeRequired !== undefined) {
            warnings.push(
                `${name}: required positional arguments may not follow optional positional argument ${optionalBeforeRequired}`,
            );
        }
    }
}

/**
 * Validate argument names, flags, defaults, constraints, UI metadata, and positional layout.
 *
 * The function does not throw; returned strings are user-facing diagnostics.
 */
export function validateArgumentDefinitions(definitions: ArgumentDefinitions): string[] {
    const flatDefinitions = flattenGroupedArgumentDefinitions(definitions);
    const warnings: string[] = [];
    const names = Object.keys(flatDefinitions);
    const flags = new Map<string, string>();

    for (const name of names) {
        if (!ARGUMENT_NAME_PATTERN.test(name)) {
            warnings.push(
                `${name}: argument names may only contain letters, numbers, dots, underscores, and hyphens`,
            );
        }

        const reservedSegment = reservedArgumentNameSegment(name);
        if (reservedSegment !== undefined) {
            warnings.push(`${name}: argument path segment ${reservedSegment} is reserved`);
        }

        for (const other of names) {
            if (name !== other && other.startsWith(`${name}.`)) {
                warnings.push(`${name}: cannot define both ${name} and nested argument ${other}`);
                break;
            }
        }

        const definition = flatDefinitions[name];
        if (definition === undefined) {
            continue;
        }

        validateTypeSpecificRules(name, definition, warnings);
        if (isPositionalArgument(definition)) {
            continue;
        }

        validateFlagName(name, argumentFlagName(name, definition), flags, warnings);
        for (const alias of definition.aliases ?? []) {
            validateFlagName(name, normalizeFlagName(alias), flags, warnings);
        }
    }

    validatePositionals(flatDefinitions, warnings);
    return warnings;
}

/** Build the flag lookup used by the parser; positional arguments are intentionally excluded. */
export function createArgumentLookup(definitions: ArgumentDefinitions): ArgumentLookup {
    const flatDefinitions = flattenGroupedArgumentDefinitions(definitions);
    const byFlag = new Map<string, string>();

    for (const [name, definition] of Object.entries(flatDefinitions)) {
        if (isPositionalArgument(definition)) {
            continue;
        }
        for (const flag of argumentFlagNames(name, definition)) {
            byFlag.set(flag, name);
        }
    }

    return { byFlag, definitions: flatDefinitions };
}

/** Resolve a raw or normalized flag spelling to the owning argument name. */
export function findArgumentName(lookup: ArgumentLookup, flag: string): string | undefined {
    return lookup.byFlag.get(normalizeFlagName(flag));
}

/** Return an argument default, cloning array defaults so parses cannot share mutable selections. */
export function applyArgumentDefault(definition: ArgumentDefinition): ArgumentValue {
    if (definition.default !== undefined) {
        if (Array.isArray(definition.default)) {
            return [...definition.default];
        }
        return definition.default;
    }
    return undefined;
}

/** Apply missing defaults to a shallow copy of parsed values without mutating the caller's object. */
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

/**
 * Parse one raw CLI/form token into an argument value.
 *
 * This handles token-level coercion and value membership; call `validateArgumentValue` afterward
 * for required checks, string constraints, and collection-size constraints.
 */
export function coerceArgumentValue(
    definition: ArgumentDefinition,
    raw: string,
    name: string,
    options?: ArgumentMessageOptions,
): CoercedArgumentValue {
    const displayName = formatArgumentMessageName(name, definition, options);

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
                    `${displayName} expects a boolean value`,
                    name,
                    raw,
                ),
            };
        }
        return { ok: true, value: parsed };
    }

    if (definition.type === "number") {
        if (raw.trim().length === 0) {
            return {
                ok: false,
                issue: createParseIssue(
                    "invalid-value",
                    `${displayName} expects a number`,
                    name,
                    raw,
                ),
            };
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
            return {
                ok: false,
                issue: createParseIssue(
                    "invalid-value",
                    `${displayName} expects a number`,
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
                    `${displayName} expects an integer`,
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
                    `${displayName} must be at least ${definition.min}`,
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
                    `${displayName} must be at most ${definition.max}`,
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
                    `${displayName} must use values from: ${definition.values.join(", ")}`,
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
                `${displayName} must be one of: ${definition.values.join(", ")}`,
                name,
                raw,
            ),
        };
    }

    return { ok: true, value: raw };
}

/** Validate a parsed, defaulted, or form-collected argument value against its full definition. */
export function validateArgumentValue(
    name: string,
    definition: ArgumentDefinition,
    value: ArgumentValue,
    options?: ArgumentMessageOptions,
): ArgumentValueValidation {
    const displayName = formatArgumentMessageName(name, definition, options);

    if (definition.required === true && value === undefined) {
        return { ok: false, message: `${displayName} is required` };
    }

    if (value === undefined) {
        return { ok: true };
    }

    if (definition.type === "string") {
        if (typeof value !== "string") {
            return { ok: false, message: `${displayName} expects text` };
        }
        if (definition.minLength !== undefined && value.length < definition.minLength) {
            return {
                ok: false,
                message: `${displayName} must be at least ${definition.minLength} characters`,
            };
        }
        if (definition.maxLength !== undefined && value.length > definition.maxLength) {
            return {
                ok: false,
                message: `${displayName} must be at most ${definition.maxLength} characters`,
            };
        }
        if (definition.pattern !== undefined) {
            let pattern: RegExp;
            try {
                if (typeof definition.pattern === "string") {
                    pattern = new RegExp(definition.pattern);
                } else {
                    pattern = definition.pattern;
                }
            } catch {
                return {
                    ok: false,
                    message: `${displayName} has an invalid pattern`,
                };
            }
            pattern.lastIndex = 0;
            if (!pattern.test(value)) {
                return {
                    ok: false,
                    message: `${displayName} must match pattern ${String(definition.pattern)}`,
                };
            }
        }
        return { ok: true };
    }

    if (definition.type === "boolean") {
        if (typeof value === "boolean") {
            return { ok: true };
        }
        return { ok: false, message: `${displayName} expects true or false` };
    }

    if (definition.type === "enum") {
        if (typeof value === "string" && definition.values.includes(value)) {
            return { ok: true };
        }
        return {
            ok: false,
            message: `${displayName} must be one of: ${definition.values.join(", ")}`,
        };
    }

    if (definition.type === "multi-enum") {
        if (!Array.isArray(value) || !value.every((item) => definition.values.includes(item))) {
            return {
                ok: false,
                message: `${displayName} must use values from: ${definition.values.join(", ")}`,
            };
        }
        if (definition.minItems !== undefined && value.length < definition.minItems) {
            return {
                ok: false,
                message: `${displayName} must include at least ${definition.minItems} item(s)`,
            };
        }
        if (definition.maxItems !== undefined && value.length > definition.maxItems) {
            return {
                ok: false,
                message: `${displayName} must include at most ${definition.maxItems} item(s)`,
            };
        }
        return { ok: true };
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, message: `${displayName} expects a number` };
    }
    if (definition.integer === true && !Number.isInteger(value)) {
        return { ok: false, message: `${displayName} expects an integer` };
    }
    if (definition.min !== undefined && value < definition.min) {
        return { ok: false, message: `${displayName} must be at least ${definition.min}` };
    }
    if (definition.max !== undefined && value > definition.max) {
        return { ok: false, message: `${displayName} must be at most ${definition.max}` };
    }
    return { ok: true };
}

/** Return finite values suitable for select/radio/toggle form controls. */
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

/** Return built-in static completion candidates for booleans and enum-like arguments. */
export function completionValuesForArgument(definition: ArgumentDefinition): string[] {
    if (definition.type === "boolean") {
        return ["true", "false"];
    }
    if (definition.type === "enum" || definition.type === "multi-enum") {
        return [...definition.values];
    }
    return [];
}

/** Convert freeform form input into an argument value; blank input falls back to the default/unset value. */
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

/** Return the compact type label shown in generated usage/help text. */
export function argumentTypeHint(definition: ArgumentDefinition): string {
    if (definition.type === "number" && definition.integer === true) {
        return "int";
    }
    return definition.type;
}

/** Return the placeholder/value hint shown for an argument in usage, help, and forms. */
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

/** Format an argument default as the suffix used in compact generated usage text. */
export function formatArgumentDefault(definition: ArgumentDefinition): string {
    if (definition.default === undefined) {
        return "";
    }
    if (Array.isArray(definition.default)) {
        return `=${definition.default.join(",")}`;
    }
    return `=${String(definition.default)}`;
}
