import { Worker } from "node:worker_threads";

import { Type } from "typebox";

import { compileSchema, StringDecoder } from "../schema-parsing.ts";

const TOKENIZER_WORKER_URL = new URL("./tokenizer-worker.js", import.meta.url);

type TokenizerWorkerRequest =
    | { readonly id: number; readonly op: "count"; readonly text: string }
    | {
          readonly id: number;
          readonly op: "truncate";
          readonly text: string;
          readonly maxTokens: number;
      };

type TokenizerWorkerResult = number | string;

type TokenizerWorkerMessage =
    | { readonly type: "ready" }
    | { readonly id: number; readonly type: "result"; readonly value: TokenizerWorkerResult }
    | { readonly id: number; readonly type: "error"; readonly error: string };

const TokenizerWorkerMessageDecoder = compileSchema(
    Type.Union([
        Type.Object({ type: Type.Literal("ready") }),
        Type.Object({
            id: Type.Number(),
            type: Type.Literal("result"),
            value: Type.Union([Type.Number(), Type.String()]),
        }),
        Type.Object({ id: Type.Number(), type: Type.Literal("error"), error: Type.String() }),
    ]),
);
const TokenCountDecoder = compileSchema(Type.Number());

type PendingTokenizerRequest = {
    readonly resolve: (value: TokenizerWorkerResult) => void;
    readonly reject: (cause: unknown) => void;
    readonly disposeAbort: () => void;
};

type TokenEncoding = {
    readonly encode: (text: string) => number[];
    readonly decode: (tokens: number[]) => string;
};

export type TokenizerWorker = Pick<Worker, "on" | "unref" | "postMessage" | "terminate">;

type TokenizerWorkerState = {
    readonly worker: TokenizerWorker;
    readonly pending: Map<number, PendingTokenizerRequest>;
    readonly ready: Promise<void>;
    readyResolve: (() => void) | undefined;
    readyReject: ((cause: Error) => void) | undefined;
};

export type TokenizerOperationOptions = {
    readonly signal?: AbortSignal | undefined;
};

/** Application-owned Codex tokenizer resource with a warm worker and exact lazy fallback. */
export class CodexTokenizer {
    private workerState: TokenizerWorkerState | undefined;
    private nextRequestId = 1;
    private warmupPromise: Promise<void> | undefined;
    private mainEncodingPromise: Promise<TokenEncoding> | undefined;

    constructor(
        private readonly options: {
            readonly createWorker?: (url: URL) => TokenizerWorker;
        } = {},
    ) {}

    /** Start initializing the tokenizer off the main thread without awaiting it. */
    warm(): void {
        this.warmupPromise ??= this.ensureWorkerState().ready.catch(() => undefined);
    }

    /** Terminate this tokenizer's worker and reject only this resource's pending requests. */
    async shutdown(): Promise<void> {
        const state = this.workerState;
        this.workerState = undefined;
        this.warmupPromise = undefined;
        this.mainEncodingPromise = undefined;
        if (state === undefined) return;
        rejectPendingRequests(state, new Error("Codex tokenizer worker was shut down."));
        await state.worker.terminate();
    }

    async count(text: string, options: TokenizerOperationOptions = {}): Promise<number> {
        try {
            const value = await this.requestWorker(
                { id: this.nextRequestId++, op: "count", text },
                options,
            );
            const count = TokenCountDecoder.decode(value);
            if (count !== undefined) {
                options.signal?.throwIfAborted();
                return count;
            }
        } catch {
            options.signal?.throwIfAborted();
        }
        return this.countInMainThread(text, options);
    }

    async truncate(
        text: string,
        maxTokens: number,
        options: TokenizerOperationOptions = {},
    ): Promise<string> {
        try {
            const value = await this.requestWorker(
                { id: this.nextRequestId++, op: "truncate", text, maxTokens },
                options,
            );
            const truncated = StringDecoder.decode(value);
            if (truncated !== undefined) {
                options.signal?.throwIfAborted();
                return truncated;
            }
        } catch {
            options.signal?.throwIfAborted();
        }
        return this.truncateInMainThread(text, maxTokens, options);
    }

