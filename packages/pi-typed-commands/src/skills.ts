import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { toKebabCase } from "./names.js";
import { isPositionalArgument, validateArgumentValue } from "./schema.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentUi,
    ArgumentValue,
    ArgumentWidget,
    BooleanArgumentDefinition,
    EnumArgumentDefinition,
    MultiEnumArgumentDefinition,
    NumberArgumentDefinition,
    RegisteredTypedCommand,
    StringArgumentDefinition,
} from "./types.js";

const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/;
const PLACEHOLDER_PATTERN = /\{args\.([A-Za-z0-9_.-]+)\}/g;
const ARGUMENT_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
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

export type RawSkillArgumentDefinition = Record<string, unknown>;
export type RawSkillArguments = Record<string, unknown>;

export type SkillFrontmatter = {
    name?: string;
    description?: string;
    formTitle?: string;
    arguments?: unknown;
    metadata?: Record<string, unknown>;
};

export type TypedSkillMetadata = {
    name: string;
    description: string;
    filePath: string;
    baseDir: string;
    body: string;
    args: ArgumentDefinitions;
    formTitle?: string;
};

export type TypedSkillDiagnostics = {
    name: string;
    filePath: string;
    messages: string[];
};

export type SkillArgumentNormalizationResult = {
    args: ArgumentDefinitions;
    warnings: string[];
};

export type ReadTypedSkillMetadataResult = {
    metadata?: TypedSkillMetadata;
    diagnostics?: TypedSkillDiagnostics;
};

export type RenderTypedSkillInvocationOptions = {
    skill: Pick<TypedSkillMetadata, "name" | "filePath" | "baseDir" | "body">;
    values: Record<string, ArgumentValue>;
    additionalInput?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value;
    }
    return undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
    if (typeof value === "boolean") {
        return value;
    }
    return undefined;
}

function optionalNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    return undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
    }
    return undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const items = value.filter((item): item is string => typeof item === "string");
    if (items.length !== value.length) {
        return undefined;
    }
    return items;
}

