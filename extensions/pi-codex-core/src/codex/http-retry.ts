import type { CodexRuntime } from "../runtime.ts";

export type FetchedTextResponse = {
    readonly response: Response;
    readonly text: string;
};

export type FetchTextOptions = {
    readonly signal?: AbortSignal | undefined;
    readonly attempts?: number;
    readonly initialDelayMs?: number;
};

/** Fetch a complete response body with Codex-style transport/429/5xx retries. */
export async function fetchTextWithRetries(
    runtime: CodexRuntime,
    input: string,
    init: RequestInit,
    options: FetchTextOptions = {},
): Promise<FetchedTextResponse> {
    const { signal } = options;
    const attempts = options.attempts ?? 4;
    const initialDelayMs = options.initialDelayMs ?? 100;
    let lastCause: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const response = await runtime.fetch(input, { ...init, ...(signal ? { signal } : {}) });
            const text = await response.text();
            if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
                await retryDelay(initialDelayMs * 2 ** attempt, { signal });
                continue;
            }
            return { response, text };
        } catch (cause: unknown) {
            lastCause = cause;
            if (signal?.aborted) throw asError(cause);
            if (attempt + 1 >= attempts) throw asError(cause);
            await retryDelay(initialDelayMs * 2 ** attempt, { signal });
        }
    }
    throw lastCause ? asError(lastCause) : new Error("Codex request retry limit exhausted.");
}

function asError(cause: unknown): Error {
    return cause instanceof Error ? cause : new Error(String(cause));
}

function retryDelay(
    milliseconds: number,
    options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<void> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, milliseconds);
        const onAbort = () => {
            clearTimeout(timeout);
            reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