    private async requestWorker(
        request: TokenizerWorkerRequest,
        options: TokenizerOperationOptions,
    ): Promise<TokenizerWorkerResult> {
        const { signal } = options;
        signal?.throwIfAborted();
        const state = this.ensureWorkerState();
        await waitForPromise(state.ready, options);
        signal?.throwIfAborted();
        return new Promise((resolve, reject) => {
            const abort = () => {
                const pending = state.pending.get(request.id);
                if (pending === undefined) return;
                state.pending.delete(request.id);
                pending.disposeAbort();
                reject(signal?.reason);
            };
            const disposeAbort = () => signal?.removeEventListener("abort", abort);
            state.pending.set(request.id, { resolve, reject, disposeAbort });
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) {
                abort();
                return;
            }
            try {
                state.worker.postMessage(request);
            } catch (cause: unknown) {
                state.pending.delete(request.id);
                disposeAbort();
                reject(cause instanceof Error ? cause : new Error(String(cause)));
            }
        });
    }

    private ensureWorkerState(): TokenizerWorkerState {
        if (this.workerState !== undefined) return this.workerState;

        const worker = this.options.createWorker
            ? this.options.createWorker(TOKENIZER_WORKER_URL)
            : new Worker(TOKENIZER_WORKER_URL);
        worker.unref();
        const pending = new Map<number, PendingTokenizerRequest>();
        let readyResolve: (() => void) | undefined;
        let readyReject: ((cause: Error) => void) | undefined;
        const ready = new Promise<void>((resolve, reject) => {
            readyResolve = resolve;
            readyReject = reject;
        });
        const state: TokenizerWorkerState = {
            worker,
            pending,
            ready,
            readyResolve,
            readyReject,
        };
        this.workerState = state;

        worker.on("message", (message) => {
            const parsed = TokenizerWorkerMessageDecoder.decode(message);
            if (parsed) this.handleWorkerMessage(state, parsed);
        });
        worker.on("error", (cause: Error) => this.markWorkerFailed(state, cause));
        worker.on("exit", (code) => {
            if (code !== 0 || state.readyReject !== undefined || state.pending.size > 0) {
                this.markWorkerFailed(
                    state,
                    new Error(`Codex tokenizer worker exited with code ${code}.`),
                );
            }
        });
        return state;
    }

    private handleWorkerMessage(
        state: TokenizerWorkerState,
        message: TokenizerWorkerMessage,
    ): void {
        if (message.type === "ready") {
            state.readyResolve?.();
            state.readyResolve = undefined;
            state.readyReject = undefined;
            return;
        }
        const pendingRequest = state.pending.get(message.id);
        if (pendingRequest === undefined) return;
        state.pending.delete(message.id);
        pendingRequest.disposeAbort();
        if (message.type === "error") {
            pendingRequest.reject(new Error(message.error));
            return;
        }
        pendingRequest.resolve(message.value);
    }

    private markWorkerFailed(state: TokenizerWorkerState, cause: Error): void {
        if (this.workerState === state) {
            this.workerState = undefined;
            this.warmupPromise = undefined;
        }
        state.readyReject?.(cause);
        state.readyResolve = undefined;
        state.readyReject = undefined;
        rejectPendingRequests(state, cause);
    }

    private async countInMainThread(
        text: string,
        options: TokenizerOperationOptions,
    ): Promise<number> {
        options.signal?.throwIfAborted();
        try {
            const encoding = await this.loadMainThreadEncoding();
            options.signal?.throwIfAborted();
            const count = encoding.encode(text).length;
            options.signal?.throwIfAborted();
            return count;
        } catch {
            options.signal?.throwIfAborted();
            const count = approximateTextTokens(text);
            options.signal?.throwIfAborted();
            return count;
        }
    }

    private async truncateInMainThread(
        text: string,
        maxTokens: number,
        options: TokenizerOperationOptions,
    ): Promise<string> {
        options.signal?.throwIfAborted();
        if (maxTokens <= 0) return "";
        try {
            const encoding = await this.loadMainThreadEncoding();
            options.signal?.throwIfAborted();
            const tokens = encoding.encode(text);
            options.signal?.throwIfAborted();
            if (tokens.length <= maxTokens) {
                options.signal?.throwIfAborted();
                return text;
            }
            if (maxTokens <= 3) {
                const result = encoding.decode(tokens.slice(0, maxTokens));
                options.signal?.throwIfAborted();
                return result;
            }
            const marker = "\n…\n";
            const markerTokens = encoding.encode(marker).length;
            const remaining = Math.max(1, maxTokens - markerTokens);
            const headCount = Math.ceil(remaining / 2);
            const tailCount = Math.floor(remaining / 2);
            const result = `${encoding.decode(tokens.slice(0, headCount))}${marker}${encoding.decode(
                tokens.slice(tokens.length - tailCount),
            )}`;
            options.signal?.throwIfAborted();
            return result;
        } catch {
            options.signal?.throwIfAborted();
            const result = truncateTextByApproximateTokenBudget(text, maxTokens);
            options.signal?.throwIfAborted();
            return result;
        }
    }

    private loadMainThreadEncoding(): Promise<TokenEncoding> {
        this.mainEncodingPromise ??= import("js-tiktoken").then(({ getEncoding }) => {
            const encoding = getEncoding("o200k_base");
            return {
                encode: (text: string) => encoding.encode(text),
                decode: (tokens: number[]) => encoding.decode(tokens),
            };
        });
        return this.mainEncodingPromise;
    }
}

function waitForPromise<T>(promise: Promise<T>, options: TokenizerOperationOptions): Promise<T> {
    const { signal } = options;
    if (signal === undefined) return promise;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener("abort", abort);
            reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", abort);
                resolve(value);
            },
            (cause: unknown) => {
                signal.removeEventListener("abort", abort);
                reject(cause);
            },
        );
    });
}

function rejectPendingRequests(state: TokenizerWorkerState, cause: Error): void {
    for (const pendingRequest of state.pending.values()) {
        pendingRequest.disposeAbort();
        pendingRequest.reject(cause);
    }
    state.pending.clear();
}

function approximateTextTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function truncateTextByApproximateTokenBudget(text: string, maxTokens: number): string {
    if (maxTokens <= 0) return "";
    const maxChars = Math.max(1, maxTokens * 4);
    if (text.length <= maxChars) return text;
    if (maxChars <= 3) return text.slice(0, maxChars);
    const marker = "\n…\n";
    const remaining = Math.max(1, maxChars - marker.length);
    const headCount = Math.ceil(remaining / 2);
    const tailCount = Math.floor(remaining / 2);
    return `${text.slice(0, headCount)}${marker}${text.slice(text.length - tailCount)}`;
}
