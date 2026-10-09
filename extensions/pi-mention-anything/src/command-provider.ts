import { spawn } from "node:child_process";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
    discoveryResponseSchema,
    resolutionSchema,
    type Candidate,
    type DiscoveryResponse,
    type Provider,
    type Resolution,
} from "./source-contract.ts";

export const COMMAND_PROVIDER_PROTOCOL_VERSION = 1 as const;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export type CommandProcessOptions = {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
};

export type CommandProviderOptions = CommandProcessOptions & {
    readonly filtering?: "local" | "provider";
};

export type CommandDiscoveryRequestV1 = {
    readonly version: typeof COMMAND_PROVIDER_PROTOCOL_VERSION;
    readonly method: "discover";
    readonly sourceId: string;
    readonly cwd: string;
    readonly trusted: boolean;
    readonly query: string;
    readonly path: readonly Candidate[];
    readonly limit: number;
    readonly cursor?: string;
};

export type CommandResolveRequestV1 = {
    readonly version: typeof COMMAND_PROVIDER_PROTOCOL_VERSION;
    readonly method: "resolve";
    readonly sourceId: string;
    readonly cwd: string;
    readonly trusted: boolean;
    readonly segments: readonly string[];
};

export type CommandRequestV1 = CommandDiscoveryRequestV1 | CommandResolveRequestV1;

export type CommandDiscoveryResponseV1 = {
    readonly version: typeof COMMAND_PROVIDER_PROTOCOL_VERSION;
    readonly method: "discover";
    readonly result: DiscoveryResponse;
};

export type CommandResolveResponseV1 = {
    readonly version: typeof COMMAND_PROVIDER_PROTOCOL_VERSION;
    readonly method: "resolve";
    readonly result: Resolution;
};

export type CommandResponseV1 = CommandDiscoveryResponseV1 | CommandResolveResponseV1;

const commandDiscoveryResponseSchema = Type.Object(
    {
        version: Type.Literal(COMMAND_PROVIDER_PROTOCOL_VERSION),
        method: Type.Literal("discover"),
        result: discoveryResponseSchema,
    },
    { additionalProperties: false },
);

const commandResolveResponseSchema = Type.Object(
    {
        version: Type.Literal(COMMAND_PROVIDER_PROTOCOL_VERSION),
        method: Type.Literal("resolve"),
        result: resolutionSchema,
    },
    { additionalProperties: false },
);

function validateProcessOptions(options: CommandProcessOptions): void {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new Error("timeoutMs must be positive");

    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
        throw new Error("maxOutputBytes must be a positive integer");
    }
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
    const pid = child.pid;
    if (pid !== undefined && process.platform !== "win32") {
        try {
            process.kill(-pid, "SIGKILL");
            return;
        } catch {
            // The process may have exited between the event and termination attempt.
        }
    }

    child.kill("SIGKILL");
}

/**
 * Executes a JSON-producing command without a shell. An undefined request closes stdin without
 * writing bytes, which is the explicit adapter for commands that only return a JSON array.
 */
