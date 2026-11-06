import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
    McpAbortError,
    McpAuthRequiredError,
    McpClient,
    McpError,
    McpHttpError,
    McpSessionExpiredError,
    StdioTransport,
    StreamableHttpTransport,
    type CallToolResult,
    type McpRequestOptions,
} from "@earendil-works/pi-mcp";

import { toCatalog, type Catalog } from "./catalog.ts";
import { resolveConfigValue } from "./config-value.ts";
import type { McpServerEntry } from "./config.ts";
import type { JsonObject } from "./json.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];
const MIN_REDACTED_LENGTH = 4;

class CatalogChanged extends Error {}

class TaskUnsupported extends Error {}

class ConnectionFailed extends Error {}

function errorMessage(cause: unknown): string {
    if (!(cause instanceof Error)) return String(cause);

    // `fetch failed` keeps the reason, such as a refused connection, in its own cause.
    if (cause.cause instanceof Error) return `${cause.message}: ${errorMessage(cause.cause)}`;

    return cause.message;
}

function isTransientError(cause: unknown): boolean {
    if (cause instanceof McpAuthRequiredError) return false;

    if (cause instanceof McpHttpError) {
        return (
            cause.status === 408 ||
            cause.status === 429 ||
            (cause.status >= 500 && cause.status !== 501)
        );
    }

    return cause instanceof TypeError;
}

function expandHome(value: string): string {
    if (value === "~") return homedir();
    if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")))
        return join(homedir(), value.slice(2));

    return value;
}

function redact(text: string, secrets: readonly string[]): string {
    let redacted = text;

    for (const secret of secrets) redacted = redacted.replaceAll(secret, "[redacted]");

    return redacted;
}

function secretsOf(values: readonly string[]): string[] {
    const secrets = new Set<string>();
    for (const value of values) {
        // Words too, so a token is hidden when a server echoes it without its `Bearer` prefix. Shorter
        // values such as `1` carry no secret, and replacing them would shred the message.
        for (const part of [value, ...value.split(/\s+/)]) {
            if (part.length >= MIN_REDACTED_LENGTH) secrets.add(part);
        }
    }

    return [...secrets].sort((left, right) => right.length - left.length);
}

export type LazyServerOptions = {
    entry: McpServerEntry;
    root: string;
    catalog: Catalog | undefined;
    idleAfterMs: number | undefined;
    eager?: boolean;
    changed: (catalog: Catalog) => void;
    report: (message: string) => void;
};

export class LazyServer {
    private catalogValue: Catalog | undefined;
    private client: McpClient | undefined;
    private listedClient: McpClient | undefined;
    private stdio: StdioTransport | undefined;
    private secrets: string[] = [];
    private opening: Promise<McpClient> | undefined;
    private closing: Promise<void> | undefined;
    private disposal: Promise<void> | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly shutdown = new AbortController();
    private inflight = 0;
    private residency = false;
    private calledOnConnection = false;
    private failure: string | undefined;

    constructor(private readonly options: LazyServerOptions) {
        this.catalogValue = options.catalog;
    }

    get name(): string {
        return this.options.entry.name;
    }

    get catalog(): Catalog | undefined {
        return this.catalogValue;
    }

    get state(): string {
        if (this.shutdown.signal.aborted) return "closed";
        if (this.opening !== undefined) return "connecting";
        if (this.closing !== undefined) return "disconnecting";
        if (this.client?.connectionState === "connected") return "connected";
        return "dormant";
    }

    get error(): string | undefined {
        return this.failure;
    }

