import { validateArgumentDefinitions, validateArgumentValue } from "../schema.js";
import {
    createSafeRecord,
    isRecord,
    optionalBoolean,
    optionalNonNegativeInteger,
    optionalNumber,
    optionalString,
    optionalStringArray,
} from "./guards.js";
import { skillArgumentDiagnostic, skillArgumentDiagnostics } from "./diagnostics.js";
import type { DefinitionDiagnostic } from "../types.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentUi,
    ArgumentWidget,
    BooleanArgumentDefinition,
    EnumArgumentDefinition,
    MultiEnumArgumentDefinition,
    NumberArgumentDefinition,
    RawSkillArguments,
    SkillArgumentDiagnostic,
    SkillArgumentNormalizationResult,
    StringArgumentDefinition,
} from "./types.js";

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

function normalizeArgumentType(type: unknown): ArgumentDefinition["type"] | undefined {
    if (type === "string" || type === "number" || type === "boolean" || type === "enum") {
        return type;
    }
    if (type === "multi_enum" || type === "multi-enum") {
        return "multi-enum";
    }
    return undefined;
}

function hasTypeKey(raw: Record<string, unknown>): boolean {
    return Object.hasOwn(raw, "type");
}

function assignOptionalString(
    target: Record<string, unknown>,
    targetKey: string,
    raw: Record<string, unknown>,
    sourceKey: string,
    name: string,
    warnings: SkillDiagnosticSink,
): void {
    if (!Object.hasOwn(raw, sourceKey)) {
        return;
    }
    const value = optionalString(raw[sourceKey]);
    if (value === undefined) {
        warnings.push(`${name}.${sourceKey} must be a string`);
        return;
    }
    target[targetKey] = value;
}

function assignOptionalBoolean(
    target: Record<string, unknown>,
    targetKey: string,
    raw: Record<string, unknown>,
    sourceKey: string,
    name: string,
    warnings: SkillDiagnosticSink,
): void {
    if (!Object.hasOwn(raw, sourceKey)) {
        return;
    }
    const value = optionalBoolean(raw[sourceKey]);
    if (value === undefined) {
        warnings.push(`${name}.${sourceKey} must be a boolean`);
        return;
    }
    target[targetKey] = value;
}

function assignOptionalNumber(
    target: Record<string, unknown>,
    targetKey: string,
    raw: Record<string, unknown>,
    sourceKey: string,
    name: string,
    warnings: SkillDiagnosticSink,
): void {
    if (!Object.hasOwn(raw, sourceKey)) {
        return;
    }
    const value = optionalNumber(raw[sourceKey]);
    if (value === undefined) {
        warnings.push(`${name}.${sourceKey} must be a finite number`);
        return;
    }
    target[targetKey] = value;
}

function assignOptionalNonNegativeInteger(
    target: Record<string, unknown>,
    targetKey: string,
    raw: Record<string, unknown>,
    sourceKey: string,
    name: string,
    warnings: SkillDiagnosticSink,
): void {
    if (!Object.hasOwn(raw, sourceKey)) {
        return;
    }
    const value = optionalNonNegativeInteger(raw[sourceKey]);
    if (value === undefined) {
        warnings.push(`${name}.${sourceKey} must be a non-negative integer`);
        return;
    }
    target[targetKey] = value;
}

