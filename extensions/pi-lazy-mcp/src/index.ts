import { reportExtensionDiagnostic } from "@zigai/pi-extension-internals";
import { realpath } from "node:fs/promises";
import { Type, type TUnsafe } from "typebox";
import type {
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { CatalogConflict, LazyServer, toolName } from "./server.ts";
import type { Catalog } from "./settings-input.ts";
import { loadLazyMcpSettings } from "./settings.ts";
import { mcpResultSchema, toolResult } from "./result.ts";

import type { JsonObject } from "./json.ts";
import type { McpRequestOptions } from "@earendil-works/pi-mcp";

type McpTool = ToolDefinition<TUnsafe<JsonObject>>;

export default function extension(pi: ExtensionAPI): void {
    let servers = new Map<string, LazyServer>();
    const definitions = new Map<string, McpTool>();
    const registered = new Set<string>();
    const withdrawnActive = new Map<string, boolean>();
    let identity: string | undefined;
    let generation = 0;
    let failure: string | undefined;

    const sessionIdentity = async (ctx: ExtensionContext): Promise<string> =>
        JSON.stringify([
            await realpath(ctx.cwd),
            ctx.isProjectTrusted(),
            ctx.sessionManager.getSessionId(),
        ]);

    const assertOwnership = async (ctx: ExtensionContext, version: number): Promise<void> => {
        const contextIdentity = await sessionIdentity(ctx);
        if (version !== generation || identity === undefined || identity !== contextIdentity) {
            throw new Error(
                "MCP catalog belongs to another root, trust decision, or session; reload required",
            );
        }
    };

    const reset = async (): Promise<void> => {
        generation += 1;

        const previous = servers;
        servers = new Map();
        identity = undefined;
        registered.clear();
        withdrawnActive.clear();

        for (const definition of definitions.values()) {
            pi.registerTool({ ...definition, exposure: "hidden" });
        }

        for (const server of previous.values()) await server.dispose();
    };

    const register = (server: LazyServer, catalog: Catalog): void => {
        const present = new Set<string>();
        const namespace = `mcp__${server.config.name}`;
        const existingTools = pi.getAllTools();
        for (const tool of catalog.tools) {
            const name = toolName(server.config.name, tool.name);
            const owner = definitions.get(name);
            if (
                present.has(name) ||
                (registered.has(name) && owner?.namespace?.name !== namespace) ||
                existingTools.some((existing) => existing.name === name && !definitions.has(name))
            ) {
                throw new CatalogConflict("Pi Lazy MCP tool ownership conflict");
            }

            present.add(name);
        }

        for (const [name, definition] of definitions) {
            if (definition.namespace?.name === `mcp__${server.config.name}` && !present.has(name)) {
                if (!withdrawnActive.has(name))
                    withdrawnActive.set(name, pi.getActiveTools().includes(name));

                pi.registerTool({ ...definition, exposure: "hidden" });
            }
        }

        for (const tool of catalog.tools) {
            const name = toolName(server.config.name, tool.name);
            const definition: McpTool = {
                name,
                label: tool.title ?? tool.name,
                description: tool.description ?? tool.name,
                parameters: Type.Unsafe<JsonObject>({
                    ...tool.inputSchema,
                    properties: tool.inputSchema.properties ?? {},
                }),
                outputSchema: mcpResultSchema(tool.outputSchema),
                exposure: server.config.exposure,
                namespace: {
                    name: namespace,
                    description: server.config.description,
                    instructions: catalog.instructions ?? "",
                },
                async execute(_id, args, signal, _update, ctx) {
                    const version = generation;
                    await assertOwnership(ctx, version);

                    const options: McpRequestOptions = {};
                    if (signal !== undefined) options.signal = signal;

                    const result = await server.call(catalog, tool.name, args, options);

                    await assertOwnership(ctx, version);

                    return toolResult(result);
                },
            };
            if (tool.annotations !== undefined) definition.annotations = tool.annotations;

            if (registered.has(name))
                definition.defaultActive =
                    withdrawnActive.get(name) ?? pi.getActiveTools().includes(name);

            registered.add(name);
            definitions.set(name, definition);
            pi.registerTool(definition);
            withdrawnActive.delete(name);
        }
    };

    pi.on("session_start", async (_event, ctx) => {
        const resetting = reset();
        const current = generation;
        await resetting;

        if (current !== generation) return;

        failure = undefined;

        try {
            const root = await realpath(ctx.cwd);

            if (current !== generation) return;

            if (pi.getMcpServers().length !== 0)
                throw new Error(
                    "Pi Lazy MCP cannot own extension-registered servers without supplied catalogs",
                );

            const nextIdentity = JSON.stringify([
                root,
                ctx.isProjectTrusted(),
                ctx.sessionManager.getSessionId(),
            ]);
            const loaded = loadLazyMcpSettings(ctx);
            if (loaded.diagnostics.length !== 0)
                throw new Error("Pi Lazy MCP settings are invalid; correct them and reload");

            identity = nextIdentity;

            const toolNames = new Set<string>();
            for (const config of loaded.settings.servers) {
                for (const tool of config.catalog.tools) {
                    const name = toolName(config.name, tool.name);
                    if (
                        toolNames.has(name) ||
                        pi
                            .getAllTools()
                            .some((existing) => existing.name === name && !definitions.has(name))
                    ) {
                        throw new Error("Pi Lazy MCP tool ownership conflict");
                    }

                    toolNames.add(name);
                }
            }

            for (const config of loaded.settings.servers) {
                const server = new LazyServer(
                    config,
                    root,
                    (catalog) => {
                        if (current === generation) register(server, catalog);
                    },
                    (message) => {
                        if (current === generation)
                            reportExtensionDiagnostic(message, "error", ctx);
                    },
                );

                servers.set(config.name, server);
                register(server, server.catalog);
            }
        } catch (cause) {
            if (current !== generation) return;

            failure =
                "Pi Lazy MCP initialization failed; inspect the supplied catalog, settings, and ownership";

            const closing = reset();
            const failed = generation;
            await closing;

            if (failed !== generation) return;

            if (cause instanceof Error) failure = cause.message;
            throw new Error(failure);
        }
    });

    pi.on("mcp_servers_change", async () => {
        if (pi.getMcpServers().length === 0) return;

        failure =
            "Pi Lazy MCP requires its own server catalogs; extension MCP registrations are unsupported";

        const closing = reset();
        const current = generation;
        await closing;

        if (current !== generation) return;

        throw new Error(failure);
    });
    pi.on("session_shutdown", reset);

    pi.registerCommand("mcp", {
        description:
            "Owned lazy MCP status; /mcp discover NAME explicitly connects one server and refreshes its session catalog",
        async handler(args, ctx) {
            if (failure !== undefined) throw new Error(failure);

            const words = args.trim().split(/\s+/);
            if (words[0] === "discover" && words.length === 2) {
                const version = generation;
                await assertOwnership(ctx, version);

                const server = servers.get(words[1] ?? "");
                if (server === undefined) throw new Error("Unknown lazy MCP server");

                const catalog = await server.discover();

                await assertOwnership(ctx, version);
                pi.sendMessage({
                    customType: "lazy-mcp-catalog",
                    content: JSON.stringify({ server: server.config.name, catalog }),
                    display: true,
                });

                return;
            }

            if (args.trim() !== "") throw new Error("Use /mcp or /mcp discover NAME");

            const status = [...servers.values()]
                .map(
                    (server) =>
                        `${server.config.name}: ${server.state}, ${server.catalog.tools.length} tools`,
                )
                .join("\n");
            if (ctx.hasUI)
                ctx.ui.notify(
                    status || "No lazy MCP servers configured. Native session MCP is replaced.",
                    "info",
                );
            else
                pi.sendMessage({
                    customType: "lazy-mcp-status",
                    content:
                        status || "No lazy MCP servers configured. Native session MCP is replaced.",
                    display: true,
                });
        },
    });
}
