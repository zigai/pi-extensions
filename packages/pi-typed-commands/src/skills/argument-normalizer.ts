import type { TLocalizedValidationError } from "typebox/error";
import Schema from "../typebox-schema.js";
import { validateArgumentDefinitions, validateArgumentValue } from "../schema.js";
import { createSafeRecord } from "./guards.js";
import {
    BooleanSkillArgumentYamlSchema,
    EnumSkillArgumentYamlSchema,
    MultiEnumSkillArgumentYamlSchema,
    NumberSkillArgumentYamlSchema,
    StringSkillArgumentYamlSchema,
    UnknownRecordYamlSchema,
    type BooleanSkillArgumentYaml,
    type EnumSkillArgumentYaml,
    type MultiEnumSkillArgumentYaml,
    type NumberSkillArgumentYaml,
    type SkillArgumentUiYaml,
    type SkillArgumentYaml,
    type StringSkillArgumentYaml,
} from "./schema.js";
import { skillArgumentDiagnostic, skillArgumentDiagnostics } from "./diagnostics.js";
import type { DefinitionDiagnostic } from "../types.js";
import type {
    ArgumentDefinition,
    ArgumentUi,
    BooleanArgumentDefinition,
    EnumArgumentDefinition,
    MultiEnumArgumentDefinition,
    NumberArgumentDefinition,
    RawSkillArguments,
    SkillArgumentDiagnostic,
    SkillArgumentNormalizationResult,
    StringArgumentDefinition,
} from "./types.js";

type SupportedSkillArgumentType = ArgumentDefinition["type"];
type SkillArgumentSchema =
    | typeof StringSkillArgumentYamlSchema
    | typeof NumberSkillArgumentYamlSchema
    | typeof BooleanSkillArgumentYamlSchema
    | typeof EnumSkillArgumentYamlSchema
    | typeof MultiEnumSkillArgumentYamlSchema;

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
]);

type SkillDiagnosticInput = string | DefinitionDiagnostic;

type SkillDiagnosticSink = {
    diagnostics: SkillArgumentDiagnostic[];
    push(...items: SkillDiagnosticInput[]): void;
};

function createSkillDiagnosticSink(): SkillDiagnosticSink {
    const diagnostics: SkillArgumentDiagnostic[] = [];
    return {
        diagnostics,
        push(...items) {
            for (const item of items) {
                if (typeof item === "string") {
                    diagnostics.push(
                        skillArgumentDiagnostic({
                            code: "skill.argument.invalid",
                            message: item,
                        }),
                    );
                } else {
                    diagnostics.push(...skillArgumentDiagnostics([item]));
                }
            }
        },
    };
}

