import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type AgentSession,
    type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogKey, readCatalogs, saveCatalog, type Catalog } from "../src/catalog.ts";
import type { McpServerConfig, StdioServerConfig } from "../src/config.ts";
import extension from "../src/index.ts";
import type { JsonObject } from "../src/json.ts";
import { LazyServer } from "../src/server.ts";

const logSchema = Type.Array(
    Type.Object({
        event: Type.String(),
        pid: Type.Optional(Type.Integer()),
        name: Type.Optional(Type.String()),
    }),
);

const directories: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();

    for (const directory of directories.splice(0))
        await rm(directory, { recursive: true, force: true });
});

async function hostDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pi-lazy-mcp-host-"));
    directories.push(directory);
    return directory;
}

const emptyObject = { type: "object", properties: {} };

function catalogOf(...tools: string[]): Catalog {
    return { tools: tools.map((name) => ({ name, inputSchema: emptyObject })) };
}

type FixtureOptions = {
    config?: Partial<StdioServerConfig>;
    state?: JsonObject;
};

async function serverFixture(
    directory: string,
    name: string,
    catalog: Catalog,
    options: FixtureOptions = {},
) {
    const statePath = join(directory, `${name}-state.json`);
    const logPath = join(directory, `${name}-events.jsonl`);
    await writeFile(statePath, JSON.stringify({ ...catalog, ...options.state }));
    await writeFile(logPath, "");
    const config: StdioServerConfig = {
        command: process.execPath,
        args: [fileURLToPath(new URL("./server-fixture.ts", import.meta.url)), statePath, logPath],
        exposure: "direct",
        ...options.config,
    };
    const logs = async () =>
        Value.Parse(
            logSchema,
            (await readFile(logPath, "utf8"))
                .split("\n")
                .filter((line) => line !== "")
                .map((line) => Value.Parse(logSchema.items, JSON.parse(line))),
        );

    const started = async () => (await logs()).filter((entry) => entry.event === "start");
    const calls = async () => (await logs()).filter((entry) => entry.event === "call");
    return { name, config, catalog, statePath, logs, started, calls };
}

type Fixture = Awaited<ReturnType<typeof serverFixture>>;

type HostOptions = {
    servers?: readonly Fixture[];
    extraServers?: Record<string, McpServerConfig>;
    saved?: readonly Fixture[];
    autoEnableCodemode?: boolean;
    extensionFactories?: ExtensionFactory[];
    settings?: JsonObject;
};

function catalogsFile(directory: string): string {
    return join(directory, "agent", "lazy-mcp-catalogs.json");
}

async function prepareAgentDir(directory: string, options: HostOptions): Promise<string> {
    const agentDir = join(directory, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    await mkdir(join(agentDir, "extension-settings"), { recursive: true });

    const mcpServers = {
        ...options.extraServers,
        ...Object.fromEntries(
            (options.servers ?? []).map((server) => [server.name, server.config]),
        ),
    };
    await writeFile(
        join(agentDir, "mcp.json"),
        JSON.stringify({ mcpServers, autoEnableCodemode: options.autoEnableCodemode }),
    );

    if (options.settings !== undefined)
        await writeFile(
            join(agentDir, "extension-settings", "pi-lazy-mcp.json"),
            JSON.stringify(options.settings),
        );

    for (const server of options.saved ?? [])
        saveCatalog(
            catalogsFile(directory),
            catalogKey(server.name, server.config),
            server.catalog,
        );

    return agentDir;
}

async function withHost(
    directory: string,
    options: HostOptions,
    run: (session: AgentSession, errors: readonly string[]) => Promise<void>,
): Promise<void> {
    const agentDir = await prepareAgentDir(directory, options);
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [extension, ...(options.extensionFactories ?? [])],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
    });
    const { session } = await createAgentSession({
        cwd: directory,
        agentDir,
        modelRuntime,
        resourceLoader: loader,
        settingsManager,
        sessionManager: SessionManager.inMemory(directory),
        noTools: "builtin",
    });
    try {
        const errors: string[] = [];
        await session.bindExtensions({
            onError: (error) => {
                errors.push(error.error);
            },
        });
        await run(session, errors);
    } finally {
        try {
            await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
            session.dispose();
        }
    }
}

function statusText(session: AgentSession): string {
    return session.messages
        .flatMap((message) => {
            if (message.role !== "custom" || message.customType !== "lazy-mcp-status") return [];
            if (Array.isArray(message.content)) return [];

            return [message.content];
        })
        .join("\n");
}

