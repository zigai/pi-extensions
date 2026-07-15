import {
    flattenGroupedArgumentDefinitions,
    flattenUnknownGroupedArgumentDefinitions,
} from "./arguments.js";
import { createDefinitionDiagnostic } from "./diagnostics.js";
import { casesHandled } from "./exhaustive.js";
import { formatFlagName, normalizeFlagName, toKebabCase } from "./names.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentValue,
    DefinitionDiagnostic,
    FlatArgumentDefinitions,
    ParseIssue,
    CoreRegisteredTypedCommand,
} from "./types.js";

const ARGUMENT_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const RESERVED_ARGUMENT_NAME_SEGMENTS: ReadonlySet<string> = new Set([
    "__proto__",
    "constructor",
    "prototype",
]);
const ARGUMENT_TYPES: ReadonlySet<string> = new Set([
    "string",
    "number",
    "boolean",
    "enum",
    "multi-enum",
]);

/** Parser lookup for non-positional flags, keyed by canonical flag name without leading dashes. */
export type ArgumentLookup = {
    byFlag: Map<string, string>;
    definitions: FlatArgumentDefinitions;
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

/** Return whether an argument is intentionally available only in Pi's expanded form. */
export function isFormOnlyArgument(definition: ArgumentDefinition): boolean {
    return definition.formOnly === true;
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

function formatArgumentMessageName(
    name: string,
    definition?: ArgumentDefinition,
    options?: ArgumentMessageOptions,
): string {
    if (options?.nameStyle === "field") {
        return toKebabCase(name);
    }
    if (definition !== undefined) {
        return formatArgumentFlagName(name, definition);
    }
    return formatFlagName(name);
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
export function orderedCommandArgumentEntries<TDefinitions extends ArgumentDefinitions>(
    command: CoreRegisteredTypedCommand<TDefinitions>,
): Array<[string, ArgumentDefinition]> {
    return orderedArgumentEntries(command.args).filter(
        ([, definition]) => !isFormOnlyArgument(definition),
    );
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value)) {
        return false;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isArgumentType(value: unknown): value is ArgumentDefinition["type"] {
    return typeof value === "string" && ARGUMENT_TYPES.has(value);
}

function isRegExp(value: unknown): value is RegExp {
    return value instanceof RegExp;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function addDefinitionDiagnostic(
    diagnostics: DefinitionDiagnostic[],
    code: string,
    message: string,
    path: readonly (string | number)[],
): void {
    diagnostics.push(createDefinitionDiagnostic({ code, message, path }));
}

function addArgumentDiagnostic(
    diagnostics: DefinitionDiagnostic[],
    name: string,
    field: string,
    code: string,
    message: string,
): void {
    addDefinitionDiagnostic(diagnostics, code, message, [name, ...field.split(".")]);
}

function validateOptionalStringField(
    name: string,
    raw: Record<string, unknown>,
    field: string,
    diagnostics: DefinitionDiagnostic[],
): boolean {
    if (!Object.hasOwn(raw, field) || raw[field] === undefined) {
        return true;
    }
    if (typeof raw[field] === "string") {
        return true;
    }
    addArgumentDiagnostic(
        diagnostics,
        name,
        field,
        `argument.${field}.invalid`,
        `${name}.${field} must be a string`,
    );
    return false;
}

function validateOptionalBooleanField(
    name: string,
    raw: Record<string, unknown>,
    field: string,
    diagnostics: DefinitionDiagnostic[],
): boolean {
    if (!Object.hasOwn(raw, field) || raw[field] === undefined) {
        return true;
    }
    if (typeof raw[field] === "boolean") {
        return true;
    }
    addArgumentDiagnostic(
        diagnostics,
        name,
        field,
        `argument.${field}.invalid`,
        `${name}.${field} must be a boolean`,
    );
    return false;
}

function validateAliasesShape(
    name: string,
    raw: Record<string, unknown>,
    diagnostics: DefinitionDiagnostic[],
): boolean {
    if (!Object.hasOwn(raw, "aliases") || raw.aliases === undefined) {
        return true;
    }
    if (!Array.isArray(raw.aliases)) {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "aliases",
            "argument.aliases.invalid",
            `${name}.aliases must be a list of strings`,
        );
        return false;
    }

    let valid = true;
    for (const [index, alias] of raw.aliases.entries()) {
        if (typeof alias === "string") {
            continue;
        }
        addDefinitionDiagnostic(
            diagnostics,
            "argument.aliases.item.invalid",
            `${name}.aliases[${index}] must be a string`,
            [name, "aliases", index],
        );
        valid = false;
    }
    return valid;
}

function validateValuesShape(
    name: string,
    raw: Record<string, unknown>,
    diagnostics: DefinitionDiagnostic[],
): boolean {
    if (!Array.isArray(raw.values)) {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "values",
            "argument.values.invalid",
            `${name}.values must be a list of strings`,
        );
        return false;
    }

    let valid = true;
    for (const [index, value] of raw.values.entries()) {
        if (typeof value === "string") {
            continue;
        }
        addDefinitionDiagnostic(
            diagnostics,
            "argument.values.item.invalid",
            `${name}.values[${index}] must be a string`,
            [name, "values", index],
        );
        valid = false;
    }
    return valid;
}

function validateCustomWidgetShape(
    name: string,
    custom: unknown,
    diagnostics: DefinitionDiagnostic[],
): boolean {
    if (custom === undefined) {
        return true;
    }
    if (!isRecord(custom)) {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "ui.custom",
            "argument.ui.custom.invalid",
            `${name}.ui.custom must be an object`,
        );
        return false;
    }
    if (!isPlainRecord(custom)) {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "ui.custom",
            "argument.ui.custom.unsupported-object",
            `${name}.ui.custom must be a plain object`,
        );
        return false;
    }

    let valid = true;
    for (const field of ["renderValue", "handleInput"] as const) {
        const value = custom[field];
        if (value === undefined || typeof value === "function") {
            continue;
        }
        addArgumentDiagnostic(
            diagnostics,
            name,
            `ui.custom.${field}`,
            "argument.ui.custom-field.invalid",
            `${name}.ui.custom.${field} must be a function`,
        );
        valid = false;
    }
    return valid;
}