function pointerSegments(pointer: string): string[] {
    if (pointer.length === 0) {
        return [];
    }
    return pointer
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function pathLabel(name: string, segments: readonly string[]): string {
    if (segments.length === 0) {
        return name;
    }
    return `${name}.${segments.join(".")}`;
}

function valueAtPath(value: unknown, segments: readonly string[]): unknown {
    let current = value;
    for (const segment of segments) {
        if (!Schema.Check(UnknownRecordYamlSchema, current)) {
            return undefined;
        }
        current = current[segment];
    }
    return current;
}

function normalizeArgumentType(type: unknown): SupportedSkillArgumentType | undefined {
    if (type === "string" || type === "number" || type === "boolean" || type === "enum") {
        return type;
    }
    if (type === "multi_enum" || type === "multi-enum") {
        return "multi-enum";
    }
    return undefined;
}

function schemaForArgumentType(type: SupportedSkillArgumentType): SkillArgumentSchema {
    switch (type) {
        case "string":
            return StringSkillArgumentYamlSchema;
        case "number":
            return NumberSkillArgumentYamlSchema;
        case "boolean":
            return BooleanSkillArgumentYamlSchema;
        case "enum":
            return EnumSkillArgumentYamlSchema;
        case "multi-enum":
            return MultiEnumSkillArgumentYamlSchema;
    }
}

function hasTypeKey(raw: Record<string, unknown>): boolean {
    return Object.hasOwn(raw, "type");
}

function unsupportedFieldMessage(name: string, segments: readonly string[]): string {
    const label = pathLabel(name, segments);
    const field = segments.join(".");
    if (field === "aliases") {
        return `${label} is not supported`;
    }
    if (field === "ui.custom") {
        return `${label} is not supported in skill YAML`;
    }
    return `${label} is not a supported typed skill argument field`;
}

function fieldTypeMessage(
    name: string,
    type: SupportedSkillArgumentType,
    raw: Record<string, unknown>,
    segments: readonly string[],
): string {
    const field = segments.join(".");
    const label = pathLabel(name, segments);
    const value = valueAtPath(raw, segments);

    if (field === "type") {
        return `${name}.type must be one of: string, number, boolean, enum, multi_enum`;
    }
    if (field === "description" || field === "title" || field === "placeholder") {
        return `${label} must be a string`;
    }
    if (field === "required" || field === "integer" || field === "rest") {
        if (field === "rest" && value === true && type !== "string" && type !== "multi-enum") {
            return `${label} is only valid for string or multi-enum arguments`;
        }
        return `${label} must be a boolean`;
    }
    if (field === "position" || field === "min_length" || field === "max_length") {
        return `${label} must be a non-negative integer`;
    }
    if (field === "min_items" || field === "max_items") {
        return `${label} must be a non-negative integer`;
    }
    if (field === "min" || field === "max") {
        return `${label} must be a finite number`;
    }
    if (field === "occurrence") {
        if (value === "append" && type !== "multi-enum") {
            return `${label} append is only valid for multi-enum arguments`;
        }
        return `${label} must be one of: error, first, last, append`;
    }
    if (field === "ui") {
        return `${label} must be an object`;
    }
    if (field === "ui.widget") {
        if (value === "custom") {
            return `${label} custom is not supported in skill YAML`;
        }
        return `${label} must be one of: ${[...SUPPORTED_WIDGETS].join(", ")}`;
    }
    if (field === "ui.rows") {
        return `${label} must be a positive integer`;
    }
    if (field === "ui.title") {
        return `${label} must be a string`;
    }
    if (field === "values") {
        return `${label} must be a non-empty list of strings`;
    }
    if (field.startsWith("values.")) {
        return `${name}.values must be a non-empty list of strings`;
    }
    if (field === "default") {
        if (type === "number") {
            return `${label} must be a finite number`;
        }
        if (type === "boolean") {
            return `${label} must be a boolean`;
        }
        if (type === "multi-enum") {
            return `${label} must be a list of strings`;
        }
        return `${label} must be a string`;
    }
    if (field.startsWith("default.")) {
        if (type === "multi-enum") {
            return `${name}.default must be a list of strings`;
        }
        return `${name}.default must be a string`;
    }

    return `${label} is invalid`;
}

function schemaErrorMessages(
    name: string,
    type: SupportedSkillArgumentType,
    raw: Record<string, unknown>,
    error: TLocalizedValidationError,
): string[] {
    const baseSegments = pointerSegments(error.instancePath);
    if (error.keyword === "additionalProperties") {
        return error.params.additionalProperties.map((property) =>
            unsupportedFieldMessage(name, [...baseSegments, property]),
        );
    }
    if (error.keyword === "not") {
        return [`${name}: required arguments may not define a default`];
    }
    return [fieldTypeMessage(name, type, raw, baseSegments)];
}

function parseSkillArgumentYaml(
    name: string,
    raw: Record<string, unknown>,
    warnings: SkillDiagnosticSink,
): SkillArgumentYaml | undefined {
    const type = normalizeArgumentType(raw.type);
    if (type === undefined) {
        warnings.push(`${name}.type must be one of: string, number, boolean, enum, multi_enum`);
        return undefined;
    }

    const schema = schemaForArgumentType(type);
    if (Schema.Check(schema, raw)) {
        return raw;
    }

    const [, errors] = Schema.Errors(schema, raw);
    for (const error of errors) {
        warnings.push(...schemaErrorMessages(name, type, raw, error));
    }
    return undefined;
}

function normalizeUi(raw: SkillArgumentUiYaml | undefined): ArgumentUi | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const ui: ArgumentUi = {};
    if (raw.widget !== undefined) {
        ui.widget = raw.widget;
    }
    if (raw.rows !== undefined) {
        ui.rows = raw.rows;
    }
    if (raw.title !== undefined) {
        ui.title = raw.title;
    }

    if (Object.keys(ui).length > 0) {
        return ui;
    }
    return undefined;
}

