/** Fetch-compatible function used by Codex network adapters. */
export type CodexFetch = typeof fetch;

/** Clock seam for deterministic time-sensitive service behavior. */
export type Clock = {
    readonly nowMs: () => number;
    readonly nowDate: () => Date;
};

/** ID generator seam for retry-safe and deterministic request/window IDs. */
export type IdGenerator = {
    readonly randomUUID: () => string;
};

export type ScheduledTask = {
    readonly cancel: () => void;
};

/** Scheduler seam for delayed work owned by the Pi session runtime. */
export type Scheduler = {
    readonly set: (delayMs: number, task: () => void) => ScheduledTask;
};

/** Wait with caller-owned cancellation and cleanup, including synchronous schedulers. */
export async function waitWithScheduler(
    scheduler: Scheduler,
    delayMs: number,
    options: {
        readonly signal?: AbortSignal | undefined;
        readonly preservePreAbortReason?: boolean;
    } = {},
): Promise<void> {
    const { signal } = options;
    if (signal?.aborted) {
        let abortReason: Error;
        if (options.preservePreAbortReason) {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: preservePreAbortReason requires forwarding signal.reason verbatim even if undefined or non-Error.
            abortReason = signal.reason as Error;
        } else {
            abortReason =
                signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException("Aborted", "AbortError");
        }

        return Promise.reject(abortReason);
    }

    return new Promise<void>((resolve, reject) => {
        let settled = false;
        let task: ScheduledTask | undefined;
        const settle = (complete: () => void) => {
            if (settled) return;

            settled = true;
            task?.cancel();
            signal?.removeEventListener("abort", onAbort);
            complete();
        };

        const onAbort = () => {
            const abortReason =
                signal?.reason instanceof Error
                    ? signal.reason
                    : new DOMException("Aborted", "AbortError");

            settle(() => reject(abortReason));
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        try {
            task = scheduler.set(delayMs, () => settle(resolve));

            // oxlint-disable-next-line typescript/no-unnecessary-condition -- SAFETY: settled can be mutated synchronously during scheduler registration.
            if (settled) task.cancel();
        } catch (cause: unknown) {
            const error = cause instanceof Error ? cause : new Error(String(cause));

            settle(() => reject(error));
        }
    });
}

/** Runtime services used by boundary adapters and workflow shell code. */
export type CodexRuntime = {
    readonly fetch: CodexFetch;
    readonly clock: Clock;
    readonly idGenerator: IdGenerator;
    readonly scheduler: Scheduler;
};

export const systemClock: Clock = {
    nowMs: () => Date.now(),
    nowDate: () => new Date(),
};

export const cryptoIdGenerator: IdGenerator = {
    randomUUID: () => globalThis.crypto.randomUUID(),
};

export const timeoutScheduler: Scheduler = {
    set(delayMs, task) {
        const timer = setTimeout(task, delayMs);

        return { cancel: () => clearTimeout(timer) };
    },
};

export const defaultCodexRuntime: CodexRuntime = {
    fetch: async (input, init) => globalThis.fetch(input, init),
    clock: systemClock,
    idGenerator: cryptoIdGenerator,
    scheduler: timeoutScheduler,
};
