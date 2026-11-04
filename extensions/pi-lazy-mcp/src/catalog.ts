import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Tool } from "@earendil-works/pi-mcp";
import { Type, type StaticDecode, type TSchema } from "typebox";
import { Value } from "typebox/value";

import type { McpServerConfig } from "./config.ts";
import { parsedJsonObjectSchema, parsedJsonValueSchema, type JsonValue } from "./json.ts";

const toolSchema = Type.Object({
    name: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    inputSchema: parsedJsonObjectSchema,
    outputSchema: Type.Optional(parsedJsonObjectSchema),
    annotations: Type.Optional(parsedJsonObjectSchema),
    execution: Type.Optional(parsedJsonObjectSchema),
});

export const catalogSchema = Type.Object({
    instructions: Type.Optional(Type.String()),
    tools: Type.Array(toolSchema),
});

export type Catalog = StaticDecode<typeof catalogSchema>;
export type CatalogTool = Catalog["tools"][number];

const catalogsFileSchema = Type.Record(Type.String(), parsedJsonValueSchema);
const CATALOGS_FILE = "lazy-mcp-catalogs.json";

export function catalogsPath(agentDir: string): string {
    return join(agentDir, CATALOGS_FILE);
}

export function catalogKey(name: string, config: McpServerConfig): string {
    let identity: readonly unknown[];
    if ("url" in config) identity = [null, [], config.url];
    else identity = [config.command, config.args ?? [], null];

    const hash = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
    return `${name}:${hash}`;
}

function hasUniqueNames(tools: readonly CatalogTool[]): boolean {
    return new Set(tools.map((tool) => tool.name)).size === tools.length;
}

function toCatalogTool(tool: Tool): CatalogTool {
    const fields = new Map<string, TSchema>(Object.entries(toolSchema.properties));
    const kept = Object.entries(tool).filter(([field, value]) => {
        const schema = fields.get(field);
        return schema !== undefined && Value.Check(schema, value);
    });
    const parsed = Object.fromEntries(kept);
    if (!Value.Check(toolSchema, parsed))
        throw new Error(`MCP tool "${tool.name}" has an invalid definition`);

    return parsed;
}

export function toCatalog(instructions: string | undefined, tools: readonly Tool[]): Catalog {
    const catalog: Catalog = { tools: tools.map(toCatalogTool) };
    if (!hasUniqueNames(catalog.tools)) throw new Error("MCP tool list has duplicate names");

    const trimmed = instructions?.trim();
    if (trimmed !== undefined && trimmed !== "") catalog.instructions = trimmed;

    return catalog;
}

function isCatalog(value: JsonValue): value is Catalog {
    return Value.Check(catalogSchema, value) && hasUniqueNames(value.tools);
}

export function readCatalogs(path: string): Map<string, Catalog> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return new Map();
    }

    if (!Value.Check(catalogsFileSchema, parsed)) return new Map();

    const catalogs = new Map<string, Catalog>();
    for (const [key, entry] of Object.entries(parsed)) {
        if (isCatalog(entry)) catalogs.set(key, entry);
    }

    return catalogs;
}

export function saveCatalog(path: string, key: string, catalog: Catalog): void {
    // Other sessions write this file too. Synchronous steps keep the window small; an update lost to a
    // simultaneous writer only means that server is discovered again.
    const merged = new Map(readCatalogs(path));
    merged.set(key, catalog);

    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;

    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temporary, JSON.stringify(Object.fromEntries(merged)), {
            mode: 0o600,
            flag: "wx",
        });

        renameSync(temporary, path);
    } catch (cause) {
        rmSync(temporary, { force: true });
        throw cause;
    }
}