function applySharedFields<TDefinition extends ArgumentDefinition>(
    definition: TDefinition,
    raw: SkillArgumentYaml,
): TDefinition {
    if (raw.description !== undefined) {
        definition.description = raw.description;
    }
    if (raw.title !== undefined) {
        definition.title = raw.title;
    }
    if (raw.required !== undefined) {
        definition.required = raw.required;
    }
    if (raw.placeholder !== undefined) {
        definition.placeholder = raw.placeholder;
    }
    if (raw.occurrence !== undefined) {
        definition.occurrence = raw.occurrence;
    }
    if (raw.position !== undefined) {
        definition.position = raw.position;
    }
    if (raw.rest !== undefined) {
        definition.rest = raw.rest;
    }

    const ui = normalizeUi(raw.ui);
    if (ui !== undefined) {
        definition.ui = ui;
    }
    return definition;
}

function validateDefault(
    name: string,
    definition: ArgumentDefinition,
    warnings: SkillDiagnosticSink,
): void {
    if (definition.default === undefined) {
        return;
    }
    const validation = validateArgumentValue(name, definition, definition.default);
    if (!validation.ok) {
        warnings.push(`${name}.default ${validation.message}`);
    }
}

function assignStringConstraints(
    name: string,
    definition: StringArgumentDefinition,
    raw: StringSkillArgumentYaml,
    warnings: SkillDiagnosticSink,
): void {
    if (raw.min_length !== undefined) {
        definition.minLength = raw.min_length;
    }
    if (raw.max_length !== undefined) {
        definition.maxLength = raw.max_length;
    }
    if (
        definition.minLength !== undefined &&
        definition.maxLength !== undefined &&
        definition.minLength > definition.maxLength
    ) {
        warnings.push(`${name}.min_length must be less than or equal to max_length`);
    }
    if (raw.pattern !== undefined) {
        try {
            new RegExp(raw.pattern);
            definition.pattern = raw.pattern;
        } catch {
            warnings.push(`${name}.pattern must be a valid regular expression`);
        }
    }
}

function assignMultiEnumConstraints(
    name: string,
    definition: MultiEnumArgumentDefinition,
    raw: MultiEnumSkillArgumentYaml,
    warnings: SkillDiagnosticSink,
): void {
    if (raw.min_items !== undefined) {
        definition.minItems = raw.min_items;
    }
    if (raw.max_items !== undefined) {
        definition.maxItems = raw.max_items;
    }
    if (
        definition.minItems !== undefined &&
        definition.maxItems !== undefined &&
        definition.minItems > definition.maxItems
    ) {
        warnings.push(`${name}.min_items must be less than or equal to max_items`);
    }
}

function normalizeStringArgument(
    name: string,
    raw: StringSkillArgumentYaml,
    warnings: SkillDiagnosticSink,
): StringArgumentDefinition {
    const definition: StringArgumentDefinition = applySharedFields({ type: "string" }, raw);
    assignStringConstraints(name, definition, raw, warnings);
    if (raw.default !== undefined) {
        definition.default = raw.default;
    }
    validateDefault(name, definition, warnings);
    return definition;
}

function normalizeBooleanArgument(
    name: string,
    raw: BooleanSkillArgumentYaml,
    warnings: SkillDiagnosticSink,
): BooleanArgumentDefinition {
    const definition: BooleanArgumentDefinition = applySharedFields({ type: "boolean" }, raw);
    if (raw.default !== undefined) {
        definition.default = raw.default;
    }
    validateDefault(name, definition, warnings);
    return definition;
}

