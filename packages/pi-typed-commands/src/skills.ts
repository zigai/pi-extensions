import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
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

export type RawSkillArgumentDefinition = Record<string, unknown>;
export type RawSkillArguments = Record<string, unknown>;

export type SkillFrontmatter = {
    name?: string;
    description?: string;
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

export type SkillArgumentNormalizationResult = {
    args: ArgumentDefinitions;
    warnings: string[];
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
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
    }
    return undefined;
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

function normalizeUi(raw: unknown): ArgumentUi | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }

    const ui: ArgumentUi = {};
    const widget = optionalString(raw.widget);
    if (widget !== undefined) {
        ui.widget = widget as ArgumentWidget;
    }
    const rows = optionalNumber(raw.rows);
    if (rows !== undefined) {
        ui.rows = rows;
    }
    const title = optionalString(raw.title);
    if (title !== undefined) {
        ui.title = title;
    }
    if (Object.keys(ui).length > 0) {
        return ui;
    }
    return undefined;
}

function hasArgumentType(raw: Record<string, unknown>): boolean {
    return normalizeArgumentType(raw.type) !== undefined;
}

function applySharedFields<TDefinition extends ArgumentDefinition>(
    definition: TDefinition,
    raw: Record<string, unknown>,
): TDefinition {
    const description = optionalString(raw.description);
    if (description !== undefined) {
        definition.description = description;
    }
    const required = optionalBoolean(raw.required);
    if (required !== undefined) {
        definition.required = required;
    }
    const aliases = optionalStringArray(raw.aliases);
    if (aliases !== undefined) {
        definition.aliases = aliases;
    }
    const placeholder = optionalString(raw.placeholder);
    if (placeholder !== undefined) {
        definition.placeholder = placeholder;
    }
    const positional = optionalPositional(raw.positional);
    if (positional !== undefined) {
        definition.positional = positional;
    }
    const ui = normalizeUi(raw.ui);
    if (ui !== undefined) {
        definition.ui = ui;
    }
    return definition;
}

function normalizeOneArgument(
    name: string,
    raw: Record<string, unknown>,
    warnings: string[],
): ArgumentDefinition | undefined {
    const type = normalizeArgumentType(raw.type);
    if (type === undefined) {
        warnings.push(`${name}: unsupported or missing argument type`);
        return undefined;
    }

    if (type === "string") {
        const definition: StringArgumentDefinition = applySharedFields({ type }, raw);
        if (typeof raw.default === "string") {
            definition.default = raw.default;
        }
        return definition;
    }

    if (type === "boolean") {
        const definition: BooleanArgumentDefinition = applySharedFields({ type }, raw);
        if (typeof raw.default === "boolean") {
            definition.default = raw.default;
        }
        return definition;
    }

    if (type === "number") {
        const definition: NumberArgumentDefinition = applySharedFields({ type }, raw);
        const integer = optionalBoolean(raw.integer);
        if (integer !== undefined) {
            definition.integer = integer;
        }
        const min = optionalNumber(raw.min);
        if (min !== undefined) {
            definition.min = min;
        }
        const max = optionalNumber(raw.max);
        if (max !== undefined) {
            definition.max = max;
        }
        const defaultValue = optionalNumber(raw.default);
        if (defaultValue !== undefined) {
            definition.default = defaultValue;
        }
        return definition;
    }

    const values = optionalStringArray(raw.values);
    if (values === undefined || values.length === 0) {
        warnings.push(`${name}: ${type} arguments require a non-empty string values list`);
        return undefined;
    }

    if (type === "enum") {
        const definition: EnumArgumentDefinition = applySharedFields({ type, values }, raw);
        if (typeof raw.default === "string" && values.includes(raw.default)) {
            definition.default = raw.default;
        }
        return definition;
    }

    const definition: MultiEnumArgumentDefinition = applySharedFields({ type, values }, raw);
    const defaultValues = optionalStringArray(raw.default);
    if (defaultValues?.every((value) => values.includes(value)) === true) {
        definition.default = defaultValues;
    }
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
        if (hasArgumentType(value)) {
            entries.push([name, value]);
            continue;
        }
        entries.push(...flattenRawArguments(value, warnings, name));
    }
    return entries;
}

export function normalizeSkillArguments(rawArguments: unknown): SkillArgumentNormalizationResult {
    const warnings: string[] = [];
    const args: ArgumentDefinitions = {};
    if (!isRecord(rawArguments)) {
        return { args, warnings: ["metadata.arguments must be an object"] };
    }

    for (const [name, raw] of flattenRawArguments(rawArguments, warnings)) {
        const definition = normalizeOneArgument(name, raw, warnings);
        if (definition !== undefined) {
            args[name] = definition;
        }
    }

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
    if (isRecord(parsed.metadata)) {
        frontmatter.metadata = parsed.metadata;
    }
    return { frontmatter, body };
}

export function readTypedSkillMetadata(filePath: string): TypedSkillMetadata | undefined {
    const content = readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseSkillMarkdown(content);
    if (frontmatter.name === undefined || frontmatter.description === undefined) {
        return undefined;
    }
    const rawArguments = frontmatter.metadata?.arguments;
    if (rawArguments === undefined) {
        return undefined;
    }

    const { args } = normalizeSkillArguments(rawArguments);
    if (Object.keys(args).length === 0) {
        return undefined;
    }

    const formTitle = optionalString(frontmatter.metadata?.form_title);
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
    return metadata;
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

export function renderTypedSkillInvocation(options: RenderTypedSkillInvocationOptions): string {
    const { skill, values } = options;
    let usedPlaceholders = false;
    const renderedBody = skill.body.replace(PLACEHOLDER_PATTERN, (_placeholder, path: string) => {
        usedPlaceholders = true;
        return formatInlineValue(resolveArgumentPath(values, path));
    });

    const sections = [
        `<skill name="${skill.name}" location="${skill.filePath}">`,
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
