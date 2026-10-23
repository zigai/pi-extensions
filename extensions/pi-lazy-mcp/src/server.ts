import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
    McpAbortError,
    McpSessionExpiredError,
    McpClient,
    StdioTransport,
    StreamableHttpTransport,
    type CallToolResult,
    type McpRequestOptions,
    type StdioTransportOptions,
} from "@earendil-works/pi-mcp";
import { Value } from "typebox/value";

import { catalogSchema, type Catalog, type Server } from "./settings-input.ts";
import type { JsonObject } from "./json.ts";

export function toolName(server: string, name: string): string {
    const prefix = `mcp__${server}__`;
    const safe = name.replace(/[^A-Za-z0-9_]/g, "_");
    if (safe === name && prefix.length + safe.length <= 64) {
        return prefix + safe;
    }

    const hash = createHash("sha256").update(name).digest("hex").slice(0, 12);
    return `${prefix}${safe.slice(0, 64 - prefix.length - 13)}_${hash}`;
}

export function checkCatalog(catalog: Catalog): void {
    const names = new Set<string>();
    for (const tool of catalog.tools) {
        if (
            names.has(tool.name) ||
            tool.inputSchema.type !== "object" ||
            (tool.outputSchema !== undefined && tool.outputSchema.type !== "object")
        ) {
            throw new Error("MCP catalog has duplicate names or a non-object tool schema");
        }

        names.add(tool.name);
    }
}

function credentials(server: Server): NonNullable<StdioTransportOptions["env"]> {
    let bindings: Record<string, string>;
    if (server.transport.type === "http") {
        bindings = server.transport.headers;
    } else {
        bindings = server.transport.env;
    }

    const values: Record<string, string> = {};
    for (const [destination, source] of Object.entries(bindings)) {
        const value = process.env[source];
        if (value === undefined) {
            throw new Error(`MCP server ${server.name} requires a credential/environment binding`);
        }

        values[destination] = value;
    }

    return values;
}

export class CatalogConflict extends Error {}

class CatalogChanged extends Error {}

class ReloadRequired extends Error {}

class TaskUnsupported extends Error {}

export class LazyServer {
    private catalogValue: Catalog;
    private client: McpClient | undefined;
    private opening: Promise<McpClient> | undefined;
    private closing: Promise<void> | undefined;
    private disposal: Promise<void> | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly shutdown = new AbortController();
    private inflight = 0;
    private residency = false;
    private credentialIdentity: string | undefined;

    constructor(
        readonly config: Server,
        readonly root: string,
        private readonly changed: (catalog: Catalog) => void,
        private readonly report: (message: string) => void,
    ) {
        checkCatalog(config.catalog);
        this.catalogValue = structuredClone(config.catalog);
    }

    get catalog(): Catalog {
        return structuredClone(this.catalogValue);
    }

    get state(): string {
        if (this.shutdown.signal.aborted) return "closed";
        if (this.opening !== undefined) return "connecting";
        if (this.closing !== undefined) return "disconnecting";
        if (this.client?.connectionState === "connected") return "connected";
        return "dormant";
    }

    async discover(options: McpRequestOptions = {}): Promise<Catalog> {
        this.begin();

        let client: McpClient | undefined;
        try {
            client = await this.waitForClient(options);
            options.signal?.throwIfAborted();
            return await this.refresh(client, options);
        } catch (cause) {
            if (cause instanceof McpSessionExpiredError && client !== undefined) {
                this.disconnect(client);
                await this.closing;
            }

            if (cause instanceof CatalogConflict) throw cause;

            if (options.signal?.aborted === true || this.shutdown.signal.aborted)
                throw new McpAbortError();

            throw new Error(`MCP server ${this.config.name} catalog discovery failed`);
        } finally {
            this.end();
        }
    }

    async call(
        expected: Catalog,
        name: string,
        args: JsonObject,
        options: McpRequestOptions = {},
    ): Promise<CallToolResult> {
        this.begin();

        let client: McpClient | undefined;

        try {
            options.signal?.throwIfAborted();
            client = await this.waitForClient(options);
            options.signal?.throwIfAborted();
            const current = await this.refresh(client, options);
            const tool = current.tools.find((candidate) => candidate.name === name);
            const previous = expected.tools.find((candidate) => candidate.name === name);
            if (
                tool === undefined ||
                !isDeepStrictEqual(tool, previous) ||
                current.instructions !== expected.instructions
            ) {
                throw new CatalogChanged(
                    `MCP catalog is stale for ${this.config.name}/${name}; definitions refreshed, retry with the current signature and permission policy`,
                );
            }

            if (tool.execution?.taskSupport === "required") {
                throw new TaskUnsupported(
                    "This MCP tool requires task support unavailable in the client",
                );
            }

            try {
                const result = await client.callTool(name, args, this.requestOptions(options));
                this.shutdown.signal.throwIfAborted();
                options.signal?.throwIfAborted();
                return result;
            } catch (cause) {
                this.residency = true;
                throw cause;
            }
        } catch (cause) {
            if (cause instanceof McpSessionExpiredError && client !== undefined) {
                this.disconnect(client);
                await this.closing;
            }

            if (
                cause instanceof CatalogChanged ||
                cause instanceof CatalogConflict ||
                cause instanceof ReloadRequired ||
                cause instanceof TaskUnsupported
            )
                throw cause;

            if (options.signal?.aborted === true || this.shutdown.signal.aborted)
                throw new McpAbortError();

            throw new Error(
                `MCP server ${this.config.name} call failed; execution may not have completed`,
            );
        } finally {
            this.end();
        }
    }