function normalizeNumberArgument(
    name: string,
    raw: NumberSkillArgumentYaml,
    warnings: SkillDiagnosticSink,
): NumberArgumentDefinition {
    const definition: NumberArgumentDefinition = applySharedFields({ type: "number" }, raw);
    if (raw.integer !== undefined) {
        definition.integer = raw.integer;
    }
    if (raw.min !== undefined) {
        definition.min = raw.min;
    }
    if (raw.max !== undefined) {
        definition.max = raw.max;
    }
    if (
        definition.min !== undefined &&
        definition.max !== undefined &&
        definition.min > definition.max
    ) {
        warnings.push(`${name}.min must be less than or equal to max`);
    }
    if (raw.default !== undefined) {
        definition.default = raw.default;
    }
    validateDefault(name, definition, warnings);
    return definition;
}

function normalizeEnumArgument(
    name: string,
    raw: EnumSkillArgumentYaml,
    warnings: SkillDiagnosticSink,
): EnumArgumentDefinition {
    const definition: EnumArgumentDefinition = applySharedFields(
        { type: "enum", values: raw.values },
        raw,
    );
    if (raw.default !== undefined) {
        definition.default = raw.default;
    }
    validateDefault(name, definition, warnings);
    return definition;
}

function normalizeMultiEnumArgument(
    name: string,
    raw: MultiEnumSkillArgumentYaml,
    warnings: SkillDiagnosticSink,
): MultiEnumArgumentDefinition {
    const definition: MultiEnumArgumentDefinition = applySharedFields(
        { type: "multi-enum", values: raw.values },
        raw,
    );
    assignMultiEnumConstraints(name, definition, raw, warnings);
    if (raw.default !== undefined) {
        definition.default = raw.default;
    }
    validateDefault(name, definition, warnings);
    return definition;
}

function normalizeParsedArgument(
    name: string,
    raw: SkillArgumentYaml,
    warnings: SkillDiagnosticSink,
): ArgumentDefinition {
    switch (raw.type) {
        case "string":
            return normalizeStringArgument(name, raw, warnings);
        case "boolean":
            return normalizeBooleanArgument(name, raw, warnings);
        case "number":
            return normalizeNumberArgument(name, raw, warnings);
        case "enum":
            return normalizeEnumArgument(name, raw, warnings);
        case "multi_enum":
        case "multi-enum":
            return normalizeMultiEnumArgument(name, raw, warnings);
    }
}

function flattenRawArguments(
    rawArguments: RawSkillArguments,
    warnings: SkillDiagnosticSink,
    prefix = "",
): Array<[string, Record<string, unknown>]> {
    const entries: Array<[string, Record<string, unknown>]> = [];
    for (const [key, value] of Object.entries(rawArguments)) {
        let name = key;
        if (prefix.length > 0) {
            name = `${prefix}.${key}`;
        }
        if (!Schema.Check(UnknownRecordYamlSchema, value)) {
            warnings.push(`${name}: argument definition must be an object`);
            continue;
        }
        if (hasTypeKey(value)) {
            entries.push([name, value]);
            continue;
        }
        entries.push(...flattenRawArguments(value, warnings, name));
    }
    return entries;
}

/**
 * Normalize a skill frontmatter `arguments` object into typed command argument definitions.
 *
 * Invalid entries are skipped and described in structured diagnostics so callers can surface a
 * single descriptive schema error for the skill.
 */
export function normalizeSkillArguments(rawArguments: unknown): SkillArgumentNormalizationResult {
    const warnings = createSkillDiagnosticSink();
    if (!Schema.Check(UnknownRecordYamlSchema, rawArguments)) {
        const messages = ["arguments must be an object"];
        return {
            args: createSafeRecord<ArgumentDefinition>(),
            diagnostics: messages.map((message) =>
                skillArgumentDiagnostic({ code: "skill.argument.invalid", message }),
            ),
        };
    }

    const normalizedEntries: Array<readonly [string, ArgumentDefinition]> = [];
    for (const [name, raw] of flattenRawArguments(rawArguments, warnings)) {
        const parsed = parseSkillArgumentYaml(name, raw, warnings);
        if (parsed === undefined) {
            continue;
        }
        normalizedEntries.push([name, normalizeParsedArgument(name, parsed, warnings)]);
    }

    const args = createSafeRecord<ArgumentDefinition>();
    for (const [name, definition] of normalizedEntries) {
        args[name] = definition;
    }

    warnings.push(...validateArgumentDefinitions(args));
    return { args, diagnostics: warnings.diagnostics };
}
