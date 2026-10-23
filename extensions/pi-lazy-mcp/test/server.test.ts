import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
    McpAbortError,
    type ServerCapabilities,
    type InitializeResult,
    type CallToolResult,
} from "@earendil-works/pi-mcp";
import type { JsonObject } from "../src/json.ts";
import type { AddressInfo } from "node:net";

import { LazyServer } from "../src/server.ts";
import type { Catalog, Server } from "../src/settings-input.ts";

const catalog: Catalog = {
    tools: [
        {
            name: "run",
            description: "Run a sample operation",
            inputSchema: { type: "object", properties: { mode: { type: "string" } } },
            outputSchema: {
                type: "object",
                properties: { count: { type: "integer" }, pid: { type: "integer" } },
            },
            annotations: { readOnlyHint: true },
        },
    ],
};
const resultSchema = Type.Object({ count: Type.Integer(), pid: Type.Integer() });
const logSchema = Type.Array(
    Type.Object({
        event: Type.String(),
        pid: Type.Optional(Type.Integer()),
        name: Type.Optional(Type.String()),
    }),
);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    cleanup.length = 0;
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

async function fixture(
    options: {
        idle?: { afterMs: number };
        capabilities?: ServerCapabilities & { tasks?: JsonObject };
        gate?: boolean;
        closeGate?: boolean;
        transportEnv?: Record<string, string>;
        changed?: (catalog: Catalog) => void;
        report?: (message: string) => void;
    } = {},
) {
    const parent = fileURLToPath(
        new URL("../../../node_modules/.cache/pi-lazy-mcp", import.meta.url),
    );
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "server-"));
    const statePath = join(directory, "state.json");
    const logPath = join(directory, "events.jsonl");
    await writeFile(logPath, "");
    await writeFile(
        statePath,
        JSON.stringify({
            ...catalog,
            capabilities: options.capabilities,
            gate: options.gate,
            closeGate: options.closeGate,
        }),
    );
    const config: Server = {
        name: "sample",
        description: "Sample operations",
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
            env: options.transportEnv ?? {},
        },
    };
    if (options.idle !== undefined) config.idle = options.idle;

    const server = new LazyServer(
        config,
        directory,
        options.changed ?? (() => undefined),
        options.report ?? (() => undefined),
    );
    cleanup.push(async () => {
        await server.dispose();
        await rm(directory, { recursive: true });
    });
    const logs = async () =>
        Value.Parse(
            logSchema,
            (await readFile(logPath, "utf8"))
                .trim()
                .split("\n")
                .filter((line) => line !== "")
                .map((line) => Value.Parse(logSchema.items, JSON.parse(line))),
        );

    return { server, statePath, logs };
}