    async dispose(): Promise<void> {
        this.disposal ??= this.close();
        await this.disposal;
    }

    private async close(): Promise<void> {
        this.shutdown.abort();
        this.clearTimer();

        const client = this.client;
        this.client = undefined;
        await client?.close();

        if (this.opening !== undefined) await Promise.allSettled([this.opening]);
        await this.closing;
    }

    private begin(): void {
        this.shutdown.signal.throwIfAborted();
        this.clearTimer();
        this.inflight += 1;
    }

    private end(): void {
        this.inflight -= 1;
        this.scheduleIdle();
    }

    private scheduleIdle(): void {
        const idle = this.config.idle;
        if (
            this.inflight !== 0 ||
            this.opening !== undefined ||
            this.client === undefined ||
            idle === undefined ||
            this.residency ||
            this.shutdown.signal.aborted
        )
            return;

        this.timer = setTimeout(() => {
            this.timer = undefined;

            if (this.client !== undefined) this.disconnect(this.client);
        }, idle.afterMs);
        this.timer.unref();
    }

    private disconnect(client: McpClient): void {
        if (this.client !== client) return;

        this.clearTimer();
        this.client = undefined;
        this.closing = this.closeConnection(client);
    }

    private async closeConnection(client: McpClient): Promise<void> {
        try {
            await client.close();
        } catch {
            if (this.shutdown.signal.aborted) return;

            this.shutdown.abort();
            this.report(`MCP server ${this.config.name} disconnect failed; reload required`);
        } finally {
            this.closing = undefined;
        }
    }

    private clearTimer(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private async waitForClient(options: McpRequestOptions): Promise<McpClient> {
        const signals = [this.shutdown.signal];
        if (options.signal !== undefined) signals.push(options.signal);

        const signal = AbortSignal.any(signals);
        signal.throwIfAborted();
        const opening = this.getClient();

        return new Promise<McpClient>((resolve, reject) => {
            const aborted = () => reject(new McpAbortError());
            signal.addEventListener("abort", aborted, { once: true });
            opening
                .then(resolve, reject)
                .finally(() => signal.removeEventListener("abort", aborted))
                .catch(reject);
        });
    }

    private async getClient(): Promise<McpClient> {
        await this.closing;
        this.shutdown.signal.throwIfAborted();
        const values = credentials(this.config);
        const identity = createHash("sha256").update(JSON.stringify(values)).digest("hex");
        if (this.credentialIdentity !== undefined && this.credentialIdentity !== identity) {
            throw new ReloadRequired(
                "MCP credential bindings changed; reload required before using another identity",
            );
        }

        this.credentialIdentity = identity;
        if (this.client?.connectionState === "connected") return this.client;

        this.opening ??= this.open(values).finally(() => {
            this.opening = undefined;
            this.scheduleIdle();
        });

        return this.opening;
    }

    private async open(values: Record<string, string>): Promise<McpClient> {
        const client = new McpClient({
            name: "pi-lazy-mcp",
            version: "0.1.0",
            roots: [{ uri: pathToFileURL(this.root).href }],
        });
        this.client = client;
        client.onError((cause) => {
            if (
                cause instanceof McpAbortError ||
                this.shutdown.signal.aborted ||
                this.client !== client
            )
                return;

            this.disconnect(client);
            this.report(
                `MCP server ${this.config.name} transport or protocol failed; connection closed`,
            );
        });

        const transport = this.config.transport;

        try {
            if (transport.type === "stdio") {
                await client.connect(
                    new StdioTransport({
                        command: transport.command,
                        args: transport.args,
                        cwd: resolve(this.root, transport.cwd),
                        env: values,
                        inheritEnv: false,
                        stderr: "pipe",
                    }),
                );
            } else {
                const url = new URL(transport.url);
                if (
                    url.username !== "" ||
                    url.password !== "" ||
                    (url.protocol !== "http:" && url.protocol !== "https:")
                ) {
                    throw new Error("Invalid MCP HTTP endpoint");
                }

                await client.connect(new StreamableHttpTransport({ url, headers: values }));
            }

            this.shutdown.signal.throwIfAborted();
            const capabilities = client.serverCapabilities;

            this.residency =
                capabilities?.resources?.subscribe === true ||
                Object.hasOwn(capabilities ?? {}, "tasks") ||
                Object.keys(capabilities?.experimental ?? {}).length !== 0;

            return client;
        } catch {
            await client.close();

            if (this.client === client) this.client = undefined;
            throw new Error(`MCP server ${this.config.name} initialization failed`);
        }
    }

    private requestOptions(options: McpRequestOptions): McpRequestOptions {
        const signals = [this.shutdown.signal];
        if (options.signal !== undefined) signals.push(options.signal);
        return { ...options, signal: AbortSignal.any(signals) };
    }

    private async refresh(client: McpClient, options: McpRequestOptions): Promise<Catalog> {
        const next = Value.Parse(catalogSchema, {
            instructions: client.instructions,
            tools: await client.listTools(this.requestOptions(options)),
        });

        this.shutdown.signal.throwIfAborted();
        options.signal?.throwIfAborted();
        checkCatalog(next);

        if (
            next.tools.some(
                (tool) =>
                    tool.execution?.taskSupport === "required" ||
                    tool.execution?.taskSupport === "optional",
            )
        )
            this.residency = true;

        if (!isDeepStrictEqual(next, this.catalogValue)) {
            this.changed(structuredClone(next));
            this.shutdown.signal.throwIfAborted();
            options.signal?.throwIfAborted();
            this.catalogValue = next;
        }

        return this.catalog;
    }
}