const processGone = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return false;
    } catch {
        return true;
    }
};

describe("lazy MCP sessions", () => {
    it("starts no server at session start when catalogs are saved, and only the called one on use", async () => {
        const directory = await hostDirectory();
        const first = await serverFixture(directory, "first", catalogOf("run"));
        const second = await serverFixture(directory, "second", catalogOf("run"));
        const servers = [first, second];
        await withHost(directory, { servers, saved: servers }, async (session, errors) => {
            expect(errors).toEqual([]);
            expect(await first.started()).toEqual([]);
            expect(await second.started()).toEqual([]);

            const tool = session.agent.state.tools.find(
                (candidate) => candidate.name === "mcp__first__run",
            );
            assert.ok(tool, "the saved catalog must register its tool");
            const result = await tool.execute("call", {});
            expect(result.content).toEqual([{ type: "text", text: "completed" }]);
            expect(await first.started()).toHaveLength(1);
            expect(await second.started()).toEqual([]);
        });
    });

    it.each([false, true])(
        "keeps eager servers connected before tool use (saved: %s)",
        async (saved) => {
            const directory = await hostDirectory();
            const fixture = await serverFixture(directory, "sample", catalogOf("run"));
            let pid = 0;
            await withHost(
                directory,
                {
                    servers: [fixture],
                    saved: [fixture].filter(() => saved),
                    settings: { eager: ["sample"], idle: { sample: 1 } },
                },
                async (session, errors) => {
                    await vi.waitFor(async () => {
                        expect(await fixture.started()).toHaveLength(1);
                        expect(
                            readCatalogs(catalogsFile(directory)).get(
                                catalogKey("sample", fixture.config),
                            ),
                        ).toEqual(fixture.catalog);

                        expect(session.getAllTools().map((tool) => tool.name)).toContain(
                            "mcp__sample__run",
                        );
                    });
                    pid = (await fixture.started())[0]?.pid ?? 0;
                    await delay(50);
                    expect(processGone(pid)).toBe(false);
                    expect(await fixture.calls()).toEqual([]);
                    expect(errors).toEqual([]);
                },
            );
            await vi.waitFor(() => expect(processGone(pid)).toBe(true));
        },
    );

    it("discovers a server without a saved catalog once, saves it, registers it, and stops it", async () => {
        const directory = await hostDirectory();
        const fixture = await serverFixture(directory, "sample", catalogOf("run"));
        await withHost(directory, { servers: [fixture] }, async (session, errors) => {
            const key = catalogKey("sample", fixture.config);
            await vi.waitFor(() => {
                expect(readCatalogs(catalogsFile(directory)).get(key)).toEqual(fixture.catalog);
                expect(session.getAllTools().map((tool) => tool.name)).toContain(
                    "mcp__sample__run",
                );
            });
            const started = await fixture.started();
            expect(started).toHaveLength(1);
            await vi.waitFor(() => expect(processGone(started[0]?.pid ?? 0)).toBe(true));
            expect(errors).toEqual([]);
        });

        await withHost(directory, { servers: [fixture] }, async (session) => {
            expect(session.getAllTools().map((tool) => tool.name)).toContain("mcp__sample__run");
            expect(await fixture.started()).toHaveLength(1);
        });
    });

    it("treats a corrupt catalog file as missing and repairs it", async () => {
        const directory = await hostDirectory();
        const fixture = await serverFixture(directory, "sample", catalogOf("run"));
        await mkdir(join(directory, "agent"), { recursive: true });
        await writeFile(catalogsFile(directory), "{ corrupt");
        await withHost(directory, { servers: [fixture] }, async () => {
            await vi.waitFor(() =>
                expect(
                    readCatalogs(catalogsFile(directory)).get(catalogKey("sample", fixture.config)),
                ).toEqual(fixture.catalog),
            );
        });
    });

    it("discovers again under a new key when the command changes", async () => {
        const directory = await hostDirectory();
        const fixture = await serverFixture(directory, "sample", catalogOf("run"));
        const moved = {
            ...fixture,
            config: { ...fixture.config, args: ["--no-warnings", ...(fixture.config.args ?? [])] },
        };
        await withHost(directory, { servers: [moved], saved: [fixture] }, async () => {
            await vi.waitFor(async () => expect(await fixture.started()).toHaveLength(1));
            await vi.waitFor(() =>
                expect(
                    readCatalogs(catalogsFile(directory)).has(catalogKey("sample", moved.config)),
                ).toBe(true),
            );
        });
    });

    it("saves the new catalog when a call finds the saved one stale, and the retry succeeds", async () => {
        const directory = await hostDirectory();
        const fixture = await serverFixture(directory, "sample", catalogOf("run"));
        const current: Catalog = {
            tools: [
                {
                    name: "run",
                    inputSchema: { type: "object", properties: { added: { type: "string" } } },
                },
            ],
        };
        await writeFile(fixture.statePath, JSON.stringify(current));
        await withHost(directory, { servers: [fixture], saved: [fixture] }, async (session) => {
            const stale = session.agent.state.tools.find(
                (tool) => tool.name === "mcp__sample__run",
            );
            assert.ok(stale);
            await expect(stale.execute("stale", {})).rejects.toThrow("MCP catalog is stale");
            expect(await fixture.calls()).toEqual([]);
            expect(
                readCatalogs(catalogsFile(directory)).get(catalogKey("sample", fixture.config)),
            ).toEqual(current);

            const refreshed = session.agent.state.tools.find(
                (tool) => tool.name === "mcp__sample__run",
            );
            assert.ok(refreshed);
            await refreshed.execute("retry", {});
            expect(await fixture.calls()).toHaveLength(1);
        });
    });

    it("saves on /mcp discover and stops the server it started", async () => {
        const directory = await hostDirectory();
        const fixture = await serverFixture(directory, "sample", catalogOf("run"));
        await mkdir(join(directory, "agent"), { recursive: true });
        await withHost(
            directory,
            { servers: [fixture], saved: [fixture] },
            async (session, errors) => {
                await rm(catalogsFile(directory));
                await session.prompt("/mcp discover sample");
                expect(errors).toEqual([]);
                expect(
                    readCatalogs(catalogsFile(directory)).get(catalogKey("sample", fixture.config)),
                ).toEqual(fixture.catalog);

                const started = await fixture.started();
                expect(started).toHaveLength(1);
                expect(processGone(started[0]?.pid ?? 0)).toBe(true);
            },
        );
    });

    it.each([true, false])(
        "restores a withdrawn direct tool's activation intent: active=%s",
        async (initiallyActive) => {
            const directory = await hostDirectory();
            const fixture = await serverFixture(directory, "sample", catalogOf("run"));
            await withHost(
                directory,
                { servers: [fixture], saved: [fixture] },
                async (session, errors) => {
                    const name = "mcp__sample__run";
                    expect(session.getActiveToolNames()).toContain(name);

                    if (!initiallyActive)
                        session.setActiveToolsByName(
                            session.getActiveToolNames().filter((tool) => tool !== name),
                        );

                    await writeFile(fixture.statePath, JSON.stringify({ tools: [] }));
                    await session.prompt("/mcp discover sample");
                    expect(session.getActiveToolNames()).not.toContain(name);
                    await writeFile(fixture.statePath, JSON.stringify(fixture.catalog));
                    await session.prompt("/mcp discover sample");
                    expect(session.getActiveToolNames().includes(name)).toBe(initiallyActive);
                    expect(errors).toEqual([]);
                },
            );
        },
    );

    it("rejects a completed tool result after the session trust decision changes", async () => {
        const directory = await hostDirectory();
        const fixture = await serverFixture(directory, "sample", catalogOf("run"));
        await withHost(
            directory,
            { servers: [fixture], saved: [fixture] },
            async (session, errors) => {
                expect(errors).toEqual([]);
                const tool = session.agent.state.tools.find(
                    (candidate) => candidate.name === "mcp__sample__run",
                );
                assert.ok(tool, "the saved catalog must register its tool");
                const trusted = session.settingsManager.isProjectTrusted();
                const call = vi
                    .spyOn(LazyServer.prototype, "call")
                    .mockImplementationOnce(async () => {
                        session.settingsManager.setProjectTrusted(!trusted);
                        return { content: [{ type: "text", text: "completed" }] };
                    });
                await expect(tool.execute("trust-change", {})).rejects.toThrow(
                    "MCP catalog belongs to another root, trust decision, or session",
                );
                expect(call).toHaveBeenCalledTimes(1);
                expect(await fixture.logs()).toEqual([]);
            },
        );
    });

    it("keeps an owned tool's route when another server's name flattens onto it", async () => {
        const directory = await hostDirectory();
        const owner = await serverFixture(directory, "a__b", catalogOf("c"));
        const discovering = await serverFixture(directory, "a", catalogOf("b__c"));
        await withHost(
            directory,
            { servers: [owner, discovering], saved: [owner] },
            async (session, errors) => {
                await vi.waitFor(() =>
                    expect(
                        session
                            .getAllTools()
                            .filter((tool) => tool.name.startsWith("mcp__a__b__c")),
                    ).toHaveLength(2),
                );
                expect(errors).toEqual([]);

                const owned = session.agent.state.tools.find(
                    (tool) => tool.name === "mcp__a__b__c",
                );
                assert.ok(owned);
                await owned.execute("owned", {});
                expect(await owner.calls()).toEqual([{ event: "call", name: "c" }]);
                expect(await discovering.calls()).toEqual([]);

                const suffixed = session.agent.state.tools.find(
                    (tool) => tool.name.startsWith("mcp__a__b__c_") && tool.name !== "mcp__a__b__c",
                );
                assert.ok(suffixed);
                await suffixed.execute("suffixed", {});
                expect(await discovering.calls()).toEqual([{ event: "call", name: "b__c" }]);
            },
        );
    });
});

