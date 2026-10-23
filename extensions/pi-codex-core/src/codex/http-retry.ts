import { waitWithScheduler, type CodexRuntime } from "../runtime.ts";
import { parseRetryAfterMs } from "./retry-after.ts";

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
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const requestInit: RequestInit = { ...init };
            if (signal !== undefined) requestInit.signal = signal;

            const response = await runtime.fetch(input, requestInit);
            const receivedAt = runtime.clock.nowMs();
            const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"), receivedAt);
            const text = await response.text();

            if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
                let delayMs = initialDelayMs * 2 ** attempt;
                if (retryAfterMs !== undefined) {
                    delayMs = Math.max(0, receivedAt + retryAfterMs - runtime.clock.nowMs());
                }

                await waitWithScheduler(runtime.scheduler, delayMs, {
                    signal,
                    preservePreAbortReason: true,
                });

                continue;
            }

            return { response, text };
        } catch (cause: unknown) {
            if (signal?.aborted) throw asError(cause);
            if (attempt + 1 >= attempts) throw asError(cause);

            await waitWithScheduler(runtime.scheduler, initialDelayMs * 2 ** attempt, {
                signal,
                preservePreAbortReason: true,
            });
        }
    }

    throw new Error("Codex request retry limit exhausted.");
}

function asError(cause: unknown): Error {
    return cause instanceof Error ? cause : new Error(String(cause));
}