function normalizeUi(
    name: string,
    raw: unknown,
    warnings: SkillDiagnosticSink,
): ArgumentUi | undefined {
    if (raw === undefined) {
        return undefined;
    }
    if (!isRecord(raw)) {
        warnings.push(`${name}.ui must be an object`);
        return undefined;
    }

    const ui: ArgumentUi = {};
    if (Object.hasOwn(raw, "widget")) {
        const widget = optionalString(raw.widget);
        if (widget === undefined) {
            warnings.push(`${name}.ui.widget must be a string`);
        } else if (widget === "custom") {
            warnings.push(`${name}.ui.widget custom is not supported in skill YAML`);
        } else if (!SUPPORTED_WIDGETS.has(widget)) {
            warnings.push(`${name}.ui.widget must be one of: ${[...SUPPORTED_WIDGETS].join(", ")}`);
        } else {
            ui.widget = widget as ArgumentWidget;
        }
    }

    if (Object.hasOwn(raw, "rows")) {
        const rows = optionalNonNegativeInteger(raw.rows);
        if (rows === undefined || rows === 0) {
            warnings.push(`${name}.ui.rows must be a positive integer`);
        } else {
            ui.rows = rows;
        }
    }

    if (Object.hasOwn(raw, "title")) {
        const title = optionalString(raw.title);
        if (title === undefined) {
            warnings.push(`${name}.ui.title must be a string`);
        } else {
            ui.title = title;
        }
    }

    if (Object.hasOwn(raw, "custom")) {
        warnings.push(`${name}.ui.custom is not supported in skill YAML`);
    }

    if (Object.keys(ui).length > 0) {
        return ui;
    }
    return undefined;
}

function applySharedFields<TDefinition extends ArgumentDefinition>(
    name: string,
    definition: TDefinition,
    raw: Record<string, unknown>,
    warnings: SkillDiagnosticSink,
): TDefinition {
    const target = definition as Record<string, unknown>;
    assignOptionalString(target, "description", raw, "description", name, warnings);
    assignOptionalString(target, "title", raw, "title", name, warnings);
    assignOptionalBoolean(target, "required", raw, "required", name, warnings);
    assignOptionalString(target, "placeholder", raw, "placeholder", name, warnings);
    if (Object.hasOwn(raw, "occurrence")) {
        const occurrence = optionalString(raw.occurrence);
        if (
            occurrence !== "error" &&
            occurrence !== "first" &&
            occurrence !== "last" &&
            occurrence !== "append"
        ) {
            warnings.push(`${name}.occurrence must be one of: error, first, last, append`);
        } else {
            definition.occurrence = occurrence;
        }
    }

    if (Object.hasOwn(raw, "aliases")) {
        warnings.push(`${name}.aliases is not supported`);
    }

    if (Object.hasOwn(raw, "position")) {
        const position = optionalNonNegativeInteger(raw.position);
        if (position === undefined) {
            warnings.push(`${name}.position must be a non-negative integer`);
        } else {
            definition.position = position;
        }
    }

    assignOptionalBoolean(target, "rest", raw, "rest", name, warnings);

    const ui = normalizeUi(name, raw.ui, warnings);
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
    raw: Record<string, unknown>,
    warnings: SkillDiagnosticSink,
): void {
    const target = definition as Record<string, unknown>;
    assignOptionalNonNegativeInteger(target, "minLength", raw, "min_length", name, warnings);
    assignOptionalNonNegativeInteger(target, "maxLength", raw, "max_length", name, warnings);
    if (
        definition.minLength !== undefined &&
        definition.maxLength !== undefined &&
        definition.minLength > definition.maxLength
    ) {
        warnings.push(`${name}.min_length must be less than or equal to max_length`);
    }
    if (Object.hasOwn(raw, "pattern")) {
        const pattern = optionalString(raw.pattern);
        if (pattern === undefined) {
            warnings.push(`${name}.pattern must be a string`);
        } else {
            try {
                new RegExp(pattern);
                definition.pattern = pattern;
            } catch {
                warnings.push(`${name}.pattern must be a valid regular expression`);
            }
        }
    }
}

function assignMultiEnumConstraints(
    name: string,
    definition: MultiEnumArgumentDefinition,
    raw: Record<string, unknown>,
    warnings: SkillDiagnosticSink,
): void {
    const target = definition as Record<string, unknown>;
    assignOptionalNonNegativeInteger(target, "minItems", raw, "min_items", name, warnings);
    assignOptionalNonNegativeInteger(target, "maxItems", raw, "max_items", name, warnings);
    if (
        definition.minItems !== undefined &&
        definition.maxItems !== undefined &&
        definition.minItems > definition.maxItems
    ) {
        warnings.push(`${name}.min_items must be less than or equal to max_items`);
    }
}