function validateUiShape(name: string, ui: unknown, diagnostics: DefinitionDiagnostic[]): boolean {
    if (ui === undefined) {
        return true;
    }
    if (!isRecord(ui)) {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "ui",
            "argument.ui.invalid",
            `${name}.ui must be an object`,
        );
        return false;
    }
    if (!isPlainRecord(ui)) {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "ui",
            "argument.ui.unsupported-object",
            `${name}.ui must be a plain object`,
        );
        return false;
    }

    let valid = true;
    if (ui.title !== undefined && typeof ui.title !== "string") {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "ui.title",
            "argument.ui.title.invalid",
            `${name}.ui.title must be a string`,
        );
        valid = false;
    }
    for (const field of ["readOnly", "hidden"] as const) {
        const value = ui[field];
        if (value === undefined || typeof value === "boolean" || typeof value === "function") {
            continue;
        }
        addArgumentDiagnostic(
            diagnostics,
            name,
            `ui.${field}`,
            "argument.ui.boolean-option.invalid",
            `${name}.ui.${field} must be a boolean or function`,
        );
        valid = false;
    }
    if (ui.compute !== undefined && typeof ui.compute !== "function") {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "ui.compute",
            "argument.ui.compute.invalid",
            `${name}.ui.compute must be a function`,
        );
        valid = false;
    }
    return validateCustomWidgetShape(name, ui.custom, diagnostics) && valid;
}

