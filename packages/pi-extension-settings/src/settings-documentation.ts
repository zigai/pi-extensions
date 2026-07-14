import type { ExtensionSettingsDefinition } from "./definition.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "./json-value.ts";
import { defaultGlobalSettingsDisplayPath } from "./paths.ts";
import { createDefaultSettingsDocument, createSettingsFileSchema } from "./schema-document.ts";

export const README_GENERATED_START = "<!-- pi-extension-settings:start -->";
export const README_GENERATED_END = "<!-- pi-extension-settings:end -->";

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

function schemaType(schema: JsonObject): string {
    if (typeof schema.const === "string") return `\`${schema.const}\``;
    if (Array.isArray(schema.enum)) {
        return schema.enum.map((value) => `\`${String(value)}\``).join(" | ");
    }

    const alternatives = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(alternatives)) {
        return alternatives
            .map((alternative) => (isJsonObject(alternative) ? schemaType(alternative) : "unknown"))
            .filter((value, index, values) => values.indexOf(value) === index)
            .join(" | ");
    }

    if (schema.type === "array") {
        if (!isJsonObject(schema.items)) return "array";
        const itemType = schemaType(schema.items);
        if (itemType.includes(" | ")) return `(${itemType})[]`;
        return `${itemType}[]`;
    }
    if (typeof schema.type === "string") return schema.type;
    if (typeof schema.$ref === "string") return "reference";
    return "unknown";
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
        rows.push({
            path: path.join("."),
            type: schemaType(value),
            defaultValue: valueAtPath(defaults, path),
            description: typeof value.description === "string" ? value.description : "",
        });
    }
    return rows;
}

function markdownCell(value: string): string {
    return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatDefault(value: JsonValue | undefined): string {
    if (value === undefined) return "—";
    return `\`${markdownCell(JSON.stringify(value))}\``;
}

export type RenderReadmeOptions = {
    readonly globalPath?: string;
};

/** Render the generated README configuration section from the TypeBox definition. */
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
            `| \`${row.path}\` | ${markdownCell(row.type)} | ${formatDefault(row.defaultValue)} | ${markdownCell(row.description)} |`,
    );
    const globalPath = options.globalPath ?? defaultGlobalSettingsDisplayPath(definition.id);
    const defaultDocument = createDefaultSettingsDocument(definition);

    return [
        "## Configuration",
        "",
        `Global settings are stored in \`${globalPath}\`.`,
        "",
        "| Option | Type | Default | Description |",
        "| --- | --- | --- | --- |",
        ...tableRows,
        "",
        "```json",
        JSON.stringify(defaultDocument, undefined, 2),
        "```",
    ].join("\n");
}

/** Replace the generated region, appending it when neither marker is present. */
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
