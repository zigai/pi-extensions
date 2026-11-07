const DEFAULT_COMPLETED_LINE_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_COMPLETED_LINE_CACHE_ENTRIES = 10_000;
const COMPLETED_LINE_CACHE_ENTRY_OVERHEAD_BYTES = 16;

export type CompletedLineCacheLimits = {
    readonly maxBytes: number;
    readonly maxEntries: number;
};

type CacheState = {
    value?: unknown;
    width?: number | undefined;
    lines?: string[] | undefined;
};

type LineState = {
    width: number | undefined;
    lines: string[] | undefined;
};

// The LRU/finalizer hold only reclaimable data state, never component owners.
// Derived Pierre rows and ANSI frames share the same global byte/entry budget.
const retained = new Map<CacheState, number>();
const derivedStates = new Set<CacheState>();
const finalizer = new FinalizationRegistry<CacheState>(release);

let retainedBytes = 0;
let maxBytes = DEFAULT_COMPLETED_LINE_CACHE_BYTES;
let maxEntries = DEFAULT_COMPLETED_LINE_CACHE_ENTRIES;
let evictions = 0;
let hits = 0;
let misses = 0;

function release(state: CacheState): void {
    const bytes = retained.get(state);
    if (bytes !== undefined) {
        retained.delete(state);
        retainedBytes -= bytes;
        finalizer.unregister(state);
    }

    derivedStates.delete(state);
    state.value = undefined;
    state.width = undefined;
    state.lines = undefined;
}

// ANSI frames are the expensive repaint product. Evict rebuildable row data
// first, and never let admitting row data displace an already-cached frame.
function evictOldest(derivedOnly: boolean): boolean {
    let oldest = derivedStates.values().next();
    if (oldest.done === true && !derivedOnly) oldest = retained.keys().next();
    if (oldest.done === true) return false;

    release(oldest.value);
    evictions += 1;
    return true;
}

export function clearCompletedLineCache(): void {
    for (const state of retained.keys()) release(state);
}

export function configureCompletedLineCache(limits: CompletedLineCacheLimits): void {
    if (maxBytes === limits.maxBytes && maxEntries === limits.maxEntries) return;

    clearCompletedLineCache();
    maxBytes = limits.maxBytes;
    maxEntries = limits.maxEntries;
}

export function completedLineCacheStats() {
    return {
        completedLineCacheEntries: retained.size,
        completedLineCacheBytes: retainedBytes,
        completedLineCacheLimitBytes: maxBytes,
        completedLineCacheLimitEntries: maxEntries,
        completedLineCacheEvictions: evictions,
        completedLineCacheHits: hits,
        completedLineCacheMisses: misses,
    };
}

export class RenderedLineCache {
    private readonly state: LineState = { width: undefined, lines: undefined };

    has(width: number): boolean {
        return this.state.width === width && this.state.lines !== undefined;
    }

    get(width: number): string[] | undefined {
        if (this.state.width !== width || this.state.lines === undefined) {
            misses += 1;
            return undefined;
        }

        hits += 1;

        const bytes = retained.get(this.state);
        if (bytes !== undefined) {
            retained.delete(this.state);
            retained.set(this.state, bytes);
        }

        return this.state.lines;
    }

    set(width: number, lines: string[]): void {
        this.clear();

        let bytes = lines.length * COMPLETED_LINE_CACHE_ENTRY_OVERHEAD_BYTES;
        for (const line of lines) bytes += Buffer.byteLength(line, "utf8");

        if (bytes > maxBytes) return;

        while (retainedBytes + bytes > maxBytes || retained.size >= maxEntries) {
            if (!evictOldest(false)) return;
        }

        this.state.width = width;
        this.state.lines = lines;
        retained.set(this.state, bytes);
        retainedBytes += bytes;
        finalizer.register(this, this.state, this.state);
    }

    clear(): void {
        release(this.state);
    }
}

type ValueState<T> = { value: T | undefined };

/** Reclaimable derived render data. Values must never refer to their owning component. */
export class RenderedValueCache<T> {
    private readonly state: ValueState<T> = { value: undefined };

    get(): T | undefined {
        const bytes = retained.get(this.state);
        if (bytes === undefined) return undefined;

        retained.delete(this.state);
        retained.set(this.state, bytes);
        derivedStates.delete(this.state);
        derivedStates.add(this.state);

        return this.state.value;
    }

    set(value: T, bytes: number): void {
        this.clear();

        if (!Number.isFinite(bytes) || bytes < 0 || bytes > maxBytes) return;

        while (retainedBytes + bytes > maxBytes || retained.size >= maxEntries) {
            if (!evictOldest(true)) return;
        }

        this.state.value = value;
        derivedStates.add(this.state);
        retained.set(this.state, bytes);
        retainedBytes += bytes;
        finalizer.register(this, this.state, this.state);
    }

    clear(): void {
        release(this.state);
    }
}
