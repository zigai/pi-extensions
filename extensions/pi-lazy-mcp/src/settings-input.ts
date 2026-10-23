import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";
import { Type, type StaticDecode } from "typebox";

import { jsonObjectSchema } from "./json.ts";

export const toolSchema = Type.Object(
    {
        name: Type.String({ minLength: 1 }),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        inputSchema: jsonObjectSchema,
        outputSchema: Type.Optional(jsonObjectSchema),
        annotations: Type.Optional(
            Type.Object(
                {
                    title: Type.Optional(Type.String()),
                    readOnlyHint: Type.Optional(Type.Boolean()),
                    destructiveHint: Type.Optional(Type.Boolean()),
                    idempotentHint: Type.Optional(Type.Boolean()),
                    openWorldHint: Type.Optional(Type.Boolean()),
                },
                { additionalProperties: false },
            ),
        ),
        execution: Type.Optional(
            Type.Object(
                {
                    taskSupport: Type.Optional(Type.Enum(["forbidden", "optional", "required"])),
                },
                { additionalProperties: false },
            ),
        ),
        _meta: Type.Optional(jsonObjectSchema),
    },
    { title: "CatalogTool", additionalProperties: false },
);

export const catalogSchema = Type.Object(
    {
        instructions: Type.Optional(Type.String()),
        tools: Type.Array(toolSchema),
    },
    { title: "ToolCatalog", additionalProperties: false },
);

const environment = Type.Record(Type.String(), Type.String(), {
    description:
        "Environment variable bindings: destination name to source variable name. Values are never persisted credentials.",
});

const transportSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("stdio"),
            command: Type.String({ minLength: 1 }),
            args: Type.Array(Type.String()),
            cwd: Type.String({
                description: "Working directory, relative to the session root or absolute.",
            }),
            env: environment,
        },
        { title: "StdioServer", additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("http"),
            url: Type.String({
                format: "uri",
                description: "Streamable HTTP endpoint without embedded credentials.",
            }),
            headers: environment,
        },
        { title: "HttpServer", additionalProperties: false },
    ),
]);

export const serverSchema = Type.Object(
    {
        name: Type.String({ pattern: "^[A-Za-z0-9_]+$", maxLength: 24 }),
        description: Type.String(),
        transport: transportSchema,
        catalog: catalogSchema,
        exposure: Type.Enum(["direct", "codemode", "deferred", "hidden"], {
            description: "Pi tool exposure; discovery uses supplied metadata without connecting.",
        }),
        idle: Type.Optional(
            Type.Object(
                {
                    afterMs: Type.Integer({
                        minimum: 1,
                        maximum: 2147483647,
                        description:
                            "Disconnect after this idle duration. Set only for restart-safe servers; active calls and residency capabilities prevent eviction.",
                    }),
                },
                { title: "IdlePolicy", additionalProperties: false },
            ),
        ),
    },
    { title: "LazyServer", additionalProperties: false },
);

export const settingsSchema = Type.Object(
    {
        servers: Type.Array(serverSchema, {
            default: [],
            description:
                "Owned servers and supplied catalogs. This extension replaces native session MCP; use /mcp discover NAME to explicitly refresh one catalog.",
        }),
    },
    { additionalProperties: false },
);

export type Catalog = StaticDecode<typeof catalogSchema>;
export type Server = StaticDecode<typeof serverSchema>;

const settingsInput = {
    id: "pi-lazy-mcp",
    title: "Pi Lazy MCP",
    description: "Demand-owned MCP connections and dormant tool metadata.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-lazy-mcp/config.schema.json",
    schema: settingsSchema,
    exampleSettings: {
        servers: [
            {
                name: "sample",
                description: "Sample lookups",
                exposure: "deferred",
                transport: { type: "stdio", command: "sample-mcp", args: [], cwd: ".", env: {} },
                catalog: {
                    tools: [
                        {
                            name: "lookup",
                            description: "Look up a sample entry",
                            inputSchema: {
                                type: "object",
                                properties: { key: { type: "string" } },
                                required: ["key"],
                            },
                        },
                    ],
                },
            },
        ],
    },
} satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;

export default settingsInput;
