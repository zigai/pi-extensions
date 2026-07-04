import { Worker } from "node:worker_threads";

const TOKENIZER_WORKER_URL = new URL("./tokenizer-worker.js", import.meta.url);

type TokenizerWorkerRequest =
    | {
          readonly id: number;
          readonly op: "count";
          readonly text: string;
      }
    | {
          readonly id: number;
          readonly op: "truncate";
          readonly text: string;
          readonly maxTokens: number;
      };

type TokenizerWorkerMessage =
    | {
          readonly type: "ready";
      }
    | {
          readonly id: number;
          readonly type: "result";
          readonly value: unknown;
      }
    | {
          readonly id: number;
          readonly type: "error";
          readonly error: string;
      };

type PendingTokenizerRequest = {
    readonly resolve: (value: unknown) => void;
    readonly reject: (cause: Error) => void;
};

type TokenEncoding = {
    readonly encode: (text: string) => number[];
    readonly decode: (tokens: number[]) => string;
};

type TokenizerWorkerState = {
    readonly worker: Worker;
    readonly pending: Map<number, PendingTokenizerRequest>;
    readonly ready: Promise<void>;
    readyResolve: (() => void) | undefined;
    readyReject: ((cause: Error) => void) | undefined;
};

let workerState: TokenizerWorkerState | undefined;
let nextRequestId = 1;
let warmupPromise: Promise<void> | undefined;
let mainEncodingPromise: Promise<TokenEncoding> | undefined;

/** Start initializing the Codex tokenizer off the main thread without awaiting it. */
export function warmCodexTokenizer(): void {
    warmupPromise ??= ensureWorkerState().ready.catch(() => undefined);
}

/** Terminate the background tokenizer worker and reject any pending requests. */
export async function shutdownCodexTokenizer(): Promise<void> {
    const state = workerState;
    workerState = undefined;
    warmupPromise = undefined;
    if (state === undefined) {
        return;
    }
    rejectPendingRequests(state, new Error("Codex tokenizer worker was shut down."));
    await state.worker.terminate();
}

/** Count text tokens using the warm worker when possible, with exact lazy fallback. */
export async function countCodexTextTokens(text: string): Promise<number> {
    try {
        const value = await requestWorker({ id: nextRequestId++, op: "count", text });
        return typeof value === "number" && Number.isFinite(value)
            ? value
            : await countTextTokensInMainThread(text);
    } catch {
        return countTextTokensInMainThread(text);
    }
}

/** Truncate text to a token budget using the warm worker when possible, with exact lazy fallback. */
export async function truncateCodexTextToTokenBudget(
    text: string,
    maxTokens: number,
): Promise<string> {
    try {
        const value = await requestWorker({ id: nextRequestId++, op: "truncate", text, maxTokens });
        return typeof value === "string"
            ? value
            : await truncateTextToTokenBudgetInMainThread(text, maxTokens);
    } catch {
        return truncateTextToTokenBudgetInMainThread(text, maxTokens);
    }
}

async function requestWorker(request: TokenizerWorkerRequest): Promise<unknown> {
    const state = ensureWorkerState();
    await state.ready;
    return new Promise((resolve, reject) => {
        state.pending.set(request.id, { resolve, reject });
        try {
            state.worker.postMessage(request);
        } catch (cause: unknown) {
            state.pending.delete(request.id);
            reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
    });
}

function ensureWorkerState(): TokenizerWorkerState {
    if (workerState !== undefined) {
        return workerState;
    }

    const worker = new Worker(TOKENIZER_WORKER_URL);
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
    workerState = state;

    worker.on("message", (message: unknown) => handleWorkerMessage(state, message));
    worker.on("error", (cause: Error) => markWorkerFailed(state, cause));
    worker.on("exit", (code) => {
        if (code !== 0 || state.readyReject !== undefined || state.pending.size > 0) {
            markWorkerFailed(state, new Error(`Codex tokenizer worker exited with code ${code}.`));
        }
    });

    return state;
}

function handleWorkerMessage(state: TokenizerWorkerState, message: unknown): void {
    if (!isWorkerMessage(message)) {
        return;
    }
    if (message.type === "ready") {
        state.readyResolve?.();
        state.readyResolve = undefined;
        state.readyReject = undefined;
        return;
    }

    const pendingRequest = state.pending.get(message.id);
    if (pendingRequest === undefined) {
        return;
    }
    state.pending.delete(message.id);
    if (message.type === "error") {
        pendingRequest.reject(new Error(message.error));
        return;
    }
    pendingRequest.resolve(message.value);
}

function markWorkerFailed(state: TokenizerWorkerState, cause: Error): void {
    if (workerState === state) {
        workerState = undefined;
        warmupPromise = undefined;
    }
    state.readyReject?.(cause);
    state.readyResolve = undefined;
    state.readyReject = undefined;
    rejectPendingRequests(state, cause);
}

function rejectPendingRequests(state: TokenizerWorkerState, cause: Error): void {
    for (const pendingRequest of state.pending.values()) {
        pendingRequest.reject(cause);
    }
    state.pending.clear();
}

function isWorkerMessage(message: unknown): message is TokenizerWorkerMessage {
    if (!isRecord(message) || typeof message.type !== "string") {
        return false;
    }
    if (message.type === "ready") {
        return true;
    }
    if (typeof message.id !== "number") {
        return false;
    }
    if (message.type === "result") {
        return true;
    }
    return message.type === "error" && typeof message.error === "string";
}

async function countTextTokensInMainThread(text: string): Promise<number> {
    try {
        const encoding = await loadMainThreadEncoding();
        return encoding.encode(text).length;
    } catch {
        return approximateTextTokens(text);
    }
}

async function truncateTextToTokenBudgetInMainThread(
    text: string,
    maxTokens: number,
): Promise<string> {
    if (maxTokens <= 0) {
        return "";
    }
    try {
        const encoding = await loadMainThreadEncoding();
        const tokens = encoding.encode(text);
        if (tokens.length <= maxTokens) return text;
        if (maxTokens <= 3) return encoding.decode(tokens.slice(0, maxTokens));
        const marker = "\n…\n";
        const markerTokens = encoding.encode(marker).length;
        const remaining = Math.max(1, maxTokens - markerTokens);
        const headCount = Math.ceil(remaining / 2);
        const tailCount = Math.floor(remaining / 2);
        const head = encoding.decode(tokens.slice(0, headCount));
        const tail = encoding.decode(tokens.slice(tokens.length - tailCount));
        return `${head}${marker}${tail}`;
    } catch {
        return truncateTextByApproximateTokenBudget(text, maxTokens);
    }
}

async function loadMainThreadEncoding(): Promise<TokenEncoding> {
    mainEncodingPromise ??= import("js-tiktoken").then(({ getEncoding }) => {
        const encoding = getEncoding("o200k_base");
        return {
            encode: (text: string) => encoding.encode(text),
            decode: (tokens: number[]) => encoding.decode(tokens),
        };
    });
    return mainEncodingPromise;
}

function approximateTextTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function truncateTextByApproximateTokenBudget(text: string, maxTokens: number): string {
    if (maxTokens <= 0) {
        return "";
    }
    const maxChars = Math.max(1, maxTokens * 4);
    if (text.length <= maxChars) {
        return text;
    }
    if (maxChars <= 3) {
        return text.slice(0, maxChars);
    }
    const marker = "\n…\n";
    const remaining = Math.max(1, maxChars - marker.length);
    const headCount = Math.ceil(remaining / 2);
    const tailCount = Math.floor(remaining / 2);
    return `${text.slice(0, headCount)}${marker}${text.slice(text.length - tailCount)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