function validateArgumentDefinitionShape(
    name: string,
    definition: unknown,
    diagnostics: DefinitionDiagnostic[],
): definition is ArgumentDefinition {
    if (!isRecord(definition)) {
        addDefinitionDiagnostic(
            diagnostics,
            "argument.definition.invalid",
            `${name}: argument definition must be an object`,
            [name],
        );
        return false;
    }
    if (!isPlainRecord(definition)) {
        addDefinitionDiagnostic(
            diagnostics,
            "argument.definition.unsupported-object",
            `${name}: argument definition must be a plain object`,
            [name],
        );
        return false;
    }

    let valid = true;
    if (!isArgumentType(definition.type)) {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "type",
            "argument.type.invalid",
            `${name}.type must be one of: ${[...ARGUMENT_TYPES].join(", ")}`,
        );
        valid = false;
    }

    for (const field of ["description", "flag", "title", "placeholder"] as const) {
        valid = validateOptionalStringField(name, definition, field, diagnostics) && valid;
    }
    for (const field of ["required", "rest", "formOnly"] as const) {
        valid = validateOptionalBooleanField(name, definition, field, diagnostics) && valid;
    }
    valid = validateAliasesShape(name, definition, diagnostics) && valid;
    valid = validateUiShape(name, definition.ui, diagnostics) && valid;

    if (definition.complete !== undefined && typeof definition.complete !== "function") {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "complete",
            "argument.complete.invalid",
            `${name}.complete must be a function`,
        );
        valid = false;
    }

    if (definition.type === "string") {
        const pattern = definition.pattern;
        if (pattern !== undefined && typeof pattern !== "string" && !isRegExp(pattern)) {
            addArgumentDiagnostic(
                diagnostics,
                name,
                "pattern",
                "argument.string.pattern.invalid",
                `${name}.pattern must be a string or RegExp`,
            );
            valid = false;
        }
    }
    if (definition.type === "number" && definition.integer !== undefined) {
        valid = validateOptionalBooleanField(name, definition, "integer", diagnostics) && valid;
    }
    if (definition.type === "enum" || definition.type === "multi-enum") {
        valid = validateValuesShape(name, definition, diagnostics) && valid;
    }

    return valid;
}

function validateFlagName(
    owner: string,
    flag: string,
    flags: Map<string, string>,
    diagnostics: DefinitionDiagnostic[],
    path: readonly (string | number)[],
): void {
    if (!FLAG_NAME_PATTERN.test(flag)) {
        addDefinitionDiagnostic(
            diagnostics,
            "argument.flag.invalid",
            `${owner}: flag --${flag} must contain only letters, numbers, and hyphens`,
            path,
        );
        return;
    }
    if (flag === "help") {
        addDefinitionDiagnostic(
            diagnostics,
            "argument.flag.reserved",
            `${owner}: argument flag --help is reserved for generated help`,
            path,
        );
    }
    if (flag.startsWith("no-")) {
        addDefinitionDiagnostic(
            diagnostics,
            "argument.flag.negated-prefix",
            `${owner}: argument flags may not start with no-`,
            path,
        );
    }
    const existing = flags.get(flag);
    if (existing === owner) {
        addDefinitionDiagnostic(
            diagnostics,
            "argument.flag.duplicate",
            `${owner}: flag --${flag} is defined more than once`,
            path,
        );
        return;
    }
    if (existing !== undefined) {
        addDefinitionDiagnostic(
            diagnostics,
            "argument.flag.collision",
            `${owner}: flag --${flag} collides with ${existing}`,
            path,
        );
        return;
    }
    flags.set(flag, owner);
}