function optionalPositional(value: unknown): boolean | number | undefined {
    if (typeof value === "boolean") {
        return value;
    }
    return optionalNonNegativeInteger(value);
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
    warnings: string[],
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
    warnings: string[],
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
    warnings: string[],
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
    warnings: string[],
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

function normalizeUi(name: string, raw: unknown, warnings: string[]): ArgumentUi | undefined {
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
    warnings: string[],
): TDefinition {
    const target = definition as Record<string, unknown>;
    assignOptionalString(target, "description", raw, "description", name, warnings);
    assignOptionalBoolean(target, "required", raw, "required", name, warnings);
    assignOptionalString(target, "placeholder", raw, "placeholder", name, warnings);

    if (Object.hasOwn(raw, "aliases")) {
        warnings.push(`${name}.aliases is not supported`);
    }

    if (Object.hasOwn(raw, "positional")) {
        const positional = optionalPositional(raw.positional);
        if (positional === undefined) {
            warnings.push(`${name}.positional must be a boolean or non-negative integer`);
        } else {
            definition.positional = positional;
        }
    }

    const ui = normalizeUi(name, raw.ui, warnings);
    if (ui !== undefined) {
        definition.ui = ui;
    }
    return definition;
}

function validateDefault(name: string, definition: ArgumentDefinition, warnings: string[]): void {
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
    warnings: string[],
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
    warnings: string[],
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
    warnings: string[],
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
    warnings: string[],
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

function validateArgumentNames(args: ArgumentDefinitions, warnings: string[]): void {
    const names = Object.keys(args);
    const flags = new Map<string, string>();

    for (const name of names) {
        if (!ARGUMENT_NAME_PATTERN.test(name)) {
            warnings.push(
                `${name}: argument names may only contain letters, numbers, dots, underscores, and hyphens`,
            );
        }

        for (const other of names) {
            if (name !== other && other.startsWith(`${name}.`)) {
                warnings.push(`${name}: cannot define both ${name} and nested argument ${other}`);
                break;
            }
        }

        const definition = args[name];
        if (definition === undefined || isPositionalArgument(definition)) {
            continue;
        }
        const flag = toKebabCase(name);
        if (flag.startsWith("no-")) {
            warnings.push(`${name}: argument flags may not start with no-`);
        }
        const existing = flags.get(flag);
        if (existing !== undefined && existing !== name) {
            warnings.push(`${name}: flag --${flag} collides with ${existing}`);
            continue;
        }
        flags.set(flag, name);
    }
}

export function normalizeSkillArguments(rawArguments: unknown): SkillArgumentNormalizationResult {
    const warnings: string[] = [];
    const args: ArgumentDefinitions = {};
    if (!isRecord(rawArguments)) {
        return { args, warnings: ["arguments must be an object"] };
    }

    for (const [name, raw] of flattenRawArguments(rawArguments, warnings)) {
        const definition = normalizeOneArgument(name, raw, warnings);
        if (definition !== undefined) {
            args[name] = definition;
        }
    }

    validateArgumentNames(args, warnings);
    return { args, warnings };
}

export function parseSkillMarkdown(content: string): {
    frontmatter: SkillFrontmatter;
    body: string;
} {
    const match = FRONTMATTER_PATTERN.exec(content);
    if (match === null) {
        return { frontmatter: {}, body: content.trim() };
    }

    const yamlText = match[1] ?? "";
    const body = (match[2] ?? "").trim();
    const parsed = YAML.parse(yamlText) as unknown;
    if (!isRecord(parsed)) {
        return { frontmatter: {}, body };
    }

    const frontmatter: SkillFrontmatter = {};
    const name = optionalString(parsed.name);
    if (name !== undefined) {
        frontmatter.name = name;
    }
    const description = optionalString(parsed.description);
    if (description !== undefined) {
        frontmatter.description = description;
    }
    const formTitle = optionalString(parsed.form_title);
    if (formTitle !== undefined) {
        frontmatter.formTitle = formTitle;
    }
    if (Object.hasOwn(parsed, "arguments")) {
        frontmatter.arguments = parsed.arguments;
    }
    if (isRecord(parsed.metadata)) {
        frontmatter.metadata = parsed.metadata;
    }
    return { frontmatter, body };
}

function typedSkillDiagnostics(
    name: string,
    filePath: string,
    messages: string[],
): TypedSkillDiagnostics {
    return { name, filePath, messages };
}

export function readTypedSkillMetadataResult(filePath: string): ReadTypedSkillMetadataResult {
    const content = readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseSkillMarkdown(content);
    if (frontmatter.name === undefined || frontmatter.description === undefined) {
        return {};
    }

    const rawArguments = frontmatter.arguments ?? frontmatter.metadata?.arguments;
    if (rawArguments === undefined) {
        return {};
    }

    const { args, warnings } = normalizeSkillArguments(rawArguments);
    if (warnings.length > 0) {
        return {
            diagnostics: typedSkillDiagnostics(frontmatter.name, filePath, warnings),
        };
    }
    if (Object.keys(args).length === 0) {
        return {
            diagnostics: typedSkillDiagnostics(frontmatter.name, filePath, [
                "arguments must define at least one argument",
            ]),
        };
    }

    const formTitle = frontmatter.formTitle ?? optionalString(frontmatter.metadata?.form_title);
    const metadata: TypedSkillMetadata = {
        name: frontmatter.name,
        description: frontmatter.description,
        filePath,
        baseDir: dirname(filePath),
        body,
        args,
    };
    if (formTitle !== undefined) {
        metadata.formTitle = formTitle;
    }
    return { metadata };
}

export function readTypedSkillMetadata(filePath: string): TypedSkillMetadata | undefined {
    const result = readTypedSkillMetadataResult(filePath);
    return result.metadata;
}

export function formatTypedSkillDiagnostics(diagnostics: TypedSkillDiagnostics): string {
    return [
        `/skill:${diagnostics.name} has invalid typed arguments in:`,
        diagnostics.filePath,
        "",
        ...diagnostics.messages.map((message) => `• ${message}`),
    ].join("\n");
}

export function typedSkillCommandFromMetadata(
    skill: TypedSkillMetadata,
): RegisteredTypedCommand & { source: "skill"; skill: TypedSkillMetadata } {
    const command: RegisteredTypedCommand & { source: "skill"; skill: TypedSkillMetadata } = {
        name: `skill:${skill.name}`,
        description: skill.description,
        args: skill.args,
        handler: () => {},
        typedArgsEnabled: true,
        formSymbols: {
            selectedCheckbox: "■",
            unselectedCheckbox: "□",
            selectedRadio: "●",
            unselectedRadio: "○",
        },
        openFormWhenInvalid: true,
        openFormWhenMissingRequired: true,
        source: "skill",
        skill,
    };
    if (skill.formTitle !== undefined) {
        command.formTitle = skill.formTitle;
    }
    return command;
}

export function isTypedSkillCommand(
    command: RegisteredTypedCommand,
): command is RegisteredTypedCommand & { source: "skill"; skill: TypedSkillMetadata } {
    return (command as { source?: unknown }).source === "skill";
}

export function skillPathFromCommand(command: SlashCommandInfo): string | undefined {
    if (command.source !== "skill") {
        return undefined;
    }
    if (!command.name.startsWith("skill:")) {
        return undefined;
    }
    return command.sourceInfo.path;
}

function formatInlineValue(value: unknown): string {
    if (value === undefined) {
        return "";
    }
    if (Array.isArray(value)) {
        return value.join(", ");
    }
    if (isRecord(value)) {
        return Object.entries(value)
            .map(([key, item]) => `${key}: ${formatInlineValue(item)}`)
            .join(", ");
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return "";
}

function setNestedValue(target: Record<string, unknown>, path: string[], value: unknown): void {
    let current = target;
    for (const segment of path.slice(0, -1)) {
        const existing = current[segment];
        if (isRecord(existing)) {
            current = existing;
            continue;
        }
        const next: Record<string, unknown> = {};
        current[segment] = next;
        current = next;
    }
    const leaf = path[path.length - 1];
    if (leaf !== undefined) {
        current[leaf] = value;
    }
}

export function expandArgumentObject(
    values: Record<string, ArgumentValue>,
): Record<string, unknown> {
    const expanded: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(values)) {
        if (name.includes(".")) {
            setNestedValue(expanded, name.split("."), value);
            continue;
        }
        expanded[name] = value;
    }
    return expanded;
}

function resolveArgumentPath(values: Record<string, ArgumentValue>, path: string): unknown {
    if (Object.hasOwn(values, path)) {
        return values[path];
    }
    let current: unknown = expandArgumentObject(values);
    for (const segment of path.split(".")) {
        if (!isRecord(current)) {
            return undefined;
        }
        current = current[segment];
    }
    return current;
}

function yamlBlock(value: unknown): string {
    return YAML.stringify(value).trimEnd();
}

function escapeXmlAttribute(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function renderTypedSkillInvocation(options: RenderTypedSkillInvocationOptions): string {
    const { skill, values } = options;
    let usedPlaceholders = false;
    const renderedBody = skill.body.replace(PLACEHOLDER_PATTERN, (_placeholder, path: string) => {
        usedPlaceholders = true;
        return formatInlineValue(resolveArgumentPath(values, path));
    });

    const sections = [
        `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.filePath)}">`,
        `References are relative to ${skill.baseDir}.`,
        "",
        renderedBody,
    ];

    if (!usedPlaceholders) {
        sections.push("", "ARGUMENTS:", "```yaml", yamlBlock(expandArgumentObject(values)), "```");
    }

    const additionalInput = options.additionalInput?.trim();
    if (additionalInput !== undefined && additionalInput.length > 0) {
        sections.push("", "ADDITIONAL_INPUT:", additionalInput);
    }

    sections.push("</skill>");
    return sections.join("\n");
}
