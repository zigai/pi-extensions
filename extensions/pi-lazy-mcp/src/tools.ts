import { createHash } from "node:crypto";

import type { ToolAnnotations, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "typebox";

import type { Catalog, CatalogTool } from "./catalog.ts";
import { mcpNamespace, type McpExposure, type McpServerEntry } from "./config.ts";
import { isJsonString, type JsonObject } from "./json.ts";
import { mcpResultSchema } from "./result.ts";

export type McpTool = ToolDefinition<TUnsafe<JsonObject>>;
type ToolNamespace = NonNullable<McpTool["namespace"]>;
type ToolExecute = McpTool["execute"];

const MAX_TOOL_NAME_LENGTH = 64;

const ANNOTATION_HINTS = [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
] as const;

export function toToolExposure(exposure: McpExposure): "direct" | "deferred" | "hidden" {
    if (exposure === "codemode") return "deferred";

    return exposure;
}

function createToolName(server: string, tool: string, isTaken: (name: string) => boolean): string {
    const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
    if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;

    const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
    return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

export function assignToolNames(
    server: string,
    tools: readonly string[],
    owners: Map<string, string>,
): Map<string, string> {
    // All tools whose names sanitize alike get the hash suffix, so the result ignores list order.
    const plain = tools.map((tool) => createToolName(server, tool, () => false));
    const current = new Set<string>();
    const names = new Map<string, string>();
    for (const tool of tools) {
        const owner = `${server}\0${tool}`;
        const name = createToolName(server, tool, (candidate) => {
            const existing = owners.get(candidate);
            return (
                (existing !== undefined && existing !== owner) ||
                current.has(candidate) ||
                plain.indexOf(candidate) !== plain.lastIndexOf(candidate)
            );
        });

        owners.set(name, owner);
        current.add(name);
        names.set(tool, name);
    }

    return names;
}

export function reachesServer(reach: "all" | readonly string[], server: string): boolean {
    if (reach === "all") return true;

    const namespace = mcpNamespace(server);

    return reach.some((word) => word.includes(namespace));
}

export function toolNamespace(entry: McpServerEntry, catalog: Catalog): ToolNamespace {
    const namespace: ToolNamespace = {
        name: mcpNamespace(entry.name),
        aliases: [entry.name],
    };
    const description = entry.config.description?.trim();
    if (description !== undefined && description !== "") namespace.description = description;

    if (catalog.instructions !== undefined) namespace.instructions = catalog.instructions;

    return namespace;
}

function toolTitle(tool: CatalogTool): string | undefined {
    if (tool.title !== undefined) return tool.title;

    const title = tool.annotations?.title;
    if (title !== undefined && isJsonString(title)) return title;

    return undefined;
}

function toolDescription(server: string, tool: CatalogTool): string {
    const description = tool.description?.trim();
    if (description !== undefined && description !== "") return description;

    const title = toolTitle(tool);
    if (title !== undefined && title !== "") return title;

    return `MCP tool ${tool.name} from server ${server}`;
}

function toolAnnotations(tool: CatalogTool): ToolAnnotations | undefined {
    const annotations: ToolAnnotations = {};
    let found = false;
    for (const hint of ANNOTATION_HINTS) {
        const value = tool.annotations?.[hint];
        if (value === true || value === false) {
            annotations[hint] = value;
            found = true;
        }
    }

    if (found) return annotations;

    return undefined;
}

export function createToolDefinition(options: {
    server: string;
    tool: CatalogTool;
    name: string;
    exposure: McpExposure;
    namespace: ToolNamespace;
    execute: ToolExecute;
}): McpTool {
    const { server, tool } = options;
    const schema = tool.inputSchema;
    const definition: McpTool = {
        name: options.name,
        label: `${server}/${tool.name}`,
        description: toolDescription(server, tool),
        parameters: Type.Unsafe<JsonObject>({
            ...schema,
            type: schema.type ?? "object",
            properties: schema.properties ?? {},
        }),
        outputSchema: mcpResultSchema(tool.outputSchema),
        exposure: toToolExposure(options.exposure),
        namespace: options.namespace,
        execute: options.execute,
    };
    const annotations = toolAnnotations(tool);
    if (annotations !== undefined) definition.annotations = annotations;

    return definition;
}