    private get timeoutMs(): number {
        return (this.options.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    }

    async discover(options: McpRequestOptions = {}): Promise<Catalog> {
        this.begin();

        const wasConnected = this.client?.connectionState === "connected";
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

            if (cause instanceof ConnectionFailed) throw cause;

            if (options.signal?.aborted === true || this.shutdown.signal.aborted)
                throw new McpAbortError();

            throw new Error(
                this.describe(`MCP server "${this.name}" catalog discovery failed`, cause),
            );
        } finally {
            // Discovery leaves the server as it found it, unless a tool call started using the connection.
            if (
                client !== undefined &&
                this.options.eager !== true &&
                !wasConnected &&
                !this.calledOnConnection &&
                this.inflight === 1
            ) {
                this.disconnect(client);
                await this.closing;
            }

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

        try {
            return await this.callOnce(expected, name, args, options);
        } catch (cause) {
            // The server no longer knows the session, so it did not run the request.
            if (!(cause instanceof McpSessionExpiredError)) throw this.callFailure(cause, options);

            try {
                return await this.callOnce(expected, name, args, options);
            } catch (retryCause) {
                throw this.callFailure(retryCause, options);
            }
        } finally {
            this.end();
        }
    }

    async dispose(): Promise<void> {
        this.disposal ??= this.close();
        await this.disposal;
    }

    private async callOnce(
        expected: Catalog,
        name: string,
        args: JsonObject,
        options: McpRequestOptions,
    ): Promise<CallToolResult> {
        let client: McpClient | undefined;

        try {
            options.signal?.throwIfAborted();
            client = await this.waitForClient(options);
            this.calledOnConnection = true;
            options.signal?.throwIfAborted();

            // Once per connection: afterwards the server announces changes, and some tool lists are megabytes.
            let current = this.catalogValue;
            if (current === undefined || this.listedClient !== client)
                current = await this.refresh(client, options);

            const tool = current.tools.find((candidate) => candidate.name === name);
            const previous = expected.tools.find((candidate) => candidate.name === name);
            if (
                tool === undefined ||
                !isDeepStrictEqual(tool, previous) ||
                current.instructions !== expected.instructions
            ) {
                throw new CatalogChanged(
                    `MCP catalog is stale for ${this.name}/${name}; definitions refreshed, retry with the current signature and permission policy`,
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
                if (!(cause instanceof McpSessionExpiredError)) this.residency = true;

                throw cause;
            }
        } catch (cause) {
            if (cause instanceof McpSessionExpiredError && client !== undefined) {
                this.disconnect(client);
                await this.closing;
            }

            throw cause;
        }
    }

    private callFailure(cause: unknown, options: McpRequestOptions): Error {
        if (
            cause instanceof CatalogChanged ||
            cause instanceof TaskUnsupported ||
            cause instanceof ConnectionFailed
        )
            return cause;

        if (options.signal?.aborted === true || this.shutdown.signal.aborted)
            return new McpAbortError();

        return new Error(
            this.describe(
                `MCP server "${this.name}" call failed; execution may not have completed`,
                cause,
            ),
        );
    }

    private describe(summary: string, cause: unknown): string {
        const lines = [`${summary}: ${errorMessage(cause)}`];
        if (!(cause instanceof McpError)) {
            const stderr = this.stderrTail();
            if (stderr !== "") lines.push(stderr);
        }

        return redact(lines.join("\n"), this.secrets);
    }

    private stderrTail(): string {
        return this.stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS) ?? "";
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
        const idleAfterMs = this.options.idleAfterMs;
        if (
            this.inflight !== 0 ||
            this.opening !== undefined ||
            this.client === undefined ||
            idleAfterMs === undefined ||
            this.residency ||
            this.options.eager === true ||
            this.shutdown.signal.aborted
        )
            return;

        this.timer = setTimeout(() => {
            this.timer = undefined;

            if (this.client !== undefined) this.disconnect(this.client);
        }, idleAfterMs);
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
        } catch (cause) {
            if (this.shutdown.signal.aborted) return;

            this.shutdown.abort();
            this.options.report(
                this.describe(
                    `MCP server "${this.name}" disconnect failed; reload required`,
                    cause,
                ),
            );
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
        if (this.client?.connectionState === "connected") return this.client;

        this.opening ??= this.open().finally(() => {
            this.opening = undefined;
            this.scheduleIdle();
        });

        return this.opening;
    }

    private createTransport(): StdioTransport | StreamableHttpTransport {
        const { name, config } = this.options.entry;
        if ("url" in config) {
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(config.headers ?? {}))
                headers[key] = resolveConfigValue(value, `MCP server "${name}" header "${key}"`);

            this.secrets = secretsOf(Object.values(headers));
            return new StreamableHttpTransport({ url: config.url, headers });
        }

        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(config.env ?? {}))
            env[key] = resolveConfigValue(value, `MCP server "${name}" env "${key}"`);

        this.secrets = secretsOf(Object.values(env));

