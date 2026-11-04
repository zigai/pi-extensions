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

import type { Catalog } from "../src/catalog.ts";
import type { McpServerConfig, McpServerEntry } from "../src/config.ts";
import { LazyServer } from "../src/server.ts";

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
const noCatalogChange = (): void => undefined;
const noReport = (): void => undefined;

function entryOf(config: McpServerConfig): McpServerEntry {
    return { name: "sample", config, source: "mcp.json", scope: "global" };
}

function currentCatalog(server: LazyServer): Catalog {
    const current = server.catalog;
    if (current === undefined) throw new Error("Missing catalog");

    return current;
}

afterEach(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    cleanup.length = 0;
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

type FixtureState = {
    capabilities?: ServerCapabilities & { tasks?: JsonObject };
    gate?: boolean;
    closeGate?: boolean;
    stdoutBanner?: string;
    startupStderr?: string;
    exitOnStart?: number;
    firstListDelayMs?: number;
};

async function fixture(
    options: FixtureState & {
        idleAfterMs?: number;
        timeout?: number;
        env?: Record<string, string>;
        savedCatalog?: Catalog | null;
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
            stdoutBanner: options.stdoutBanner,
            startupStderr: options.startupStderr,
            exitOnStart: options.exitOnStart,
            firstListDelayMs: options.firstListDelayMs,
        }),
    );
    const config: McpServerConfig = {
        command: process.execPath,
        args: [fileURLToPath(new URL("./server-fixture.ts", import.meta.url)), statePath, logPath],
        exposure: "direct",
    };
    if (options.env !== undefined) config.env = options.env;
    if (options.timeout !== undefined) config.timeout = options.timeout;

    let saved: Catalog | undefined = catalog;

    if (options.savedCatalog === null) saved = undefined;
    else if (options.savedCatalog !== undefined) saved = options.savedCatalog;

    const server = new LazyServer({
        entry: entryOf(config),
        root: directory,
        catalog: saved,
        idleAfterMs: options.idleAfterMs,
        changed: options.changed ?? noCatalogChange,
        report: options.report ?? noReport,
    });
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
    it("keeps the connection through malformed stdout and fails the call with its cause", async () => {
        const notices: string[] = [];
        const { server, logs } = await fixture({
            report: (message) => {
                notices.push(message);
            },
        });
        const failure = server.call(catalog, "run", { mode: "invalid" }, { timeoutMs: 200 });
        await expect(failure).rejects.toThrow("timed out");
        await expect(failure).rejects.not.toThrow("sample-private-payload");
        expect(notices).toEqual([]);

        expect(server.state).toBe("connected");
        await server.call(catalog, "run", {});
        expect((await logs()).filter((entry) => entry.event === "start")).toHaveLength(1);
    });

    it("works with a server that prints a banner on stdout before speaking the protocol", async () => {
        const { server } = await fixture({ stdoutBanner: "sample server ready" });
        await expect(server.call(catalog, "run", {})).resolves.toMatchObject({
            content: [{ type: "text", text: "completed" }],
        });
    });

    it("reconnects after a crash, reporting the crash and its stderr on the failed call", async () => {
        const { server, logs } = await fixture();
        const failure = server.call(catalog, "run", { mode: "crash" });
        await expect(failure).rejects.toThrow("execution may not have completed");
        await expect(failure).rejects.toThrow("sample crash detail");

        await vi.waitFor(() => expect(server.state).toBe("dormant"));
        expect(server.error).toContain("sample crash detail");

        await server.call(catalog, "run", {});
        expect(server.error).toBeUndefined();
        expect((await logs()).filter((entry) => entry.event === "start")).toHaveLength(2);
    });

    it("names the missing command when the server cannot start", async () => {
        const server = new LazyServer({
            entry: entryOf({ command: "pi-lazy-mcp-sample-missing-command" }),
            root: process.cwd(),
            catalog: undefined,
            idleAfterMs: undefined,
            changed: noCatalogChange,
            report: noReport,
        });
        cleanup.push(async () => server.dispose());

        const failure = server.discover();
        await expect(failure).rejects.toThrow('MCP server "sample" failed to connect');
        await expect(failure).rejects.toThrow("pi-lazy-mcp-sample-missing-command ENOENT");
        expect(server.error).toContain("ENOENT");
    });

    it("includes the stderr tail when the server exits during startup", async () => {
        const { server } = await fixture({
            savedCatalog: null,
            startupStderr: "sample startup detail",
            exitOnStart: 7,
        });
        await expect(server.discover()).rejects.toThrow("sample startup detail");
    });

    it("hides configured values that a failing server echoes on stderr", async () => {
        vi.stubEnv("SAMPLE_SECRET", "sample-secret-value");
        const { server } = await fixture({
            savedCatalog: null,
            startupStderr: "bad token sample-secret-value",
            exitOnStart: 7,
            env: { TOKEN: "Bearer ${SAMPLE_SECRET}" },
        });
        const failure = server.discover();
        await expect(failure).rejects.toThrow("bad token [redacted]");
        await expect(failure).rejects.not.toThrow("sample-secret-value");
    });

    it("gives a stdio server the inherited environment plus its resolved env", async () => {
        vi.stubEnv("SAMPLE_INHERITED", "inherited-value");
        vi.stubEnv("SAMPLE_SOURCE", "source-value");
        const { server } = await fixture({
            env: { SAMPLE_CONFIGURED: "prefix-${SAMPLE_SOURCE}" },
        });
        const read = async (variable: string) =>
            server.call(catalog, "run", { mode: "environment", variable });

        expect((await read("SAMPLE_INHERITED")).content).toEqual([
            { type: "text", text: "inherited-value" },
        ]);

        expect((await read("SAMPLE_CONFIGURED")).content).toEqual([
            { type: "text", text: "prefix-source-value" },
        ]);
    });

    it("fails only this server, naming the variable, when its env cannot be resolved", async () => {
        vi.stubEnv("SAMPLE_UNSET", undefined);
        const { server, logs } = await fixture({
            savedCatalog: null,
            env: { TOKEN: "${SAMPLE_UNSET}" },
        });
        await expect(server.discover()).rejects.toThrow(
            'Failed to resolve MCP server "sample" env "TOKEN" from environment variable: SAMPLE_UNSET',
        );
        expect(await logs()).toEqual([]);
    });

    it("resolves env again on reconnect instead of pinning the first value", async () => {
        vi.stubEnv("SAMPLE_ACCOUNT", "account-a");
        const { server } = await fixture({
            idleAfterMs: 1,
            env: { SAMPLE_CONFIGURED: "${SAMPLE_ACCOUNT}" },
        });
        const read = async () =>
            server.call(catalog, "run", { mode: "environment", variable: "SAMPLE_CONFIGURED" });
        expect((await read()).content).toEqual([{ type: "text", text: "account-a" }]);
        await vi.waitFor(() => expect(server.state).toBe("dormant"));
        vi.stubEnv("SAMPLE_ACCOUNT", "account-b");
        expect((await read()).content).toEqual([{ type: "text", text: "account-b" }]);
    });

    it("applies the configured timeout to tool calls", async () => {
        const { server } = await fixture({ timeout: 0.1 });
        await expect(server.call(catalog, "run", { mode: "hold" })).rejects.toThrow(
            "timed out after 100ms",
        );
    });

    it("stops a server it started for discovery, and leaves one a call started running", async () => {
        const { server, logs } = await fixture({ savedCatalog: null });
        expect(server.catalog).toBeUndefined();

        await expect(server.discover()).resolves.toEqual(catalog);
        expect(server.state).toBe("dormant");
        const pid = (await logs())[0]?.pid;
        if (pid === undefined) throw new Error("Missing child PID");

        expect(() => process.kill(pid, 0)).toThrow();

        await server.call(catalog, "run", {});
        await server.discover();
        expect(server.state).toBe("connected");
    });

    it("keeps a connection a call used, even when the call finishes before discovery", async () => {
        const { server, logs } = await fixture({ firstListDelayMs: 200 });
        const discovery = server.discover();
        await server.call(catalog, "run", {});
        await discovery;
        expect(server.state).toBe("connected");
        expect((await logs()).filter((entry) => entry.event === "start")).toHaveLength(1);
    });

    it("publishes a changed catalog when the server announces one", async () => {
        const published: Catalog[] = [];
        const { server } = await fixture({
            changed: (next) => {
                published.push(next);
            },
        });
        await server.call(catalog, "run", { mode: "announce" });

        await vi.waitFor(() =>
            expect(published.at(-1)?.tools.map((tool) => tool.name)).toEqual(["run", "added"]),
        );
    });

    it("does not ask a server without the tools capability for its tools", async () => {
        const { server, logs } = await fixture({
            savedCatalog: null,
            capabilities: { resources: {} },
        });
        await expect(server.discover()).resolves.toEqual({ tools: [] });
        expect((await logs()).filter((entry) => entry.event === "list")).toEqual([]);
    });

    it.each(["tools/list", "tools/call"])(
        "retries once on a new session after HTTP session expiry in %s",
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
            const server = new LazyServer({
                entry: entryOf({
                    url: `http://127.0.0.1:${address.port}/mcp`,
                    exposure: "direct",
                }),
                root: process.cwd(),
                catalog,
                idleAfterMs: undefined,
                changed: noCatalogChange,
                report: noReport,
            });
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
            expired = true;
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
        await server.call(currentCatalog(server), "run", {});
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
        const { server, logs } = await fixture({ idleAfterMs: 10 });
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
            (await server.call(currentCatalog(server), "run", {})).structuredContent,
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
        const { server } = await fixture({ idleAfterMs: 10, capabilities });
        await server.call(catalog, "run", {});
        await vi.advanceTimersByTimeAsync(100);
        expect(server.state).toBe("connected");
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
        const server = new LazyServer({
            entry: entryOf({ url, exposure: "direct" }),
            root: process.cwd(),
            catalog,
            idleAfterMs: undefined,
            changed: noCatalogChange,
            report: noReport,
        });
        cleanup.push(async () => server.dispose());
        await server.call(catalog, "run", {});
        await server.dispose();
        expect(disconnected).toBe(true);
        expect(await (await fetch(`${url}/health`)).text()).toBe("alive");
    });

    it("cancels one startup waiter without closing a sibling's lifecycle", async () => {
        const { server, logs } = await fixture({ gate: true, idleAfterMs: 10 });
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

    describe("over HTTP", () => {
        async function httpServer(
            respond: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
        ): Promise<string> {
            const external = createServer((request, response) => {
                void respond(request, response);
            });
            external.listen(0, "127.0.0.1");
            await once(external, "listening");
            cleanup.push(async () => {
                external.closeAllConnections();
                external.close();
                await once(external, "close");
            });
            const { port } = Value.Parse(Type.Object({ port: Type.Integer() }), external.address());
            return `http://127.0.0.1:${port}/mcp`;
        }

        const lazyServer = (config: McpServerConfig) => {
            const server = new LazyServer({
                entry: entryOf(config),
                root: process.cwd(),
                catalog: undefined,
                idleAfterMs: undefined,
                changed: noCatalogChange,
                report: noReport,
            });
            cleanup.push(async () => server.dispose());

            return server;
        };

        it("says sign-in is unsupported when a server answers 401, without retrying", async () => {
            let requests = 0;
            const url = await httpServer((_request, response) => {
                requests += 1;
                response.statusCode = 401;
                response.end();
            });
            await expect(lazyServer({ url }).discover()).rejects.toThrow(
                "requires sign-in, which pi-lazy-mcp does not support",
            );
            expect(requests).toBe(1);
        });

        it("retries a connection refused by a restarting server, then names the status", async () => {
            let requests = 0;
            const url = await httpServer((_request, response) => {
                requests += 1;
                response.statusCode = 503;
                response.end();
            });
            await expect(lazyServer({ url }).discover()).rejects.toThrow("503");
            expect(requests).toBe(3);
        });

        it("sends expanded headers and keeps their values out of errors", async () => {
            vi.stubEnv("SAMPLE_HTTP_TOKEN", "sample-http-token");
            let authorization: string | undefined;
            const url = await httpServer((request, response) => {
                authorization = request.headers.authorization;
                response.statusCode = 400;
                response.end("rejected sample-http-token");
            });
            const failure = lazyServer({
                url,
                headers: { Authorization: "Bearer ${SAMPLE_HTTP_TOKEN}" },
            }).discover();
            await expect(failure).rejects.toThrow("failed to connect");
            await expect(failure).rejects.not.toThrow("sample-http-token");
            expect(authorization).toBe("Bearer sample-http-token");
        });

        it("names the variable when a header cannot be resolved", async () => {
            vi.stubEnv("SAMPLE_HTTP_UNSET", undefined);
            const url = await httpServer((_request, response) => {
                response.end();
            });
            await expect(
                lazyServer({ url, headers: { Authorization: "${SAMPLE_HTTP_UNSET}" } }).discover(),
            ).rejects.toThrow(
                'header "Authorization" from environment variable: SAMPLE_HTTP_UNSET',
            );
        });
    });
});