describe("demand-owned MCP lifecycle", () => {
    it("reports malformed stdio responses safely and disconnects the failed connection", async () => {
        const notices: string[] = [];
        const { server } = await fixture({
            report: (message) => {
                notices.push(message);
            },
        });
        await expect(
            server.call(catalog, "run", { mode: "invalid" }, { timeoutMs: 1000 }),
        ).rejects.toThrow("call failed");
        expect(notices).toEqual([
            "MCP server sample transport or protocol failed; connection closed",
        ]);

        expect(server.state).not.toBe("connected");
        await server.call(catalog, "run", {});
        expect(server.state).toBe("connected");
        expect(notices.join("\n")).not.toContain("sample-private-payload");
    });

    it.each(["tools/list", "tools/call"])(
        "reconnects only the next operation after HTTP session expiry in %s",
        async (expirationMethod) => {
            const requestSchema = Type.Object({
                id: Type.Optional(Type.Integer()),
                method: Type.String(),
            });
            let initialized = 0;
            let expired = false;
            let invalidated = false;
            let calls = 0;
            const requestErrors: unknown[] = [];
            const pending: Promise<void>[] = [];
            const handle = async (
                request: IncomingMessage,
                response: ServerResponse,
            ): Promise<void> => {
                if (request.method === "GET" || request.method === "DELETE") {
                    response.statusCode = 204;
                    if (request.method === "GET") response.statusCode = 405;
                    response.end();

                    return;
                }

                let body = "";
                for await (const chunk of request) body += String(chunk);
                const message = Value.Parse(requestSchema, JSON.parse(body));
                if (message.method === "notifications/initialized") {
                    response.statusCode = 202;
                    response.end();
                    return;
                }

                if (
                    expired &&
                    request.headers["mcp-session-id"] === "session-1" &&
                    (invalidated || message.method === expirationMethod)
                ) {
                    invalidated = true;
                    response.statusCode = 404;
                    response.end();
                    return;
                }

                let result: InitializeResult | Catalog | CallToolResult;
                if (message.method === "initialize") {
                    initialized += 1;
                    response.setHeader("mcp-session-id", `session-${initialized}`);
                    result = {
                        protocolVersion: "2025-11-25",
                        capabilities: { tools: {} },
                        serverInfo: { name: "sample", version: "1" },
                    };
                } else if (message.method === "tools/list") result = catalog;
                else {
                    calls += 1;
                    result = { content: [{ type: "text", text: "completed" }] };
                }

                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
            };

            const http = createServer((request, response) => {
                const operation = handle(request, response).catch((cause: unknown) => {
                    requestErrors.push(cause);
                    response.statusCode = 500;
                    response.end();
                });
                pending.push(operation);
            });
            http.listen(0, "127.0.0.1");
            await once(http, "listening");
            const address = Value.Parse(
                Type.Object({
                    address: Type.String(),
                    family: Type.String(),
                    port: Type.Integer(),
                }),
                http.address(),
            );
            const server = new LazyServer(
                {
                    name: "sample",
                    description: "Sample operations",
                    exposure: "direct",
                    catalog,
                    transport: {
                        type: "http",
                        url: `http://127.0.0.1:${address.port}/mcp`,
                        headers: {},
                    },
                },
                process.cwd(),
                () => undefined,
                () => undefined,
            );
            cleanup.push(async () => {
                await server.dispose();
                http.closeAllConnections();
                await new Promise<void>((resolve, reject) => {
                    http.close((cause) => {
                        if (cause !== undefined) reject(cause);
                        else resolve();
                    });
                });
                await Promise.all(pending);
                expect(requestErrors).toEqual([]);
            });
            await server.discover();
            expired = true;
            await expect(server.call(catalog, "run", {})).rejects.toThrow("call failed");
            expect(calls).toBe(0);
            await expect(server.call(catalog, "run", {})).resolves.toEqual({
                content: [{ type: "text", text: "completed" }],
            });
            expect(initialized).toBe(2);
            expect(calls).toBe(1);
        },
    );

    it("keeps the accepted catalog when publishing a discovery is rejected", async () => {
        let publish = false;
        const { server, statePath } = await fixture({
            changed: () => {
                if (!publish) throw new Error("Catalog publication rejected");
            },
        });
        const next = { instructions: "Use the updated workflow", tools: catalog.tools };
        await writeFile(statePath, JSON.stringify(next));

        await expect(server.discover()).rejects.toThrow("catalog discovery failed");
        expect(server.catalog).toEqual(catalog);

        publish = true;
        await expect(server.discover()).resolves.toEqual(next);
        expect(server.catalog).toEqual(next);
    });

    it("rejects discovery when its owner disposes during catalog publication", async () => {
        let disposal: Promise<void> | undefined;
        const { server, statePath } = await fixture({
            changed: () => {
                disposal = server.dispose();
            },
        });
        await writeFile(
            statePath,
            JSON.stringify({ instructions: "New workflow", tools: catalog.tools }),
        );

        await expect(server.discover()).rejects.toBeInstanceOf(McpAbortError);
        await disposal;
        expect(server.state).toBe("closed");
        expect(server.catalog).toEqual(catalog);
    });

    it("advertises metadata without starting and shares concurrent first calls", async () => {
        const { server, logs } = await fixture();
        expect(server.catalog).toEqual(catalog);
        expect(await logs()).toEqual([]);
        const results = await Promise.all([
            server.call(catalog, "run", {}),
            server.call(catalog, "run", {}),
        ]);
        const first = Value.Parse(resultSchema, results[0].structuredContent);
        const second = Value.Parse(resultSchema, results[1].structuredContent);
        expect(first.pid).toBe(second.pid);
        expect([first.count, second.count].sort((left, right) => left - right)).toEqual([1, 2]);
        expect((await logs()).filter((entry) => entry.event === "start")).toHaveLength(1);
    });

    it.each([
        { inputSchema: { type: "object", properties: { value: { type: "number" } } } },
        { outputSchema: { type: "object", properties: { different: { type: "boolean" } } } },
        { annotations: { destructiveHint: true } },
    ])("rejects a changed signature or permission hint before invoking: %j", async (change) => {
        const { server, statePath, logs } = await fixture();
        await writeFile(statePath, JSON.stringify({ tools: [{ ...catalog.tools[0], ...change }] }));
        await expect(server.call(catalog, "run", {})).rejects.toThrow("MCP catalog is stale");
        expect((await logs()).filter((entry) => entry.event === "call")).toEqual([]);
        await server.call(server.catalog, "run", {});
        expect((await logs()).filter((entry) => entry.event === "call")).toHaveLength(1);
    });

    it("withdraws a missing tool and refreshes server instructions before execution", async () => {
        const { server, statePath, logs } = await fixture();
        await writeFile(
            statePath,
            JSON.stringify({ instructions: "Use the new workflow", tools: [] }),
        );
        await expect(server.call(catalog, "run", {})).rejects.toThrow("MCP catalog is stale");
        expect(server.catalog).toEqual({ instructions: "Use the new workflow", tools: [] });
        expect((await logs()).filter((entry) => entry.event === "call")).toEqual([]);
    });

    it("keeps active calls resident, then unloads and initializes the next call", async () => {
        vi.useFakeTimers();
        const { server, logs } = await fixture({ idle: { afterMs: 10 } });
        const held = server.call(catalog, "run", { mode: "hold" });
        await vi.waitFor(async () =>
            expect((await logs()).filter((entry) => entry.event === "call")).toHaveLength(1),
        );
        await vi.advanceTimersByTimeAsync(100);
        expect(server.state).toBe("connected");
        const released = Value.Parse(
            resultSchema,
            (await server.call(catalog, "run", { mode: "release" })).structuredContent,
        );
        await held;
        await vi.advanceTimersByTimeAsync(10);
        await vi.waitFor(() => expect(server.state).toBe("dormant"));
        expect(() => process.kill(released.pid, 0)).toThrow();
        const restarted = Value.Parse(
            resultSchema,
            (await server.call(server.catalog, "run", {})).structuredContent,
        );
        expect(restarted.pid).not.toBe(released.pid);
        expect(restarted.count).toBe(1);
    });

    it.each([
        { tools: {}, resources: { subscribe: true } },
        { tools: {}, tasks: {} },
        { tools: {}, experimental: { residency: {} } },
    ])("does not evict residency capabilities: %j", async (capabilities) => {
        vi.useFakeTimers();
        const { server } = await fixture({ idle: { afterMs: 10 }, capabilities });
        await server.call(catalog, "run", {});
        await vi.advanceTimersByTimeAsync(100);
        expect(server.state).toBe("connected");
    });

    it("rejects credential identity changes rather than reusing another account", async () => {
        vi.stubEnv("SAMPLE_ACCOUNT", "account-a");
        const { server, logs } = await fixture({ transportEnv: { ACCOUNT: "SAMPLE_ACCOUNT" } });
        await server.call(catalog, "run", {});
        vi.stubEnv("SAMPLE_ACCOUNT", "account-b");
        await expect(server.call(catalog, "run", {})).rejects.toThrow("reload required");
        expect((await logs()).filter((entry) => entry.event === "call")).toHaveLength(1);
    });

    it("disconnects HTTP without terminating an external server", async () => {
        let disconnected = false;

        const requestSchema = Type.Object({
            id: Type.Optional(Type.Integer()),
            method: Type.String(),
        });
        const pending: Promise<void>[] = [];
        let requestFailure: Error | undefined;
        const handle = async (
            request: IncomingMessage,
            response: ServerResponse,
        ): Promise<void> => {
            if (request.method === "GET") {
                if (request.url === "/health") response.end("alive");
                else {
                    response.statusCode = 405;
                    response.end();
                }

                return;
            }

            if (request.method === "DELETE") {
                disconnected = true;
                response.end();
                return;
            }

            let text = "";
            for await (const chunk of request) text += String(chunk);
            const message = Value.Parse(requestSchema, JSON.parse(text));
            if (message.id === undefined) {
                response.statusCode = 202;
                response.end();
                return;
            }

            response.setHeader("content-type", "application/json");
            response.setHeader("mcp-session-id", "sample-session");
            let result: InitializeResult | Catalog | CallToolResult = { content: [] };
            if (message.method === "initialize")
                result = {
                    protocolVersion: "2025-11-25",
                    capabilities: { tools: {} },
                    serverInfo: { name: "sample", version: "1" },
                };
            else if (message.method === "tools/list") result = catalog;
            else if (message.method === "tools/call")
                result = { content: [{ type: "text", text: "completed" }] };

            response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        };

        const external = createServer((request, response) => {
            pending.push(
                handle(request, response).catch((cause: unknown) => {
                    response.destroy();

                    if (cause instanceof Error) requestFailure = cause;
                    else requestFailure = new Error("Synthetic HTTP request failed");
                }),
            );
        });
        external.listen(0, "127.0.0.1");
        await once(external, "listening");
        cleanup.push(async () => {
            external.closeAllConnections();
            external.close();
            await once(external, "close");
            await Promise.all(pending);

            if (requestFailure !== undefined) throw requestFailure;
        });
        const address = external.address();
        const addressSchema = Type.Object({
            address: Type.String(),
            family: Type.String(),
            port: Type.Integer(),
        });
        const parsedAddress: AddressInfo = Value.Parse(addressSchema, address);

        const url = `http://127.0.0.1:${parsedAddress.port}`;
        const server = new LazyServer(
            {
                name: "sample",
                description: "Sample",
                exposure: "direct",
                catalog,
                transport: { type: "http", url, headers: {} },
            },
            process.cwd(),
            () => undefined,
            () => undefined,
        );
        cleanup.push(async () => server.dispose());
        await server.call(catalog, "run", {});
        await server.dispose();
        expect(disconnected).toBe(true);
        expect(await (await fetch(`${url}/health`)).text()).toBe("alive");
    });

    it("cancels one startup waiter without closing a sibling's lifecycle", async () => {
        const { server, logs } = await fixture({ gate: true, idle: { afterMs: 10 } });
        const controller = new AbortController();
        const first = server.call(catalog, "run", {}, { signal: controller.signal });
        const rejected = expect(first).rejects.toBeInstanceOf(McpAbortError);
        const second = server.discover().catch(() => "closed");
        await vi.waitFor(async () =>
            expect((await logs()).filter((entry) => entry.event === "start")).toHaveLength(1),
        );
        controller.abort();
        await rejected;
        expect(server.state).toBe("connecting");
        await server.dispose();
        expect(await second).toBe("closed");
        expect((await logs()).filter((entry) => entry.event === "start")).toHaveLength(1);
    });

    it.each([false, true])(
        "closes a startup still awaiting initialize, including resistant children (%s)",
        async (closeGate) => {
            const { server, logs } = await fixture({ gate: true, closeGate });
            const discovery = server.discover();
            const outcome = discovery.catch(() => "closed");
            await vi.waitFor(async () =>
                expect((await logs()).filter((entry) => entry.event === "start")).toHaveLength(1),
            );
            await server.dispose();
            expect(await outcome).toBe("closed");
            expect(server.state).toBe("closed");
            await expect(server.discover()).rejects.toThrow();
            const pid = (await logs())[0]?.pid;
            expect(pid).toBeDefined();

            if (pid === undefined) throw new Error("Missing child PID");

            expect(() => process.kill(pid, 0)).toThrow();
        },
    );
});