function normalizeOneArgument(
    name: string,
    raw: Record<string, unknown>,
    warnings: SkillDiagnosticSink,
): ArgumentDefinition | undefined {
    const type = normalizeArgumentType(raw.type);
    if (type === undefined) {
        warnings.push(`${name}.type must be one of: string, number, boolean, enum, multi_enum`);
        return undefined;
    }

    if (type === "string") {
        const definition: StringArgumentDefinition = applySharedFields(
            name,
            { type },
            raw,
            warnings,
        );
        assignStringConstraints(name, definition, raw, warnings);
        if (Object.hasOwn(raw, "default")) {
            if (typeof raw.default === "string") {
                definition.default = raw.default;
            } else {
                warnings.push(`${name}.default must be a string`);
            }
        }
        validateDefault(name, definition, warnings);
        return definition;
    }

    if (type === "boolean") {
        const definition: BooleanArgumentDefinition = applySharedFields(
            name,
            { type },
            raw,
            warnings,
        );
        if (Object.hasOwn(raw, "default")) {
            if (typeof raw.default === "boolean") {
                definition.default = raw.default;
            } else {
                warnings.push(`${name}.default must be a boolean`);
            }
        }
        validateDefault(name, definition, warnings);
        return definition;
    }

    if (type === "number") {
        const definition: NumberArgumentDefinition = applySharedFields(
            name,
            { type },
            raw,
            warnings,
        );
        assignOptionalBoolean(
            definition as Record<string, unknown>,
            "integer",
            raw,
            "integer",
            name,
            warnings,
        );
        assignOptionalNumber(
            definition as Record<string, unknown>,
            "min",
            raw,
            "min",
            name,
            warnings,
        );
        assignOptionalNumber(
            definition as Record<string, unknown>,
            "max",
            raw,
            "max",
            name,
            warnings,
        );
        if (
            definition.min !== undefined &&
            definition.max !== undefined &&
            definition.min > definition.max
        ) {
            warnings.push(`${name}.min must be less than or equal to max`);
        }
        if (Object.hasOwn(raw, "default")) {
            const defaultValue = optionalNumber(raw.default);
            if (defaultValue !== undefined) {
                definition.default = defaultValue;
            } else {
                warnings.push(`${name}.default must be a finite number`);
            }
        }
        validateDefault(name, definition, warnings);
        return definition;
    }

    const values = optionalStringArray(raw.values);
    if (values === undefined || values.length === 0) {
        warnings.push(`${name}.values must be a non-empty list of strings`);
        return undefined;
    }

    if (type === "enum") {
        const definition: EnumArgumentDefinition = applySharedFields(
            name,
            { type, values },
            raw,
            warnings,
        );
        if (Object.hasOwn(raw, "default")) {
            if (typeof raw.default === "string") {
                definition.default = raw.default;
            } else {
                warnings.push(`${name}.default must be a string`);
            }
        }
        validateDefault(name, definition, warnings);
        return definition;
    }

    const definition: MultiEnumArgumentDefinition = applySharedFields(
        name,
        { type, values },
        raw,
        warnings,
    );
    assignMultiEnumConstraints(name, definition, raw, warnings);
    if (Object.hasOwn(raw, "default")) {
        const defaultValues = optionalStringArray(raw.default);
        if (defaultValues !== undefined) {
            definition.default = defaultValues;
        } else {
            warnings.push(`${name}.default must be a list of strings`);
        }
    }
    validateDefault(name, definition, warnings);
    return definition;
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
        if (!isRecord(value)) {
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
    const args = createSafeRecord() as ArgumentDefinitions;
    if (!isRecord(rawArguments)) {
        const messages = ["arguments must be an object"];
        return {
            args,
            diagnostics: messages.map((message) =>
                skillArgumentDiagnostic({ code: "skill.argument.invalid", message }),
            ),
        };
    }

    for (const [name, raw] of flattenRawArguments(rawArguments, warnings)) {
        const definition = normalizeOneArgument(name, raw, warnings);
        if (definition !== undefined) {
            args[name] = definition;
        }
    }

    warnings.push(...validateArgumentDefinitions(args));
    return { args, diagnostics: warnings.diagnostics };
}