/* oxlint-disable antislop/no-unknown-returns, typescript/no-redundant-type-constituents -- The requested low-level JSON adapter intentionally leaves parsing to its caller. */
export async function executeJsonCommand(
    options: CommandProcessOptions,
    request: unknown | undefined,
    signal: AbortSignal,
): Promise<unknown> {
    validateProcessOptions(options);
    signal.throwIfAborted();
    let input: string | undefined;
    if (request !== undefined) {
        try {
            // JSON.stringify returns undefined for unsupported top-level values.
            const stringify: (...args: Parameters<typeof JSON.stringify>) => string | undefined =
                JSON.stringify;
            input = stringify(request);
        } catch {
            return Promise.reject(new Error("command request must be JSON serializable"));
        }

        if (input === undefined) {
            return Promise.reject(new Error("command request must be JSON serializable"));
        }
    }

    const child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
    });

    return new Promise<unknown>((resolve, reject) => {
        const stdout: Buffer[] = [];
        const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        let outputBytes = 0;
        let failure: Error | undefined;
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let abortListener: (() => void) | undefined;

        const finishFailure = (cause: Error): void => {
            if (settled) return;

            settled = true;
            clearTimeout(timeout);

            if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
            killProcessTree(child);
            reject(cause);
        };

        abortListener = (): void => {
            let cause: Error = new DOMException("The operation was aborted", "AbortError");
            if (signal.reason instanceof Error) cause = signal.reason;
            finishFailure(cause);
        };
        timeout = setTimeout(
            () => finishFailure(new Error("command timed out")),
            options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );

        signal.addEventListener("abort", abortListener, { once: true });
        child.once("error", () => {
            finishFailure(new Error("command could not be started"));
        });

        child.stdin.once("error", () => {
            if (!settled) failure = new Error("command stdin failed");
        });

        child.stdout.on("data", (chunk: Buffer) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > maxOutputBytes) {
                failure = new Error("command output exceeded maxOutputBytes");
                killProcessTree(child);
                return;
            }

            stdout.push(chunk);
        });

        child.stderr.on("data", (chunk: Buffer) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > maxOutputBytes) {
                failure = new Error("command output exceeded maxOutputBytes");
                killProcessTree(child);
            }
        });

        child.once("close", (code, closeSignal) => {
            if (settled) return;

            settled = true;
            clearTimeout(timeout);
            signal.removeEventListener("abort", abortListener);

            if (failure !== undefined) {
                reject(failure);
                return;
            }

            if (code !== 0 || closeSignal !== null) {
                reject(new Error("command failed"));
                return;
            }

            try {
                resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
            } catch {
                reject(new Error("command stdout must contain one JSON value"));
            }
        });

        if (input === undefined) child.stdin.end();
        else child.stdin.end(`${input}\n`);
    });
}
/* oxlint-enable antislop/no-unknown-returns, typescript/no-redundant-type-constituents */

/** Adapts the explicit version-1 stdin/stdout protocol to the shared provider contract. */
export function createCommandProvider(options: CommandProviderOptions): Provider {
    validateProcessOptions(options);

    return {
        filtering: options.filtering ?? "provider",
        async discover(request) {
            let commandRequest: CommandDiscoveryRequestV1;
            if (request.cursor === undefined) {
                commandRequest = {
                    version: COMMAND_PROVIDER_PROTOCOL_VERSION,
                    method: "discover",
                    sourceId: request.sourceId,
                    cwd: request.cwd,
                    trusted: request.trusted,
                    query: request.query,
                    path: request.path,
                    limit: request.limit,
                };
            } else {
                commandRequest = {
                    version: COMMAND_PROVIDER_PROTOCOL_VERSION,
                    method: "discover",
                    sourceId: request.sourceId,
                    cwd: request.cwd,
                    trusted: request.trusted,
                    query: request.query,
                    path: request.path,
                    limit: request.limit,
                    cursor: request.cursor,
                };
            }

            const response = await executeJsonCommand(options, commandRequest, request.signal);
            try {
                return Value.Parse(commandDiscoveryResponseSchema, response).result;
            } catch {
                throw new Error("command returned an invalid protocol v1 response");
            }
        },
        async resolve(request) {
            const commandRequest: CommandResolveRequestV1 = {
                version: COMMAND_PROVIDER_PROTOCOL_VERSION,
                method: "resolve",
                sourceId: request.sourceId,
                cwd: request.cwd,
                trusted: request.trusted,
                segments: request.segments,
            };
            const response = await executeJsonCommand(options, commandRequest, request.signal);
            try {
                return Value.Parse(commandResolveResponseSchema, response).result;
            } catch {
                throw new Error("command returned an invalid protocol v1 response");
            }
        },
    };
}
