import type { ExtensionSettingsDefinition } from "./definition.ts";
import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "./json-value.ts";
import { defaultGlobalSettingsDisplayPath } from "./paths.ts";
import {
    createDefaultSettingsDocument,
    createSettingsDocument,
    createSettingsFileSchema,
} from "./schema-document.ts";

export const README_GENERATED_START = "<!-- pi-extension-settings:start -->";
export const README_GENERATED_END = "<!-- pi-extension-settings:end -->";

const MAX_INLINE_DEFAULT_CHARACTERS = 48;
const MAX_INLINE_TYPE_CHARACTERS = 120;
const TYPE_NAME_PATTERN = /^[A-Z][A-Za-z0-9]{0,39}$/;

type SettingsRow = {
    readonly path: string;
    readonly type: string;
    readonly defaultValue: JsonValue | undefined;
    readonly description: string;
};

function valueAtPath(root: JsonObject, path: readonly string[]): JsonValue | undefined {
    let current: JsonValue = root;
    for (const segment of path) {
        if (!isJsonObject(current)) return undefined;
        const next: JsonValue | undefined = current[segment];
        if (next === undefined) return undefined;
        current = next;
    }
    return current;
}

function markdownCode(value: string): string {
    if (value === "") return "<code></code>";

    let longestBacktickRun = 0;
    for (const match of value.matchAll(/`+/g)) {
        longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
    }
    const fence = "`".repeat(longestBacktickRun + 1);
    const needsPadding =
        value.startsWith("`") ||
        value.endsWith("`") ||
        value.startsWith(" ") ||
        value.endsWith(" ");
    const content = needsPadding ? ` ${value} ` : value;
    return `${fence}${content}${fence}`;
}

function literalType(value: JsonValue): string {
    if (typeof value === "string") return markdownCode(value === "" ? '""' : value);
    return markdownCode(JSON.stringify(value));
}

function directPrimitiveType(schema: JsonObject): string | undefined {
    if (schema.const !== undefined || Array.isArray(schema.enum)) return undefined;
    if (typeof schema.type !== "string") return undefined;
    if (["boolean", "integer", "null", "number", "string"].includes(schema.type)) {
        return schema.type;
    }
    return undefined;
}

function valueCoveredByPrimitiveTypes(value: JsonValue, types: ReadonlySet<string>): boolean {
    if (value === null) return types.has("null");
    if (typeof value === "number") {
        if (types.has("number")) return true;
        return Number.isInteger(value) && types.has("integer");
    }
    return types.has(typeof value);
}

function schemaCoveredByPrimitiveTypes(schema: JsonObject, types: ReadonlySet<string>): boolean {
    if (schema.const !== undefined && isJsonValue(schema.const)) {
        return valueCoveredByPrimitiveTypes(schema.const, types);
    }
    if (Array.isArray(schema.enum)) {
        const values = schema.enum.filter(isJsonValue);
        return (
            values.length > 0 && values.every((value) => valueCoveredByPrimitiveTypes(value, types))
        );
    }
    const alternatives = schema.anyOf ?? schema.oneOf;
    if (!Array.isArray(alternatives) || alternatives.length === 0) return false;
    return alternatives.every(
        (alternative) =>
            isJsonObject(alternative) && schemaCoveredByPrimitiveTypes(alternative, types),
    );
}

function schemaTypeTitle(schema: JsonObject): string | undefined {
    if (typeof schema.title !== "string") return undefined;
    const title = schema.title.trim();
    return TYPE_NAME_PATTERN.test(title) ? title : undefined;
}

function schemaType(schema: JsonObject): string {
    if (schema.const !== undefined && isJsonValue(schema.const)) return literalType(schema.const);
    if (Array.isArray(schema.enum)) {
        return schema.enum.filter(isJsonValue).map(literalType).join(" | ");
    }

    const alternatives = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(alternatives)) {
        const schemas = alternatives.filter(isJsonObject);
        const primitiveTypes = new Set(
            schemas
                .map(directPrimitiveType)
                .filter((value): value is string => value !== undefined),
        );
        const numberSubsumesInteger = primitiveTypes.has("number");

        return schemas
            .filter((alternative) => {
                const directType = directPrimitiveType(alternative);
                if (directType !== undefined) {
                    return !(directType === "integer" && numberSubsumesInteger);
                }
                return !schemaCoveredByPrimitiveTypes(alternative, primitiveTypes);
            })
            .map(schemaType)
            .filter((value, index, values) => values.indexOf(value) === index)
            .join(" | ");
    }

    if (schema.type === "array") {
        if (!isJsonObject(schema.items)) return "array";
        const itemType = schemaType(schema.items);
        if (itemType.includes(" | ")) return `(${itemType})[]`;
        return `${itemType}[]`;
    }
    if (schema.type === "object") {
        const title = schemaTypeTitle(schema);
        if (title !== undefined) return title;
        if (isJsonObject(schema.properties)) {
            const required = new Set(
                Array.isArray(schema.required)
                    ? schema.required.filter((value): value is string => typeof value === "string")
                    : [],
            );
            const fields = Object.entries(schema.properties).map(([key, value]) => {
                const optional = required.has(key) ? "" : "?";
                const type = isJsonObject(value) ? schemaType(value) : "JSON value";
                return `${key}${optional}: ${type}`;
            });
            return `{ ${fields.join("; ")} }`;
        }
        if (isJsonObject(schema.patternProperties)) {
            const valueTypes = Object.values(schema.patternProperties)
                .map((value) => (isJsonObject(value) ? schemaType(value) : "JSON value"))
                .filter((value, index, values) => values.indexOf(value) === index);
            if (valueTypes.length > 0) return `Record<string, ${valueTypes.join(" | ")}>`;
        }
        return "object";
    }
    if (Array.isArray(schema.type)) {
        return schema.type
            .filter((value): value is string => typeof value === "string")
            .filter((value, index, values) => values.indexOf(value) === index)
            .join(" | ");
    }
    if (typeof schema.type === "string") return schema.type;
    if (typeof schema.$ref === "string") {
        const segments = schema.$ref.split(/[/#]/).filter((segment) => segment !== "");
        return segments.at(-1) ?? "referenced value";
    }
    return "JSON value";
}

function collectRows(
    properties: JsonObject,
    defaults: JsonObject,
    prefix: readonly string[] = [],
): readonly SettingsRow[] {
    const rows: SettingsRow[] = [];
    for (const [key, value] of Object.entries(properties)) {
        if (key === "$schema" || !isJsonObject(value)) continue;
        const path = [...prefix, key];
        if (value.type === "object" && isJsonObject(value.properties)) {
            rows.push(...collectRows(value.properties, defaults, path));
            continue;
        }
        const type = schemaType(value);
        if (type.length > MAX_INLINE_TYPE_CHARACTERS) {
            throw new TypeError(
                `Generated README type for "${path.join(".")}" is too long; add a concise PascalCase title to the complex item or record-value schema.`,
            );
        }
        rows.push({
            path: path.join("."),
            type,
            defaultValue: valueAtPath(defaults, path),
            description: typeof value.description === "string" ? value.description : "",
        });
    }
    return rows;
}

function markdownCell(value: string): string {
    return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function canRenderDefaultInline(value: JsonValue): boolean {
    if (value === null || typeof value === "boolean" || typeof value === "number") return true;
    if (typeof value === "string") {
        return (
            !value.includes("\n") && JSON.stringify(value).length <= MAX_INLINE_DEFAULT_CHARACTERS
        );
    }
    if (Array.isArray(value)) return value.length === 0;
    return Object.keys(value).length === 0;
}

function formatDefault(value: JsonValue | undefined): string {
    if (value === undefined) return "—";
    if (!canRenderDefaultInline(value)) return "*See JSON below*";
    return markdownCode(markdownCell(JSON.stringify(value)));
}

export type RenderReadmeOptions = {
    readonly globalPath?: string;
};

export function renderReadmeSettingsSection(
    definition: ExtensionSettingsDefinition,
    options: RenderReadmeOptions = {},
): string {
    const fileSchema = createSettingsFileSchema(definition);
    /* v8 ignore next -- createSettingsFileSchema always returns an object properties map */
    if (!isJsonObject(fileSchema.properties)) {
        throw new TypeError("Generated settings schema does not contain properties.");
    }

    const rows = collectRows(fileSchema.properties, definition.defaultSettings);
    const tableRows = rows.map(
        (row) =>
            `| ${markdownCell(markdownCode(row.path))} | ${markdownCell(row.type)} | ${formatDefault(row.defaultValue)} | ${markdownCell(row.description)} |`,
    );
    const globalPath = options.globalPath ?? defaultGlobalSettingsDisplayPath(definition.id);
    const defaultDocument = createDefaultSettingsDocument(definition);
    const documentation = [
        "## Configuration",
        "",
        `Global settings are stored in ${markdownCode(globalPath)}.`,
        "",
        "| Option | Type | Default | Description |",
        "| --- | --- | --- | --- |",
        ...tableRows,
        "",
    ];

    if (definition.exampleSettings !== undefined) {
        documentation.push("### Defaults", "");
    }
    documentation.push("```json", JSON.stringify(defaultDocument, undefined, 2), "```");

    if (definition.exampleSettings !== undefined) {
        const exampleDocument = createSettingsDocument(definition.id, definition.exampleSettings);
        documentation.push(
            "",
            "### Advanced example",
            "",
            "```json",
            JSON.stringify(exampleDocument, undefined, 2),
            "```",
        );
    }

    return documentation.join("\n");
}

export function replaceGeneratedReadmeSection(
    readme: string,
    generatedSection: string,
): string | undefined {
    const start = readme.indexOf(README_GENERATED_START);
    const end = readme.indexOf(README_GENERATED_END);
    if (start < 0 && end < 0) {
        return `${readme.trimEnd()}\n\n${README_GENERATED_START}\n${generatedSection.trim()}\n${README_GENERATED_END}\n`;
    }
    if (start < 0 || end < start) return undefined;
    if (readme.indexOf(README_GENERATED_START, start + 1) >= 0) return undefined;
    if (readme.indexOf(README_GENERATED_END, end + 1) >= 0) return undefined;

    const before = readme.slice(0, start + README_GENERATED_START.length);
    const after = readme.slice(end);
    return `${before}\n${generatedSection.trim()}\n${after}`;
}
