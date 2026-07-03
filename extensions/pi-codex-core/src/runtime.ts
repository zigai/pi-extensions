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
    fetch: (input, init) => globalThis.fetch(input, init),
    clock: systemClock,
    idGenerator: cryptoIdGenerator,
    scheduler: timeoutScheduler,
};