function isStringArrayValue(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

function supportsAppendOccurrence(definition: ArgumentDefinition): boolean {
    switch (definition.type) {
        case "string":
        case "number":
        case "boolean":
        case "enum":
            return false;
        case "multi-enum":
            return true;
        default:
            return casesHandled(definition);
    }
}

function supportsRestPosition(definition: ArgumentDefinition): boolean {
    switch (definition.type) {
        case "string":
        case "multi-enum":
            return true;
        case "number":
        case "boolean":
        case "enum":
            return false;
        default:
            return casesHandled(definition);
    }
}

/** Validate a parsed, defaulted, or form-collected argument value against its full definition. */
export function validateArgumentValue(
    name: string,
    definition: ArgumentDefinition,
    value: unknown,
    options?: ArgumentMessageOptions,
): ArgumentValueValidation {
    const displayName = formatArgumentMessageName(name, definition, options);

    if (definition.required === true && value === undefined) {
        return { ok: false, message: `${displayName} is required` };
    }

    if (value === undefined) {
        return { ok: true };
    }

    switch (definition.type) {
        case "string": {
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
        case "number": {
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
        case "boolean": {
            if (typeof value === "boolean") {
                return { ok: true };
            }
            return { ok: false, message: `${displayName} expects true or false` };
        }
        case "enum": {
            if (typeof value === "string" && definition.values.includes(value)) {
                return { ok: true };
            }
            return {
                ok: false,
                message: `${displayName} must be one of: ${definition.values.join(", ")}`,
            };
        }
        case "multi-enum": {
            if (
                !isStringArrayValue(value) ||
                !value.every((item) => definition.values.includes(item))
            ) {
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
        default:
            return casesHandled(definition);
    }
}

function validateDefault(
    name: string,
    definition: ArgumentDefinition,
    diagnostics: DefinitionDiagnostic[],
): void {
    if (definition.default === undefined) {
        return;
    }
    const validation = validateArgumentValue(name, definition, definition.default);
    if (!validation.ok) {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "default",
            "argument.default.invalid",
            `${name}.default ${validation.message}`,
        );
    }
}

function validateUi(
    name: string,
    definition: ArgumentDefinition,
    diagnostics: DefinitionDiagnostic[],
): void {
    const ui = definition.ui;
    if (ui === undefined) {
        return;
    }
    if (ui.widget !== undefined) {
        if (!SUPPORTED_WIDGETS.has(ui.widget)) {
            addArgumentDiagnostic(
                diagnostics,
                name,
                "ui.widget",
                "argument.ui.widget.invalid",
                `${name}.ui.widget must be one of: ${[...SUPPORTED_WIDGETS].join(", ")}`,
            );
        }
        if (ui.widget === "number" && definition.type !== "number") {
            addArgumentDiagnostic(
                diagnostics,
                name,
                "ui.widget",
                "argument.ui.widget.type-mismatch",
                `${name}.ui.widget number requires a number argument`,
            );
        }
        if ((ui.widget === "toggle" || ui.widget === "confirm") && definition.type !== "boolean") {
            addArgumentDiagnostic(
                diagnostics,
                name,
                "ui.widget",
                "argument.ui.widget.type-mismatch",
                `${name}.ui.widget ${ui.widget} requires a boolean argument`,
            );
        }
        if ((ui.widget === "select" || ui.widget === "radio") && definition.type !== "enum") {
            addArgumentDiagnostic(
                diagnostics,
                name,
                "ui.widget",
                "argument.ui.widget.type-mismatch",
                `${name}.ui.widget ${ui.widget} requires an enum argument`,
            );
        }
        if (ui.widget === "multiselect" && definition.type !== "multi-enum") {
            addArgumentDiagnostic(
                diagnostics,
                name,
                "ui.widget",
                "argument.ui.widget.type-mismatch",
                `${name}.ui.widget multiselect requires a multi-enum argument`,
            );
        }
    }
    if (ui.rows !== undefined && !isPositiveInteger(ui.rows)) {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "ui.rows",
            "argument.ui.rows.invalid",
            `${name}.ui.rows must be a positive integer`,
        );
    }
}

function validateTypeSpecificRules(
    name: string,
    definition: ArgumentDefinition,
    diagnostics: DefinitionDiagnostic[],
): void {
    if (definition.complete?.constructor.name === "AsyncFunction") {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "complete",
            "argument.completion.async-provider-in-sync-slot",
            `${name}.complete must be synchronous; use completeAsync for async completion providers`,
        );
    }
    if (definition.title !== undefined && typeof definition.title !== "string") {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "title",
            "argument.title.invalid",
            `${name}.title must be a string`,
        );
    }
    if (
        definition.occurrence !== undefined &&
        !["error", "first", "last", "append"].includes(definition.occurrence)
    ) {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "occurrence",
            "argument.occurrence.invalid",
            `${name}.occurrence must be one of: error, first, last, append`,
        );
    }
    if (definition.occurrence === "append" && !supportsAppendOccurrence(definition)) {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "occurrence",
            "argument.occurrence.type-mismatch",
            `${name}.occurrence append is only valid for multi-enum arguments`,
        );
    }
    if (
        definition.completionTimeoutMs !== undefined &&
        !isNonNegativeInteger(definition.completionTimeoutMs)
    ) {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "completionTimeoutMs",
            "argument.completion-timeout.invalid",
            `${name}.completionTimeoutMs must be a non-negative integer`,
        );
    }

    if (definition.required === true && definition.default !== undefined) {
        addDefinitionDiagnostic(
            diagnostics,
            "argument.required-default.conflict",
            `${name}: required arguments may not define a default`,
            [name],
        );
    }

    if (isFormOnlyArgument(definition)) {
        if (definition.required === true) {
            addArgumentDiagnostic(
                diagnostics,
                name,
                "required",
                "argument.form-only.required",
                `${name}: form-only arguments must be optional`,
            );
        }
        if (definition.default !== undefined) {
            addArgumentDiagnostic(
                diagnostics,
                name,
                "default",
                "argument.form-only.default",
                `${name}: form-only arguments may not define a default`,
            );
        }
        for (const field of ["flag", "aliases", "position", "rest"] as const) {
            const value = definition[field];
            if (value === undefined || value === false) {
                continue;
            }
            addArgumentDiagnostic(
                diagnostics,
                name,
                field,
                "argument.form-only.cli-metadata",
                `${name}: form-only arguments may not define ${field}`,
            );
        }
    }

    if (definition.position !== undefined && !isNonNegativeInteger(definition.position)) {
        addArgumentDiagnostic(
            diagnostics,
            name,
            "position",
            "argument.position.invalid",
            `${name}.position must be a non-negative integer`,
        );
    }
    if (definition.rest === true) {
        if (!isPositionalArgument(definition)) {
            addArgumentDiagnostic(
                diagnostics,
                name,
                "rest",
                "argument.rest.requires-position",
                `${name}.rest requires a positional argument`,
            );
        }
        if (!supportsRestPosition(definition)) {
            addArgumentDiagnostic(
                diagnostics,
                name,
                "rest",
                "argument.rest.type-mismatch",
                `${name}.rest is only valid for string or multi-enum arguments`,
            );
        }
    }
    switch (definition.type) {
        case "string": {
            if (definition.minLength !== undefined && !isNonNegativeInteger(definition.minLength)) {
                addArgumentDiagnostic(
                    diagnostics,
                    name,
                    "minLength",
                    "argument.string.min-length.invalid",
                    `${name}.minLength must be a non-negative integer`,
                );
            }
            if (definition.maxLength !== undefined && !isNonNegativeInteger(definition.maxLength)) {
                addArgumentDiagnostic(
                    diagnostics,
                    name,
                    "maxLength",
                    "argument.string.max-length.invalid",
                    `${name}.maxLength must be a non-negative integer`,
                );
            }
            if (
                definition.minLength !== undefined &&
                definition.maxLength !== undefined &&
                definition.minLength > definition.maxLength
            ) {
                addArgumentDiagnostic(
                    diagnostics,
                    name,
                    "minLength",
                    "argument.string.length-range.invalid",
                    `${name}.minLength must be less than or equal to maxLength`,
                );
            }
            if (definition.pattern !== undefined) {
                try {
                    if (typeof definition.pattern === "string") {
                        new RegExp(definition.pattern);
                    }
                } catch {
                    addArgumentDiagnostic(
                        diagnostics,
                        name,
                        "pattern",
                        "argument.string.pattern.invalid",
                        `${name}.pattern must be a valid regular expression`,
                    );
                }
            }
            break;
        }
        case "number": {
            if (definition.min !== undefined && !Number.isFinite(definition.min)) {
                addArgumentDiagnostic(
                    diagnostics,
                    name,
                    "min",
                    "argument.number.min.invalid",
                    `${name}.min must be a finite number`,
                );
            }
            if (definition.max !== undefined && !Number.isFinite(definition.max)) {
                addArgumentDiagnostic(
                    diagnostics,
                    name,
                    "max",
                    "argument.number.max.invalid",
                    `${name}.max must be a finite number`,
                );
            }
            if (
                definition.min !== undefined &&
                definition.max !== undefined &&
                definition.min > definition.max
            ) {
                addArgumentDiagnostic(
                    diagnostics,
                    name,
                    "min",
                    "argument.number.range.invalid",
                    `${name}.min must be less than or equal to max`,
                );
            }
            break;
        }
        case "boolean":
            break;
        case "enum":
        case "multi-enum": {
            if (definition.values.length === 0) {
                addArgumentDiagnostic(
                    diagnostics,
                    name,
                    "values",
                    "argument.values.empty",
                    `${name}.values must be a non-empty list of strings`,
                );
            }
            const seen = new Set<string>();
            for (const value of definition.values) {
                if (value.length === 0) {
                    addArgumentDiagnostic(
                        diagnostics,
                        name,
                        "values",
                        "argument.values.empty-string",
                        `${name}.values may not contain empty strings`,
                    );
                }
                if (definition.type === "multi-enum" && value.includes(",")) {
                    addArgumentDiagnostic(
                        diagnostics,
                        name,
                        "values",
                        "argument.values.comma",
                        `${name}.values may not contain commas`,
                    );
                }
                if (seen.has(value)) {
                    addArgumentDiagnostic(
                        diagnostics,
                        name,
                        "values",
                        "argument.values.duplicate",
                        `${name}.values contains duplicate value ${value}`,
                    );
                }
                seen.add(value);
            }
            if (definition.type === "multi-enum") {
                if (
                    definition.minItems !== undefined &&
                    !isNonNegativeInteger(definition.minItems)
                ) {
                    addArgumentDiagnostic(
                        diagnostics,
                        name,
                        "minItems",
                        "argument.multi-enum.min-items.invalid",
                        `${name}.minItems must be a non-negative integer`,
                    );
                }
                if (
                    definition.maxItems !== undefined &&
                    !isNonNegativeInteger(definition.maxItems)
                ) {
                    addArgumentDiagnostic(
                        diagnostics,
                        name,
                        "maxItems",
                        "argument.multi-enum.max-items.invalid",
                        `${name}.maxItems must be a non-negative integer`,
                    );
                }
                if (
                    definition.minItems !== undefined &&
                    definition.maxItems !== undefined &&
                    definition.minItems > definition.maxItems
                ) {
                    addArgumentDiagnostic(
                        diagnostics,
                        name,
                        "minItems",
                        "argument.multi-enum.item-range.invalid",
                        `${name}.minItems must be less than or equal to maxItems`,
                    );
                }
            }
            break;
        }
        default:
            casesHandled(definition);
    }

    validateDefault(name, definition, diagnostics);
    validateUi(name, definition, diagnostics);
}

