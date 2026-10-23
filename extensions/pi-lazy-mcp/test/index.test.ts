import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { getPiGlobalSettingsPath } from "@zigai/pi-extension-settings/pi";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

import extension from "../src/index.ts";
import { LazyServer } from "../src/server.ts";
import type { Catalog, Server } from "../src/settings-input.ts";

const logSchema = Type.Array(
    Type.Object({
        event: Type.String(),
        pid: Type.Optional(Type.Integer()),
        name: Type.Optional(Type.String()),
    }),
);

async function serverFixture(directory: string, name: string, tool: string) {
    const statePath = join(directory, `${name}-state.json`);
    const logPath = join(directory, `${name}-events.jsonl`);
    const catalog: Catalog = {
        tools: [{ name: tool, inputSchema: { type: "object", properties: {} } }],
    };
    await writeFile(statePath, JSON.stringify(catalog));
    await writeFile(logPath, "");
    const config: Server = {
        name,
        description: `Server ${name}`,
        exposure: "direct",
        catalog,
        transport: {
            type: "stdio",
            command: process.execPath,
            args: [
                fileURLToPath(new URL("./server-fixture.ts", import.meta.url)),
                statePath,
                logPath,
            ],
            cwd: ".",
            env: {},
        },
    };
    const logs = async () =>
        Value.Parse(
            logSchema,
            (await readFile(logPath, "utf8"))
                .split("\n")
                .filter((line) => line !== "")
                .map((line) => Value.Parse(logSchema.items, JSON.parse(line))),
        );

    return { config, logs, statePath };
}

async function withHost(
    directory: string,
    servers: Server[],
    run: (session: AgentSession, errors: readonly string[]) => Promise<void>,
): Promise<void> {
    const agentDir = join(directory, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    await mkdir(join(agentDir, "extension-settings"), { recursive: true });
    await writeFile(getPiGlobalSettingsPath("pi-lazy-mcp"), JSON.stringify({ servers }));
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
        extensionFactories: [extension],
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

describe("lazy MCP host composition", () => {
    it.each([true, false])(
        "restores a withdrawn direct tool's activation intent: active=%s",
        async (initiallyActive) => {
            const parent = fileURLToPath(
                new URL("../../../node_modules/.cache/pi-lazy-mcp", import.meta.url),
            );
            await mkdir(parent, { recursive: true });
            const directory = await mkdtemp(join(parent, "activation-"));
            try {
                const fixture = await serverFixture(directory, "sample", "run");
                await withHost(directory, [fixture.config], async (session, errors) => {
                    const name = "mcp__sample__run";
                    expect(session.getActiveToolNames()).toContain(name);

                    if (!initiallyActive)
                        session.setActiveToolsByName(
                            session.getActiveToolNames().filter((tool) => tool !== name),
                        );

                    await writeFile(fixture.statePath, JSON.stringify({ tools: [] }));
                    await session.prompt("/mcp discover sample");
                    expect(session.getActiveToolNames()).not.toContain(name);
                    await writeFile(fixture.statePath, JSON.stringify(fixture.config.catalog));
                    await session.prompt("/mcp discover sample");
                    expect(session.getActiveToolNames().includes(name)).toBe(initiallyActive);
                    expect(errors).toEqual([]);
                });
            } finally {
                vi.unstubAllEnvs();
                await rm(directory, { recursive: true, force: true });
            }
        },
    );

    it("rejects a completed tool result after the session trust decision changes", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pi-lazy-mcp-host-"));
        try {
            const fixture = await serverFixture(directory, "sample", "run");
            await withHost(directory, [fixture.config], async (session, errors) => {
                expect(errors).toEqual([]);
                const tool = session.agent.state.tools.find(
                    (candidate) => candidate.name === "mcp__sample__run",
                );
                assert.ok(tool, "the dormant catalog must register its tool");
                const trusted = session.settingsManager.isProjectTrusted();
                const call = vi
                    .spyOn(LazyServer.prototype, "call")
                    .mockImplementationOnce(async () => {
                        session.settingsManager.setProjectTrusted(!trusted);
                        return { content: [{ type: "text", text: "completed" }] };
                    });
                try {
                    await expect(tool.execute("trust-change", {})).rejects.toThrow(
                        "MCP catalog belongs to another root, trust decision, or session",
                    );
                    expect(call).toHaveBeenCalledTimes(1);
                    expect(await fixture.logs()).toEqual([]);
                } finally {
                    call.mockRestore();
                }
            });
        } finally {
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("does not reroute an owned tool when discovery introduces a flattened-name collision", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pi-lazy-mcp-host-"));
        try {
            const discovering = await serverFixture(directory, "a", "b__c");
            const owner = await serverFixture(directory, "a__b", "c");
            discovering.config.catalog = { tools: [] };
            await withHost(
                directory,
                [discovering.config, owner.config],
                async (session, errors) => {
                    expect(errors).toEqual([]);
                    expect(await discovering.logs()).toEqual([]);
                    expect(await owner.logs()).toEqual([]);

                    const name = "mcp__a__b__c";
                    const original = session.agent.state.tools.find((tool) => tool.name === name);
                    assert.ok(original, "the supplied owner catalog must register its tool");
                    await original.execute("before-discovery", {});
                    expect((await owner.logs()).filter((entry) => entry.event === "call")).toEqual([
                        { event: "call", name: "c" },
                    ]);

                    await session.prompt("/mcp discover a");

                    for (const error of errors) expect(error).toMatch(/ownership conflict/i);
                    expect(
                        (await discovering.logs()).filter((entry) => entry.event === "start"),
                    ).toHaveLength(1);
                    const current = session.agent.state.tools.find((tool) => tool.name === name);
                    assert.ok(current, "discovery must preserve the existing owner's route");
                    await current.execute("after-discovery", {});

                    expect(
                        (await discovering.logs()).filter((entry) => entry.event === "call"),
                    ).toEqual([]);

                    expect((await owner.logs()).filter((entry) => entry.event === "call")).toEqual([
                        { event: "call", name: "c" },
                        { event: "call", name: "c" },
                    ]);
                },
            );
        } finally {
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