describe("per-server failures", () => {
    it("reports each failing server and keeps the others working", async () => {
        const directory = await hostDirectory();
        vi.stubEnv("SAMPLE_UNSET", undefined);
        const healthy = await serverFixture(directory, "healthy", catalogOf("run"));
        const missingCommand = await serverFixture(directory, "missing-command", catalogOf("run"), {
            config: { command: "pi-lazy-mcp-sample-missing-command", args: [] },
        });
        const missingVariable = await serverFixture(
            directory,
            "missing-variable",
            catalogOf("run"),
            {
                config: { env: { TOKEN: "${SAMPLE_UNSET}" } },
            },
        );
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        await withHost(
            directory,
            {
                servers: [healthy, missingCommand, missingVariable],
                extraServers: {
                    "uses-oauth": { url: "https://example.invalid/mcp", oauth: { clientId: "x" } },
                    "uses-auth": {
                        url: "https://example.invalid/mcp",
                        auth: { provider: "sample" },
                    },
                    invalid: { command: "tool", timeout: -1 },
                    disabled: { command: "tool", enabled: false },
                },
            },
            async (session, errors) => {
                await vi.waitFor(() =>
                    expect(session.getAllTools().map((tool) => tool.name)).toContain(
                        "mcp__healthy__run",
                    ),
                );
                await vi.waitFor(() =>
                    expect(stderr.mock.calls.flat().join("")).toContain(
                        "MCP servers need attention",
                    ),
                );
                expect(errors).toEqual([]);

                const report = stderr.mock.calls.flat().join("");
                expect(report).toContain("pi-lazy-mcp-sample-missing-command ENOENT");
                expect(report).toContain("environment variable: SAMPLE_UNSET");
                expect(report).toContain("uses-oauth: uses auth or oauth");
                expect(report).toContain("uses-auth: uses auth or oauth");
                expect(report).toContain('server "invalid"');
                expect(report).not.toContain("healthy");

                await session.prompt("/mcp");
                const status = statusText(session);
                expect(status).toContain("disabled: disabled");
                expect(status).toContain("uses-oauth: unsupported");
                expect(status).toContain("healthy: dormant, 1 tools (direct)");
                expect(status).toContain("ENOENT");
                expect(status).toContain('server "invalid"');
                expect(errors).toEqual([]);
            },
        );
    });

    it("does not let an extension-registered server break the session", async () => {
        const directory = await hostDirectory();
        const fixture = await serverFixture(directory, "sample", catalogOf("run"));
        const registering: ExtensionFactory = (pi) => {
            pi.registerMcpServer("registered", { command: "pi-lazy-mcp-sample-registered" });
            pi.registerCommand("sample-register", {
                handler: async () => {
                    pi.registerMcpServer("late", { command: "pi-lazy-mcp-sample-late" });
                },
            });
        };
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        await withHost(
            directory,
            {
                servers: [fixture],
                saved: [fixture],
                extensionFactories: [registering],
            },
            async (session, errors) => {
                expect(errors).toEqual([]);
                await session.prompt("/sample-register");
                expect(errors).toEqual([]);

                const tool = session.agent.state.tools.find(
                    (candidate) => candidate.name === "mcp__sample__run",
                );
                assert.ok(tool);
                await tool.execute("after-registration", {});

                await session.prompt("/mcp");
                expect(statusText(session)).toContain("registered: registered by");
                expect(statusText(session)).toContain("late: registered by");
            },
        );
    });

    it("keeps working with invalid settings", async () => {
        const directory = await hostDirectory();
        const fixture = await serverFixture(directory, "sample", catalogOf("run"));
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        await withHost(
            directory,
            { servers: [fixture], saved: [fixture], settings: { idle: { sample: "soon" } } },
            async (session, errors) => {
                expect(errors).toEqual([]);
                expect(stderr.mock.calls.flat().join("")).toContain("pi-lazy-mcp");
                expect(session.getAllTools().map((tool) => tool.name)).toContain(
                    "mcp__sample__run",
                );
            },
        );
    });

    it("stops a server after the idle time configured for it", async () => {
        const directory = await hostDirectory();
        const fixture = await serverFixture(directory, "sample", catalogOf("run"));
        await withHost(
            directory,
            { servers: [fixture], saved: [fixture], settings: { idle: { sample: 1 } } },
            async (session) => {
                const tool = session.agent.state.tools.find(
                    (candidate) => candidate.name === "mcp__sample__run",
                );
                assert.ok(tool);
                await tool.execute("call", {});
                const pid = (await fixture.started())[0]?.pid ?? 0;
                await vi.waitFor(() => expect(processGone(pid)).toBe(true));
            },
        );
    });
});