function validatePositionals(
    definitions: ArgumentDefinitions,
    diagnostics: DefinitionDiagnostic[],
): void {
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
            addArgumentDiagnostic(
                diagnostics,
                name,
                label,
                "argument.position.duplicate",
                `${name}.${label} duplicates position ${position} from ${existing}`,
            );
            continue;
        }
        positions.set(position, name);
    }

    let optionalBeforeRequired: string | undefined;
    let restArgument: string | undefined;
    for (const [name, definition] of positionalArgumentEntries(definitions)) {
        if (restArgument !== undefined) {
            addDefinitionDiagnostic(
                diagnostics,
                "argument.position.after-rest",
                `${name}: positional arguments may not follow rest argument ${restArgument}`,
                [name, "position"],
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
            addDefinitionDiagnostic(
                diagnostics,
                "argument.position.required-after-optional",
                `${name}: required positional arguments may not follow optional positional argument ${optionalBeforeRequired}`,
                [name, "position"],
            );
        }
    }
}

/**
 * Validate argument names, flags, defaults, constraints, UI metadata, and positional layout.
 *
 * The function does not throw; returned diagnostics are structured for programmatic handling.
 */
export function validateArgumentDefinitions(definitions: unknown): DefinitionDiagnostic[] {
    const diagnostics: DefinitionDiagnostic[] = [];
    if (!isRecord(definitions)) {
        addDefinitionDiagnostic(
            diagnostics,
            "arguments.invalid",
            "arguments must be an object",
            [],
        );
        return diagnostics;
    }

    const flatDefinitions = flattenUnknownGroupedArgumentDefinitions(definitions);
    const validDefinitions: Record<string, ArgumentDefinition> = {};
    const names = Object.keys(flatDefinitions);
    const flags = new Map<string, string>();

    for (const name of names) {
        if (!ARGUMENT_NAME_PATTERN.test(name)) {
            addDefinitionDiagnostic(
                diagnostics,
                "argument.name.invalid",
                `${name}: argument names may only contain letters, numbers, dots, underscores, and hyphens`,
                [name],
            );
        }

        const reservedSegment = reservedArgumentNameSegment(name);
        if (reservedSegment !== undefined) {
            addDefinitionDiagnostic(
                diagnostics,
                "argument.name.reserved-segment",
                `${name}: argument path segment ${reservedSegment} is reserved`,
                [name],
            );
        }

        for (const other of names) {
            if (name !== other && other.startsWith(`${name}.`)) {
                addDefinitionDiagnostic(
                    diagnostics,
                    "argument.name.nested-collision",
                    `${name}: cannot define both ${name} and nested argument ${other}`,
                    [name],
                );
                break;
            }
        }

        const definition = flatDefinitions[name];
        if (!validateArgumentDefinitionShape(name, definition, diagnostics)) {
            continue;
        }
        validDefinitions[name] = definition;

        validateTypeSpecificRules(name, definition, diagnostics);
        if (isPositionalArgument(definition) || isFormOnlyArgument(definition)) {
            continue;
        }

        validateFlagName(name, argumentFlagName(name, definition), flags, diagnostics, [
            name,
            "flag",
        ]);
        for (const [index, alias] of (definition.aliases ?? []).entries()) {
            validateFlagName(name, normalizeFlagName(alias), flags, diagnostics, [
                name,
                "aliases",
                index,
            ]);
        }
    }

    validatePositionals(validDefinitions, diagnostics);
    return diagnostics;
}

