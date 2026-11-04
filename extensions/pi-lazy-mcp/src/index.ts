import { reportExtensionDiagnostic } from "@zigai/pi-extension-internals";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
    CONFIG_DIR_NAME,
    getAgentDir,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { McpAbortError, type McpRequestOptions } from "@earendil-works/pi-mcp";

import { catalogKey, catalogsPath, readCatalogs, saveCatalog, type Catalog } from "./catalog.ts";
import {
    configuredExposures,
    exposureOf,
    isEnabled,
    loadMcpConfig,
    toolExposureOf,
    usesAuthentication,
    type McpServerEntry,
} from "./config.ts";
import { toolResult } from "./result.ts";
import { LazyServer } from "./server.ts";
import { MCP_SERVERS_SECTION, renderServersSection } from "./servers-section.ts";
import { loadLazyMcpSettings } from "./settings.ts";
import {
    assignToolNames,
    createToolDefinition,
    reachesServer,
    toolNamespace,
    type McpTool,
} from "./tools.ts";

const CODEMODE_TOOL = "codemode";
const TOOL_SEARCH_TOOL = "tool_search";
const DIRECT_DISCOVERY_WAIT_MS = 10_000;

type ManagedServer = {
    entry: McpServerEntry;
    key: string;
    server: LazyServer | undefined;
    problem: string | undefined;
};

function errorMessage(cause: unknown): string {
    if (cause instanceof Error) return cause.message;

    return String(cause);
}

function firstLine(text: string): string {
    return text.split("\n", 1)[0] ?? "";
}