describe("what the model sees", () => {
    const reachingTool =
        (name: string): ExtensionFactory =>
        (pi) => {
            pi.registerTool({
                name,
                label: name,
                description: name,
                parameters: Type.Object({}),
                defaultActive: false,
                reachesTools: () => "all",
                execute: async () => ({ content: [], details: {} }),
            });
        };

    it("names and groups tools like Pi's built-in MCP", async () => {
        const directory = await hostDirectory();
        const catalog: Catalog = {
            instructions: "Use the sample workflow",
            tools: [
                { name: "run-it", inputSchema: {}, description: " Runs it \n" },
                {
                    name: "titled",
                    title: "Titled tool",
                    inputSchema: {},
                    annotations: { readOnlyHint: true, unknownHint: true, title: "ignored" },
                },
                { name: "get_secret", inputSchema: { properties: { key: { type: "string" } } } },
                { name: "pinned", inputSchema: {} },
            ],
        };
        const fixture = await serverFixture(directory, "sample-server", catalog, {
            config: {
                exposure: "codemode",
                description: "Sample operations",
                toolExposure: { pinned: "direct", "get_*": "hidden" },
            },
        });
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        await withHost(directory, { servers: [fixture], saved: [fixture] }, async (session) => {
            const tools = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
            expect(tools.get("mcp__sample_server__run_it")?.exposure).toBe("deferred");
            expect(tools.get("mcp__sample_server__run_it")?.description).toBe("Runs it");
            expect(tools.get("mcp__sample_server__titled")?.description).toBe("Titled tool");
            expect(tools.get("mcp__sample_server__titled")?.annotations).toEqual({
                readOnlyHint: true,
            });

            expect(tools.get("mcp__sample_server__get_secret")?.exposure).toBe("hidden");
            expect(tools.get("mcp__sample_server__pinned")?.exposure).toBe("direct");
            expect(tools.get("mcp__sample_server__get_secret")?.parameters).toMatchObject({
                type: "object",
                properties: { key: { type: "string" } },
            });

            expect(tools.get("mcp__sample_server__pinned")?.namespace).toEqual({
                name: "mcp__sample_server",
                aliases: ["sample-server"],
                description: "Sample operations",
                instructions: "Use the sample workflow",
            });

            expect(session.getActiveToolNames()).toContain("mcp__sample_server__pinned");
            expect(session.getActiveToolNames()).not.toContain("mcp__sample_server__run_it");
        });
    });

    it.each([
        { exposure: "codemode", autoEnableCodemode: undefined, active: ["codemode"] },
        { exposure: "codemode", autoEnableCodemode: true, active: ["codemode"] },
        { exposure: "codemode", autoEnableCodemode: false, active: [] },
        { exposure: "deferred", autoEnableCodemode: undefined, active: ["tool_search"] },
        { exposure: "deferred", autoEnableCodemode: false, active: ["tool_search"] },
        { exposure: "direct", autoEnableCodemode: undefined, active: [] },
        { exposure: "hidden", autoEnableCodemode: undefined, active: [] },
    ] as const)(
        "activates $active for $exposure with autoEnableCodemode=$autoEnableCodemode",
        async ({ exposure, autoEnableCodemode, active }) => {
            const directory = await hostDirectory();
            const fixture = await serverFixture(directory, "sample", catalogOf("run"), {
                config: { exposure },
            });
            vi.spyOn(process.stderr, "write").mockImplementation(() => true);
            const options: HostOptions = {
                servers: [fixture],
                saved: [fixture],
                extensionFactories: [reachingTool("codemode"), reachingTool("tool_search")],
            };
            if (autoEnableCodemode !== undefined) options.autoEnableCodemode = autoEnableCodemode;

            await withHost(directory, options, async (session) => {
                const reaching = session
                    .getActiveToolNames()
                    .filter((name) => name === "codemode" || name === "tool_search");
                expect(reaching).toEqual(active);
            });
        },
    );

    it("warns when no reaching tool is available instead of failing", async () => {
        const directory = await hostDirectory();
        const fixture = await serverFixture(directory, "sample", catalogOf("run"), {
            config: { exposure: "codemode" },
        });
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        await withHost(directory, { servers: [fixture], saved: [fixture] }, async () => {
            expect(stderr.mock.calls.flat().join("")).toContain("they cannot be called");
        });
    });

    it("lists servers in the system prompt without starting them", async () => {
        const directory = await hostDirectory();
        const described = await serverFixture(directory, "described", catalogOf("run"), {
            config: { exposure: "codemode", description: "Described operations" },
        });
        const instructed = await serverFixture(
            directory,
            "instructed-one",
            {
                instructions: "First line of instructions\nSecond line",
                tools: catalogOf("run").tools,
            },
            { config: { exposure: "deferred" } },
        );
        const direct = await serverFixture(directory, "direct", catalogOf("run"));
        const servers = [described, instructed, direct];
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        await withHost(
            directory,
            {
                servers,
                saved: servers,
                extraServers: {
                    off: { command: "tool", enabled: false },
                    "uses-oauth": { url: "https://example.invalid/mcp", oauth: {} },
                },
            },
            async (session) => {
                const { systemPromptOptions } = await session.extensionRunner.emitBeforeAgentStart(
                    { messageType: "user", prompt: "sample" },
                    { cwd: directory },
                );
                expect(systemPromptOptions.sections.mcp_servers).toBe(
                    [
                        "MCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts. Load the tools of `tool_search` servers with `tool_search`.",
                        "- mcp__described (codemode): Described operations",
                        "- mcp__instructed_one (tool_search): First line of instructions",
                    ].join("\n"),
                );

                for (const server of servers) expect(await server.started()).toEqual([]);
            },
        );
    });

    it("makes a reaching tool call wait for a discovery still running", async () => {
        const directory = await hostDirectory();
        const slow = await serverFixture(directory, "slow", catalogOf("run"), {
            config: { exposure: "codemode" },
            state: { initializeDelayMs: 200 },
        });
        await withHost(
            directory,
            {
                servers: [slow],
                extensionFactories: [reachingTool("codemode")],
            },
            async (session) => {
                expect(session.getAllTools().map((tool) => tool.name)).not.toContain(
                    "mcp__slow__run",
                );

                await session.extensionRunner.emitToolCall({
                    type: "tool_call",
                    toolCallId: "call",
                    toolName: "codemode",
                    input: {},
                });

                expect(session.getAllTools().map((tool) => tool.name)).toContain("mcp__slow__run");
            },
        );
    });

    it("makes the first prompt wait for a direct server's discovery", async () => {
        const directory = await hostDirectory();
        const slow = await serverFixture(directory, "slow", catalogOf("run"), {
            state: { initializeDelayMs: 200 },
        });
        await withHost(directory, { servers: [slow] }, async (session) => {
            expect(session.getActiveToolNames()).not.toContain("mcp__slow__run");

            await session.extensionRunner.emitBeforeAgentStart(
                { messageType: "user", prompt: "sample" },
                { cwd: directory },
            );

            expect(session.getActiveToolNames()).toContain("mcp__slow__run");
        });
    });
});