/** Build the flag lookup used by the parser; positional arguments are intentionally excluded. */
export function createArgumentLookup(definitions: ArgumentDefinitions): ArgumentLookup {
    const flatDefinitions = flattenGroupedArgumentDefinitions(definitions);
    const byFlag = new Map<string, string>();

    for (const [name, definition] of Object.entries(flatDefinitions)) {
        if (isPositionalArgument(definition) || isFormOnlyArgument(definition)) {
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
        if (isStringArrayValue(definition.default)) {
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
    for (const [name, definition] of Object.entries(
        flattenGroupedArgumentDefinitions(definitions),
    )) {
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

    switch (definition.type) {
        case "string":
            return { ok: true, value: raw };
        case "number": {
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
        case "boolean": {
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
        case "enum": {
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
        case "multi-enum": {
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
        default:
            return casesHandled(definition);
    }
}

/** Return finite values suitable for select/radio/toggle form controls. */
export function selectableArgumentValues(definition: ArgumentDefinition): ArgumentValue[] {
    switch (definition.type) {
        case "string":
        case "number":
            return [];
        case "boolean": {
            const values: ArgumentValue[] = [true, false];
            if (definition.required !== true && definition.default === undefined) {
                values.push(undefined);
            }
            return values;
        }
        case "enum": {
            const values: ArgumentValue[] = [...definition.values];
            if (definition.required !== true && definition.default === undefined) {
                values.push(undefined);
            }
            return values;
        }
        case "multi-enum":
            return [...definition.values];
        default:
            return casesHandled(definition);
    }
}

/** Return built-in static completion candidates for booleans and enum-like arguments. */
export function completionValuesForArgument(definition: ArgumentDefinition): string[] {
    switch (definition.type) {
        case "string":
        case "number":
            return [];
        case "boolean":
            return ["true", "false"];
        case "enum":
        case "multi-enum":
            return [...definition.values];
        default:
            return casesHandled(definition);
    }
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
    switch (definition.type) {
        case "string":
            return input;
        case "number":
            return Number(trimmed);
        case "boolean":
        case "enum":
        case "multi-enum":
            return undefined;
        default:
            return casesHandled(definition);
    }
}

/** Return the compact type label shown in generated usage/help text. */
export function argumentTypeHint(definition: ArgumentDefinition): string {
    switch (definition.type) {
        case "string":
        case "boolean":
        case "enum":
        case "multi-enum":
            return definition.type;
        case "number":
            if (definition.integer === true) {
                return "int";
            }
            return definition.type;
        default:
            return casesHandled(definition);
    }
}

/** Return the placeholder/value hint shown for an argument in usage, help, and forms. */
export function argumentValueHint(definition: ArgumentDefinition, name?: string): string {
    if (definition.placeholder !== undefined) {
        return definition.placeholder;
    }

    switch (definition.type) {
        case "string":
            if (name === undefined) {
                return "string";
            }
            return toKebabCase(name);
        case "number":
            return argumentTypeHint(definition);
        case "boolean":
            return "boolean";
        case "enum":
            return definition.values.join("|");
        case "multi-enum":
            return definition.values.join(",");
        default:
            return casesHandled(definition);
    }
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