export default function extension(pi: ExtensionAPI): void {
    let servers = new Map<string, ManagedServer>();
    let discoveries = new Map<string, Promise<void>>();
    let configErrors: string[] = [];
    let autoEnableCodemode = true;
    let warnedUnreachable = false;
    let waitedForDirect = false;
    const ignoredRegistrations = new Set<string>();
    const definitions = new Map<string, McpTool>();
    const registered = new Set<string>();
    const withdrawnActive = new Map<string, boolean>();
    const toolOwners = new Map<string, string>();
    const serverTools = new Map<string, Set<string>>();
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
        discoveries = new Map();
        configErrors = [];
        identity = undefined;
        warnedUnreachable = false;
        waitedForDirect = false;
        ignoredRegistrations.clear();
        registered.clear();
        withdrawnActive.clear();
        serverTools.clear();

        for (const definition of definitions.values()) {
            pi.registerTool({ ...definition, exposure: "hidden" });
        }

        for (const { server } of previous.values()) await server?.dispose();
    };

    const register = (managed: ManagedServer, server: LazyServer, catalog: Catalog): void => {
        const { entry } = managed;
        const previous = serverTools.get(entry.name) ?? new Set<string>();
        const names = assignToolNames(
            entry.name,
            catalog.tools.map((tool) => tool.name),
            toolOwners,
        );
        const current = new Set(names.values());
        const namespace = toolNamespace(entry, catalog);

        for (const name of previous) {
            const definition = definitions.get(name);
            if (definition !== undefined && !current.has(name)) {
                if (!withdrawnActive.has(name))
                    withdrawnActive.set(name, pi.getActiveTools().includes(name));

                pi.registerTool({ ...definition, exposure: "hidden" });
            }
        }

        for (const tool of catalog.tools) {
            const name = names.get(tool.name) ?? tool.name;
            const definition = createToolDefinition({
                server: entry.name,
                tool,
                name,
                exposure: toolExposureOf(entry.config, tool.name),
                namespace,
                async execute(_id, args, signal, onUpdate, ctx) {
                    const version = generation;
                    await assertOwnership(ctx, version);

                    const options: McpRequestOptions = {
                        onProgress: (progress) => {
                            let total = "";
                            if (progress.total !== undefined) total = `/${progress.total}`;

                            onUpdate?.({
                                content: [
                                    {
                                        type: "text",
                                        text:
                                            progress.message ??
                                            `Progress ${progress.progress}${total}`,
                                    },
                                ],
                                details: { server: entry.name, tool: tool.name },
                            });
                        },
                    };
                    if (signal !== undefined) options.signal = signal;

                    const result = await server.call(catalog, tool.name, args, options);

                    await assertOwnership(ctx, version);

                    return toolResult(result, { server: entry.name, tool: tool.name });
                },
            });

            if (registered.has(name))
                definition.defaultActive =
                    withdrawnActive.get(name) ?? pi.getActiveTools().includes(name);

            registered.add(name);
            definitions.set(name, definition);
            pi.registerTool(definition);
            withdrawnActive.delete(name);
        }

        serverTools.set(entry.name, current);
    };

    const saveServerCatalog = (
        managed: ManagedServer,
        catalog: Catalog,
        ctx: ExtensionContext,
    ): void => {
        try {
            saveCatalog(catalogsPath(getAgentDir()), managed.key, catalog);
        } catch (cause) {
            reportExtensionDiagnostic(
                `Could not save the MCP catalog of "${managed.entry.name}": ${errorMessage(cause)}`,
                "warning",
                ctx,
            );
        }
    };

    const reachableServers = (): ManagedServer[] =>
        [...servers.values()].filter((managed) => managed.server !== undefined);

    const ensureDiscoveryActive = (ctx: ExtensionContext): void => {
        const exposures = new Set(
            reachableServers().flatMap((managed) => [...configuredExposures(managed.entry.config)]),
        );
        const needsCodemode = exposures.has("codemode");
        const needsToolSearch = exposures.has("deferred");
        if (!needsCodemode && !needsToolSearch) return;

        const tools = pi.getAllTools();
        const canReach = (name: string): boolean =>
            tools.some((tool) => tool.name === name && tool.reachesTools !== undefined);
        const hasCodemode = canReach(CODEMODE_TOOL);
        const hasToolSearch = canReach(TOOL_SEARCH_TOOL);
        const active = pi.getActiveTools();
        const activate: string[] = [];
        if (needsCodemode && hasCodemode && autoEnableCodemode && !active.includes(CODEMODE_TOOL))
            activate.push(CODEMODE_TOOL);

        if (needsToolSearch && hasToolSearch && !active.includes(TOOL_SEARCH_TOOL))
            activate.push(TOOL_SEARCH_TOOL);

        if (activate.length > 0) pi.setActiveTools([...active, ...activate]);

        const reachable = [...active, ...activate];
        if (hasCodemode && reachable.includes(CODEMODE_TOOL)) return;
        if (hasToolSearch && reachable.includes(TOOL_SEARCH_TOOL)) return;
        if (warnedUnreachable) return;

        warnedUnreachable = true;

        let reason = "";
        if (needsCodemode && hasCodemode && !autoEnableCodemode)
            reason = " (autoEnableCodemode is false)";

        reportExtensionDiagnostic(
            `MCP tools are only reachable from the codemode or tool_search tool, but neither is active${reason}; they cannot be called.`,
            "warning",
            ctx,
        );
    };

    const ignoreRegisteredServers = (): string[] => {
        const lines: string[] = [];
        for (const { name, extensionPath } of pi.getMcpServers()) {
            if (ignoredRegistrations.has(name)) continue;

            ignoredRegistrations.add(name);
            lines.push(
                `${name}: registered by ${extensionPath}; ignored, because pi-lazy-mcp only reads mcp.json`,
            );
        }

        return lines;
    };

    const reportProblems = (ctx: ExtensionContext): void => {
        const lines = [
            ...configErrors.map((error) => `config: ${error}`),
            ...ignoreRegisteredServers(),
        ];
        for (const managed of servers.values()) {
            if (managed.problem !== undefined)
                lines.push(`${managed.entry.name}: ${firstLine(managed.problem)}`);
        }

        if (lines.length === 0) return;

        reportExtensionDiagnostic(
            `MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}\nRun /mcp for details.`,
            "warning",
            ctx,
        );
    };

    const discoverInBackground = (
        managed: ManagedServer,
        server: LazyServer,
        version: number,
    ): void => {
        const tracked = discoveries;
        const name = managed.entry.name;
        const running = server.discover().then(
            () => {
                tracked.delete(name);
            },
            (cause: unknown) => {
                tracked.delete(name);

                if (version !== generation || cause instanceof McpAbortError) return;

                managed.problem = errorMessage(cause);
            },
        );

        tracked.set(name, running);
    };

    const startServers = (ctx: ExtensionContext, version: number): void => {
        const agentDir = getAgentDir();
        const config = loadMcpConfig({
            agentDir,
            cwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
        });
        configErrors = config.errors;
        autoEnableCodemode = config.autoEnableCodemode ?? true;

        const loaded = loadLazyMcpSettings(ctx);
        for (const diagnostic of loaded.diagnostics)
            reportExtensionDiagnostic(
                `pi-lazy-mcp: ${diagnostic.message}`,
                diagnostic.severity,
                ctx,
            );

        const catalogs = readCatalogs(catalogsPath(agentDir));

        for (const entry of config.servers) {
            const managed: ManagedServer = {
                entry,
                key: catalogKey(entry.name, entry.config),
                server: undefined,
                problem: undefined,
            };
            servers.set(entry.name, managed);

            if (!isEnabled(entry.config)) continue;

            if (usesAuthentication(entry.config)) {
                managed.problem = "uses auth or oauth, which pi-lazy-mcp does not support; skipped";
                continue;
            }

            const server: LazyServer = new LazyServer({
                entry,
                root: ctx.cwd,
                catalog: catalogs.get(managed.key),
                idleAfterMs: loaded.settings.idle[entry.name],
                changed: (catalog) => {
                    if (version !== generation) return;

                    managed.problem = undefined;
                    register(managed, server, catalog);
                    saveServerCatalog(managed, catalog, ctx);
                },
                report: (message) => {
                    if (version === generation) reportExtensionDiagnostic(message, "error", ctx);
                },
            });

            managed.server = server;
        }

        ensureDiscoveryActive(ctx);

        for (const managed of servers.values()) {
            if (managed.server === undefined) continue;

            const catalog = managed.server.catalog;
            if (catalog === undefined) discoverInBackground(managed, managed.server, version);
            else register(managed, managed.server, catalog);
        }

        void Promise.all(discoveries.values()).then(() => {
            if (version === generation) reportProblems(ctx);
        });
    };

    const waitForDirectDiscoveries = async (ctx: ExtensionContext): Promise<void> => {
        if (waitedForDirect) return;

        waitedForDirect = true;

        const waiting = [...discoveries]
            .filter(([name]) => {
                const managed = servers.get(name);
                return (
                    managed !== undefined && configuredExposures(managed.entry.config).has("direct")
                );
            })
            .map(async ([, discovery]) => discovery);
        if (waiting.length === 0) return;

        let timer: ReturnType<typeof setTimeout> | undefined;
        const finished = await Promise.race([
            Promise.all(waiting).then(() => true),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => {
                    resolve(false);
                }, DIRECT_DISCOVERY_WAIT_MS);
            }),
        ]);

        clearTimeout(timer);

        if (!finished)
            reportExtensionDiagnostic(
                "MCP servers are still being discovered; their tools become available afterwards.",
                "info",
                ctx,
            );
    };

    pi.on("session_start", async (_event, ctx) => {
        const resetting = reset();
        const current = generation;
        await resetting;

        if (current !== generation) return;

        failure = undefined;

        try {
            const nextIdentity = await sessionIdentity(ctx);

            if (current !== generation) return;

            identity = nextIdentity;
            startServers(ctx, current);
        } catch (cause) {
            if (current !== generation) return;

            failure = `Pi Lazy MCP failed to start: ${errorMessage(cause)}`;

            const closing = reset();
            const failed = generation;
            await closing;

            if (failed === generation) reportExtensionDiagnostic(failure, "error", ctx);
        }
    });

    pi.on("before_agent_start", async (event, ctx) => {
        await waitForDirectDiscoveries(ctx);

        const section = renderServersSection(
            reachableServers().map((managed) => ({
                entry: managed.entry,
                instructions: managed.server?.catalog?.instructions,
            })),
        );
        const { sections } = event.systemPromptOptions;
        if (section === undefined) delete sections[MCP_SERVERS_SECTION];
        else sections[MCP_SERVERS_SECTION] = section;
    });

    // Scripts and searches enumerate registered tools, so a server still being discovered must finish first.
    pi.on("tool_call", async (event, ctx) => {
        if (discoveries.size === 0) return;

        const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
        const reach = tool?.reachesTools?.(event.input);
        if (reach === undefined) return;

        const waiting = [...discoveries]
            .filter(([name]) => reachesServer(reach, name))
            .map(async ([, discovery]) => discovery);
        if (waiting.length === 0) return;

        const signal = ctx.signal;

        await new Promise<void>((resolve) => {
            if (signal?.aborted === true) {
                resolve();
                return;
            }

            signal?.addEventListener(
                "abort",
                () => {
                    resolve();
                },
                { once: true },
            );

            void Promise.all(waiting).then(() => {
                resolve();
            });
        });
    });

    pi.on("mcp_servers_change", (_event, ctx) => {
        const lines = ignoreRegisteredServers();
        if (lines.length > 0)
            reportExtensionDiagnostic(
                `MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}`,
                "warning",
                ctx,
            );
    });

    pi.on("session_shutdown", reset);

    const showMessage = (ctx: ExtensionContext, customType: string, content: string): void => {
        if (ctx.hasUI) ctx.ui.notify(content, "info");
        else pi.sendMessage({ customType, content, display: true });
    };

    const statusLine = (managed: ManagedServer): string => {
        const { entry, server, problem } = managed;
        const details = problem ?? server?.error;
        let state = "unsupported";
        if (!isEnabled(entry.config)) state = "disabled";
        else if (server !== undefined) state = server.state;

        if (state === "dormant" && details !== undefined) state = "failed";

        const tools = server?.catalog?.tools.length;
        let count = "";
        if (tools !== undefined) count = `, ${tools} tools`;

        let suffix = "";
        if (details !== undefined) suffix = `\n    ${details.split("\n").join("\n    ")}`;

        return `${entry.name}: ${state}${count} (${exposureOf(entry.config)})${suffix}`;
    };

    pi.registerCommand("mcp", {
        description:
            "Lazy MCP status; /mcp discover NAME fetches and saves one server's tool catalog",
        async handler(args, ctx) {
            if (failure !== undefined) throw new Error(failure);

            const words = args.trim().split(/\s+/);
            if (words[0] === "discover" && words.length === 2) {
                const version = generation;
                await assertOwnership(ctx, version);

                const name = words[1] ?? "";
                const managed = servers.get(name);
                if (managed === undefined) throw new Error(`No MCP server named "${name}"`);

                if (managed.server === undefined)
                    throw new Error(
                        `MCP server "${name}" ${managed.problem ?? "is disabled in mcp.json"}`,
                    );

                const catalog = await managed.server.discover();

                await assertOwnership(ctx, version);
                managed.problem = undefined;
                saveServerCatalog(managed, catalog, ctx);
                ensureDiscoveryActive(ctx);
                showMessage(
                    ctx,
                    "lazy-mcp-catalog",
                    `${name}: saved a catalog of ${catalog.tools.length} tools`,
                );

                return;
            }

            if (args.trim() !== "") throw new Error("Use /mcp or /mcp discover NAME");

            const lines = [...servers.values()].map(statusLine);
            for (const error of configErrors) lines.push(`config error: ${error}`);

            for (const { name, extensionPath } of pi.getMcpServers())
                lines.push(`${name}: registered by ${extensionPath}; ignored`);

            let status = lines.join("\n");
            if (status === "")
                status = `No MCP servers configured. Add them to ${join(getAgentDir(), "mcp.json")} or ${join(CONFIG_DIR_NAME, "mcp.json")}.`;

            showMessage(ctx, "lazy-mcp-status", status);
        },
    });
}
