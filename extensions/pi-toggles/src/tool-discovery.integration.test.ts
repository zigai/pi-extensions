import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createAgentSession,
    createToolSearchExtension,
    DefaultResourceLoader,
    type ExtensionAPI,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import extension from "./index.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createDiscoverySession(enabled = true) {
    const root = await mkdtemp(join(tmpdir(), "pi-toggles-discovery-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    cleanups.push(async () => {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    });
    await mkdir(cwd, { recursive: true });
    await mkdir(join(agentDir, "extension-settings"), { recursive: true });
    await writeFile(
        join(agentDir, "extension-settings", "pi-toggles.json"),
        JSON.stringify({
            enabled,
            overrides: [
                {
                    target: { kind: "tool", source: "inline", name: "catalog_disabled" },
                    state: "off",
                },
                { target: { kind: "tool", source: "inline", name: "catalog_lazy" }, state: "lazy" },
                { target: { kind: "tool", source: "inline", name: "catalog_hidden" }, state: "on" },
                {
                    target: { kind: "tool", source: "inline", name: "catalog_late_disabled" },
                    state: "off",
                },
            ],
        }),
    );
    let api: ExtensionAPI | undefined;
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: SettingsManager.inMemory(),
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
            {
                name: "tool-search",
                factory: createToolSearchExtension(),
                builtin: true,
                replaceable: true,
            },
            { name: "toggles", factory: extension },
            {
                name: "discovery-probes",
                factory(pi) {
                    api = pi;
                    for (const [name, exposure] of [
                        ["catalog_callable", "codemode"],
                        ["catalog_deferred", "deferred"],
                        ["catalog_disabled", "codemode"],
                        ["catalog_lazy", "deferred"],
                        ["catalog_hidden", "hidden"],
                    ] as const) {
                        pi.registerTool({
                            name,
                            label: name,
                            description: `Catalog probe ${name}`,
                            parameters: Type.Object({}),
                            exposure,
                            async execute() {
                                return {
                                    content: [{ type: "text", text: "executed" }],
                                    details: undefined,
                                };
                            },
                        });
                    }
                    pi.registerTool({
                        name: "invoke_probe",
                        label: "Invoke probe",
                        description: "Invoke a nested probe",
                        parameters: Type.Object({ name: Type.String() }),
                        async execute(_id, params, _signal, _update, ctx) {
                            const outcome = await ctx.executeTool(params.name, {});
                            return { content: outcome.result.content, details: outcome };
                        },
                    });
                    pi.on("session_start", () =>
                        pi.setActiveTools([...pi.getActiveTools(), "tool_search"]),
                    );
                },
            },
        ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory(),
    });
    cleanups.push(async () => session.dispose());
    await session.bindExtensions({ mode: "print" });
    session.agent.state.messages = [
        {
            role: "assistant",
            content: [{ type: "toolCall", id: "outer", name: "invoke_probe", arguments: {} }],
            api: "openai-responses",
            provider: "openai",
            model: "probe",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
        },
    ];
    if (api === undefined) throw new Error("Probe API unavailable");
    return { session, api };
}

function activeTool(
    session: Awaited<ReturnType<typeof createDiscoverySession>>["session"],
    name: string,
) {
    const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`Expected active tool ${name}`);
    return tool;
}

describe("policy-aware native discovery", () => {
    it("applies policy to tools registered after session activation", async () => {
        const { session, api } = await createDiscoverySession();
        for (const name of ["catalog_late_allowed", "catalog_late_disabled"]) {
            api.registerTool({
                name,
                label: name,
                description: `Late catalog probe ${name}`,
                exposure: "deferred",
                parameters: Type.Object({}),
                async execute() {
                    return { content: [{ type: "text", text: "executed" }], details: undefined };
                },
            });
        }
        const result = await activeTool(session, "tool_search").execute("search-late", {
            query: "late",
        });

        expect(result.details).toEqual({ loaded: ["catalog_late_allowed"] });
        expect(api.getActiveTools()).toContain("catalog_late_allowed");
        expect(api.getActiveTools()).not.toContain("catalog_late_disabled");
    });
    it("does not redeclare disabled or hidden tools and authorizes native lazy activation", async () => {
        const { session, api } = await createDiscoverySession();
        const search = activeTool(session, "tool_search");
        const result = await search.execute("search-probe", { query: "catalog", limit: 20 });

        expect(result.details).toEqual({
            loaded: ["catalog_callable", "catalog_deferred", "catalog_lazy"],
        });
        expect(api.getActiveTools()).not.toContain("catalog_disabled");
        expect(api.getActiveTools()).not.toContain("catalog_hidden");
        const nested = await activeTool(session, "invoke_probe").execute("outer", {
            name: "catalog_lazy",
        });
        expect(nested.details).toMatchObject({
            isError: false,
            result: { content: [{ type: "text", text: "executed" }] },
        });
        await session.prompt("/toggles list tool");
        expect(api.getActiveTools()).toContain("catalog_lazy");
    });

    it.each([
        ["catalog_disabled", "inactive"],
        ["catalog_lazy", "lazy"],
    ])("rejects nested %s calls before discovery", async (name, state) => {
        const { session } = await createDiscoverySession();
        const result = await activeTool(session, "invoke_probe").execute("outer", { name });

        expect(result.details).toMatchObject({ isError: true });
        expect(result.content).toEqual([
            {
                type: "text",
                text: `Pi Toggles blocked ${name}: effective state is ${state}. Use /toggles explain ${name}.`,
            },
        ]);
    });

    it("leaves native discovery unrestricted when policy is disabled", async () => {
        const { session, api } = await createDiscoverySession(false);
        const result = await activeTool(session, "tool_search").execute("search-probe", {
            query: "catalog_disabled",
        });

        expect(result.details).toEqual({
            loaded: ["catalog_disabled", "catalog_callable", "catalog_deferred", "catalog_lazy"],
        });
        expect(api.getActiveTools()).toContain("catalog_disabled");
    });

    it("does not offer hidden tools to lazy capability search", async () => {
        const { session, api } = await createDiscoverySession();
        await session.prompt("/toggles set catalog_hidden lazy --scope session");
        const result = await activeTool(session, "search_capabilities").execute("search-hidden", {
            query: "hidden",
        });

        expect(result.details).toEqual({ matches: [], added: [] });
        expect(api.getActiveTools()).not.toContain("catalog_hidden");
    });
});