        return new StdioTransport({
            command: expandHome(config.command),
            args: (config.args ?? []).map(expandHome),
            cwd: resolve(this.options.root, expandHome(config.cwd ?? ".")),
            env,
            stderr: "pipe",
        });
    }

    private async open(): Promise<McpClient> {
        let retries: readonly number[] = [];
        if ("url" in this.options.entry.config) retries = CONNECT_RETRY_DELAYS_MS;

        for (let attempt = 0; ; attempt += 1) {
            this.stdio = undefined;

            try {
                this.shutdown.signal.throwIfAborted();
                return await this.connectOnce();
            } catch (cause) {
                const delay = retries[attempt];
                if (this.shutdown.signal.aborted || delay === undefined || !isTransientError(cause))
                    throw this.connectFailed(cause);

                await sleep(delay, undefined, { signal: this.shutdown.signal }).catch(
                    () => undefined,
                );
            }
        }
    }

    private connectFailed(cause: unknown): ConnectionFailed {
        let message = this.describe(`MCP server "${this.name}" failed to connect`, cause);
        if (cause instanceof McpAuthRequiredError)
            message = `MCP server "${this.name}" requires sign-in, which pi-lazy-mcp does not support`;

        this.failure = message;
        return new ConnectionFailed(message);
    }

    private async connectOnce(): Promise<McpClient> {
        const root = this.options.root;
        const client = new McpClient({
            name: "pi-lazy-mcp",
            version: "0.1.0",
            requestTimeoutMs: this.timeoutMs,
            roots: [{ uri: pathToFileURL(root).href, name: basename(root) }],
        });

        this.client = client;

        try {
            const transport = this.createTransport();
            let stdio: StdioTransport | undefined;
            if (transport instanceof StdioTransport) stdio = transport;

            this.stdio = stdio;
            await client.connect(transport);
            this.shutdown.signal.throwIfAborted();
            client.onNotification("notifications/tools/list_changed", () => {
                this.refreshAnnounced(client);
            });
            client.onClose(() => {
                this.handleClose(client, stdio);
            });

            const capabilities = client.serverCapabilities;

            this.residency =
                capabilities?.resources?.subscribe === true ||
                Object.hasOwn(capabilities ?? {}, "tasks") ||
                Object.keys(capabilities?.experimental ?? {}).length !== 0;
            this.calledOnConnection = false;
            this.failure = undefined;
            return client;
        } catch (cause) {
            await client.close().catch(() => undefined);

            if (this.client === client) this.client = undefined;
            throw cause;
        }
    }

    private handleClose(client: McpClient, stdio: StdioTransport | undefined): void {
        if (this.client !== client || this.shutdown.signal.aborted) return;

        this.clearTimer();
        this.client = undefined;

        const lines = ["Connection closed"];
        const stderr = stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS) ?? "";
        if (stderr !== "") lines.push(stderr);

        this.failure = redact(lines.join("\n"), this.secrets);
    }

    private refreshAnnounced(client: McpClient): void {
        this.refresh(client, {}).catch((cause: unknown) => {
            if (this.client !== client || this.shutdown.signal.aborted) return;

            this.options.report(
                this.describe(`MCP server "${this.name}" tool list refresh failed`, cause),
            );
        });
    }

    private requestOptions(options: McpRequestOptions): McpRequestOptions {
        const signals = [this.shutdown.signal];
        if (options.signal !== undefined) signals.push(options.signal);
        return { ...options, signal: AbortSignal.any(signals) };
    }

    private async refresh(client: McpClient, options: McpRequestOptions): Promise<Catalog> {
        // Servers without the tools capability, such as resource-only ones, do not answer tools/list.
        let tools: Awaited<ReturnType<McpClient["listTools"]>> = [];
        if (client.serverCapabilities?.tools !== undefined) {
            const listOptions = { ...options };
            delete listOptions.onProgress;
            tools = await client.listTools(this.requestOptions(listOptions));
        }

        const next = toCatalog(client.instructions, tools);
        this.shutdown.signal.throwIfAborted();
        options.signal?.throwIfAborted();

        if (
            next.tools.some(
                (tool) =>
                    tool.execution?.taskSupport === "required" ||
                    tool.execution?.taskSupport === "optional",
            )
        )
            this.residency = true;

        if (!isDeepStrictEqual(next, this.catalogValue)) {
            this.options.changed(next);
            this.shutdown.signal.throwIfAborted();
            options.signal?.throwIfAborted();
            this.catalogValue = next;
        }

        this.listedClient = client;
        return next;
    }
}
