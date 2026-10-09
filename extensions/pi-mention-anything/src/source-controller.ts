import { watch, type FSWatcher } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
    candidateSchema,
    discoveryResponseSchema,
    parseDiscoveryResponse,
    parseResolution,
    type Candidate,
    type DiscoveryRequest,
    type DiscoveryResponse,
    type Provider,
    type Resolution,
} from "./source-contract.ts";

const PROVIDER_DISCOVERY_LIMIT = 100;
const LOCAL_DISCOVERY_LIMIT = 10_000;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_ENTRIES = 64;
const FAILED_RETRY_DELAY_MS = 1_000;
const AUXILIARY_ENTRY_TTL_MS = 60_000;
const PERSISTENCE_VERSION = 2;
const MAX_PERSISTENCE_BYTES = 8 * 1024 * 1024;
const persistenceWriters = new Map<string, Promise<void>>();

async function readPersistence(path: string): Promise<string> {
    const file = await open(path, "r");

    try {
        const metadata = await file.stat();
        if (metadata.size > MAX_PERSISTENCE_BYTES)
            throw new Error("Persistent mention cache exceeds its size limit.");

        const buffer = Buffer.alloc(Math.min(MAX_PERSISTENCE_BYTES + 1, metadata.size + 1));
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
            if (bytesRead === 0) break;

            offset += bytesRead;
        }

        if (offset === buffer.length)
            throw new Error("Persistent mention cache changed while loading.");

        return buffer.subarray(0, offset).toString("utf8");
    } finally {
        await file.close();
    }
}

export type SourceControllerDiscovery = {
    readonly query: string;
    readonly path: readonly Candidate[];
    readonly cursor?: string;
    readonly signal?: AbortSignal;
};

type SourceControllerBaseOptions = {
    readonly sourceId: string;
    readonly cwd: string;
    readonly trusted: boolean;
    readonly cache?: boolean;
    readonly cacheTtlMs?: number;
    readonly refreshOnStartup?: boolean;
    readonly refreshIntervalMs?: number;
    readonly watchFiles?: readonly string[];
    readonly debounceMs?: number;
    readonly maxEntries?: number;
    readonly maxConcurrent?: number;
    readonly onError?: (message: string) => void;
    readonly now?: () => number;
};

export type SourceControllerOptions = SourceControllerBaseOptions & {
    readonly persistentCachePath?: string;
    readonly configurationKey?: string;
};

type ScopedSourceControllerOptions<Options extends SourceControllerOptions> =
    undefined extends Options["persistentCachePath"]
        ? Options
        : Options & { readonly configurationKey: string };

export type SourceControllerErrorCode =
    | "discovery-failed"
    | "persistence-failed"
    | "provider-disposal-failed"
    | "resolution-failed";

export type SourceControllerStatus = {
    readonly cachedEntries: number;
    readonly cachedCandidates: number;
    readonly inFlightRequests: number;
    readonly queuedRequests: number;
    readonly failedRequestKeys: number;
    readonly latestRequestScopes: number;
    readonly oldestCacheAgeMs: number | undefined;
    readonly errorCodes: readonly SourceControllerErrorCode[];
};

export type SourceController = {
    discover(request: SourceControllerDiscovery): Promise<DiscoveryResponse>;
    resolve(segments: readonly string[], signal?: AbortSignal): Promise<Resolution>;
    warm(): Promise<void>;
    refresh(): Promise<void>;
    invalidate(): void;
    status(): SourceControllerStatus;
    dispose(): Promise<void>;
};

type CachedRequest = {
    readonly query: string;
    readonly path: readonly Candidate[];
    readonly cursor?: string;
};

type CacheEntry = {
    readonly request: CachedRequest;
    readonly response: DiscoveryResponse;
    readonly expiresAt: number;
    readonly cachedAt: number;
};

type SharedWork<Result> = {
    readonly controller: AbortController;
    promise: Promise<Result>;
    waiters: number;
    settled: boolean;
};

type SharedRequest = SharedWork<DiscoveryResponse>;
type ResolvedResolution = Extract<Resolution, { readonly status: "resolved" }>;

type ResolutionCacheEntry = {
    readonly resolution: ResolvedResolution;
    readonly expiresAt: number;
    readonly cachedAt: number;
};

type SharedResolution = SharedWork<Resolution>;

type LatestRequest = {
    readonly key: string;
    readonly expiresAt: number;
};

type QueueItem = {
    readonly signal: AbortSignal;
    start: (release: () => void) => void;
    readonly reject: (cause: unknown) => void;
};

type PersistedEntry = {
    readonly key: string;
    readonly request: CachedRequest;
    readonly response: DiscoveryResponse;
    readonly expiresAt: number;
    readonly cachedAt: number;
};

type PersistedDocument = {
    readonly version: typeof PERSISTENCE_VERSION;
    readonly scope: string;
    readonly entries: readonly PersistedEntry[];
};

const cachedRequestSchema = Type.Object(
    {
        query: Type.String(),
        path: Type.Array(candidateSchema),
        cursor: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);

const persistedEntrySchema = Type.Object(
    {
        key: Type.String(),
        request: cachedRequestSchema,
        response: discoveryResponseSchema,
        expiresAt: Type.Number(),
        cachedAt: Type.Number(),
    },
    { additionalProperties: false },
);

const persistedDocumentSchema = Type.Object(
    {
        version: Type.Literal(PERSISTENCE_VERSION),
        scope: Type.String(),
        entries: Type.Array(persistedEntrySchema),
    },
    { additionalProperties: false },
);

const ERROR_MESSAGE_BY_CODE = {
    "discovery-failed": "Mention source discovery failed.",
    "persistence-failed": "Mention source persistence failed.",
    "provider-disposal-failed": "Mention source provider disposal failed.",
    "resolution-failed": "Mention source resolution failed.",
} satisfies Record<SourceControllerErrorCode, string>;

function abortCause(signal: AbortSignal): Error {
    if (signal.reason instanceof Error) return signal.reason;
    return new DOMException("The operation was aborted", "AbortError");
}

async function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (milliseconds === 0) return Promise.resolve();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve, reject) => {
        const abort = (): void => {
            clearTimeout(timer);
            reject(abortCause(signal));
        };

        timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, milliseconds);
        signal.addEventListener("abort", abort, { once: true });
    });

    return promise;
}

function resolveWatchFilePath(file: string, cwd: string): string {
    if (file === "~") return homedir();
    if (file.startsWith("~/")) return join(homedir(), file.slice(2));
    return resolve(cwd, file);
}

function validateDiscoveryResponse(response: DiscoveryResponse, limit: number): DiscoveryResponse {
    const parsed = parseDiscoveryResponse(response);
    if (parsed.items.length > limit)
        throw new Error("provider exceeded the discovery result limit");

    const ids = new Set<string>();
    for (const item of parsed.items) {
        if (ids.has(item.id)) throw new Error("provider returned duplicate candidate IDs");

        ids.add(item.id);
    }

    return parsed;
}

class ConcurrencyLimiter {
    readonly #limit: number;
    readonly #queue: QueueItem[] = [];
    #active = 0;

    constructor(limit: number) {
        this.#limit = limit;
    }

    get queued(): number {
        return this.#queue.length;
    }

    async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
        const release = await this.#acquire(signal);
        try {
            signal.throwIfAborted();
            return await operation();
        } finally {
            release();
        }
    }

    async #acquire(signal: AbortSignal): Promise<() => void> {
        signal.throwIfAborted();

        if (this.#active < this.#limit) {
            this.#active += 1;
            return this.#makeRelease();
        }

        return new Promise((resolve, reject) => {
            const abort = (): void => {
                const index = this.#queue.findIndex((queued) => queued.reject === reject);
                if (index >= 0) this.#queue.splice(index, 1);
                reject(abortCause(signal));
            };
            const item: QueueItem = {
                signal,
                reject,
                start: (release: () => void): void => {
                    signal.removeEventListener("abort", abort);
                    resolve(release);
                },
            };

            signal.addEventListener("abort", abort, { once: true });
            this.#queue.push(item);
        });
    }

    #makeRelease(): () => void {
        let released = false;
        return (): void => {
            if (released) return;

            released = true;
            this.#active -= 1;
            while (this.#queue.length > 0) {
                const next = this.#queue.shift();
                if (next === undefined || next.signal.aborted) continue;
                this.#active += 1;
                next.start(this.#makeRelease());
                break;
            }
        };
    }
}

function validatePositiveInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`${name} must be a positive integer`);
}

/** Owns provider work, scoped caches, refresh resources, cancellation, and safe diagnostics. */
export function createSourceController<const Options extends SourceControllerOptions>(
    provider: Provider,
    options: ScopedSourceControllerOptions<Options>,
): SourceController {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    const debounceMs = options.debounceMs ?? 0;

    validatePositiveInteger(maxEntries, "maxEntries");
    validatePositiveInteger(maxConcurrent, "maxConcurrent");

    if (!Number.isFinite(debounceMs) || debounceMs < 0)
        throw new Error("debounceMs must be non-negative");

    if (
        options.cacheTtlMs !== undefined &&
        (!Number.isFinite(options.cacheTtlMs) || options.cacheTtlMs < 0)
    ) {
        throw new Error("cacheTtlMs must be non-negative");
    }

    if (
        options.persistentCachePath !== undefined &&
        (options.configurationKey === undefined || options.configurationKey.length === 0)
    ) {
        throw new Error("configurationKey is required for persistentCachePath");
    }

    const cacheEnabled = options.cache === true;
    let discoveryLimit = PROVIDER_DISCOVERY_LIMIT;
    if (provider.filtering === "local") discoveryLimit = LOCAL_DISCOVERY_LIMIT;

    const now = options.now ?? Date.now;
    const lifetime = new AbortController();
    const limiter = new ConcurrencyLimiter(maxConcurrent);
    const cache = new Map<string, CacheEntry>();
    const failures = new Map<string, number>();
    const inFlight = new Map<string, SharedRequest>();
    const latestRequestByScope = new Map<string, LatestRequest>();
    const resolutionCache = new Map<string, ResolutionCacheEntry>();
    const resolutionInFlight = new Map<string, SharedResolution>();
    const watchers: FSWatcher[] = [];
    let generation = 0;
    let resolutionGeneration = 0;
    const isDisposed = (): boolean => lifetime.signal.aborted;
    const errorCodes = new Set<SourceControllerErrorCode>();
    const reportedErrorCodes = new Set<SourceControllerErrorCode>();
    let watchTimer: ReturnType<typeof setTimeout> | undefined;
    let persistenceWrite: Promise<void> = Promise.resolve();
    let disposal: Promise<void> | undefined;

    const scope = JSON.stringify([
        options.configurationKey ?? "",
        options.sourceId,
        options.cwd,
        options.trusted,
    ]);

    const keyFor = (request: CachedRequest): string => {
        let query = "";
        if (provider.filtering === "provider") query = request.query;

        return JSON.stringify([
            scope,
            request.path.map((candidate) => candidate.id),
            query,
            request.cursor ?? "",
        ]);
    };

    const requestScopeFor = (request: CachedRequest): string =>
        JSON.stringify([
            scope,
            request.path.map((candidate) => candidate.id),
            request.cursor ?? "",
        ]);

    const resolutionKeyFor = (segments: readonly string[]): string =>
        JSON.stringify([scope, segments]);

    const recordError = (code: SourceControllerErrorCode): void => {
        errorCodes.add(code);

        if (reportedErrorCodes.has(code)) return;

        reportedErrorCodes.add(code);
        options.onError?.(ERROR_MESSAGE_BY_CODE[code]);
    };

    const reportError = (code: SourceControllerErrorCode): void => {
        if (isDisposed()) return;

        recordError(code);
    };

    const clearError = (code: SourceControllerErrorCode): void => {
        errorCodes.delete(code);
        reportedErrorCodes.delete(code);
    };

    const touch = (key: string, entry: CacheEntry): void => {
        cache.delete(key);
        cache.set(key, entry);
    };

    const trimCache = (): void => {
        while (cache.size > maxEntries) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) return;

            cache.delete(oldest);
        }
    };

    const touchResolution = (key: string, entry: ResolutionCacheEntry): void => {
        resolutionCache.delete(key);
        resolutionCache.set(key, entry);
    };

    const trimResolutionCache = (): void => {
        while (resolutionCache.size > maxEntries) {
            const oldest = resolutionCache.keys().next().value;
            if (oldest === undefined) return;

            resolutionCache.delete(oldest);
        }
    };

    const trimAuxiliary = <Value>(entries: Map<string, Value>): void => {
        while (entries.size > maxEntries) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined) return;

            entries.delete(oldest);
        }
    };

    const failureRetryAt = (key: string, currentTime: number): number | undefined => {
        const retryAt = failures.get(key);
        if (retryAt === undefined) return undefined;

        if (retryAt <= currentTime) {
            failures.delete(key);
            return undefined;
        }

        failures.delete(key);
        failures.set(key, retryAt);

        return retryAt;
    };

    const rememberFailure = (key: string): void => {
        failures.delete(key);
        failures.set(key, now() + FAILED_RETRY_DELAY_MS);
        trimAuxiliary(failures);
    };

    const latestRequestFor = (requestScope: string, currentTime: number): string | undefined => {
        const latest = latestRequestByScope.get(requestScope);
        if (latest === undefined) return undefined;

        if (latest.expiresAt <= currentTime) {
            latestRequestByScope.delete(requestScope);
            return undefined;
        }

        latestRequestByScope.delete(requestScope);
        latestRequestByScope.set(requestScope, latest);

        return latest.key;
    };

    const rememberLatestRequest = (requestScope: string, key: string): void => {
        latestRequestByScope.delete(requestScope);
        latestRequestByScope.set(requestScope, {
            key,
            expiresAt: now() + AUXILIARY_ENTRY_TTL_MS,
        });
        trimAuxiliary(latestRequestByScope);
    };

    const pruneAuxiliary = (currentTime: number): void => {
        for (const [key, retryAt] of failures) {
            if (retryAt <= currentTime) failures.delete(key);
        }

        for (const [requestScope, latest] of latestRequestByScope) {
            if (latest.expiresAt <= currentTime) latestRequestByScope.delete(requestScope);
        }
    };

    const persistedDocument = (): PersistedDocument => ({
        version: PERSISTENCE_VERSION,
        scope,
        entries: [...cache].map(([key, entry]) => ({ key, ...entry })),
    });

    const savePersistence = (): void => {
        const path = options.persistentCachePath;
        if (!cacheEnabled || path === undefined || isDisposed()) return;

        const expectedGeneration = generation;
        const contents = JSON.stringify(persistedDocument());
        if (Buffer.byteLength(contents) > MAX_PERSISTENCE_BYTES) {
            reportError("persistence-failed");
            return;
        }

        const writeSnapshot = async (): Promise<void> => {
            if (isDisposed() || expectedGeneration !== generation) return;

            await mkdir(dirname(path), { recursive: true });

            const temporaryPath = `${path}.${randomUUID()}.tmp`;

            try {
                await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });

                if (isDisposed() || expectedGeneration !== generation) return;

                await rename(temporaryPath, path);

                if (!isDisposed() && expectedGeneration === generation)
                    clearError("persistence-failed");
            } finally {
                await rm(temporaryPath, { force: true });
            }
        };

        const previousWrite = persistenceWriters.get(path) ?? Promise.resolve();

        persistenceWrite = previousWrite.then(writeSnapshot, writeSnapshot).catch(() => {
            if (!isDisposed() && expectedGeneration === generation)
                reportError("persistence-failed");
        });
        persistenceWriters.set(path, persistenceWrite);

        const currentWrite = persistenceWrite;

        void currentWrite.then(() => {
            if (persistenceWriters.get(path) === currentWrite) persistenceWriters.delete(path);
        });
    };

    const loadPersistence = async (): Promise<void> => {
        const path = options.persistentCachePath;
        if (!cacheEnabled || path === undefined) return;

        const expectedGeneration = generation;

        try {
            const text = await readPersistence(path);

            if (isDisposed() || expectedGeneration !== generation) return;

            const value = Value.Parse(persistedDocumentSchema, JSON.parse(text));
            if (value.scope !== scope) throw new Error("invalid persistent cache scope");

            for (const entry of value.entries.slice(-maxEntries)) {
                if (entry.key !== keyFor(entry.request))
                    throw new Error("invalid persistent cache scope");

                cache.set(entry.key, {
                    request: entry.request,
                    response: entry.response,
                    expiresAt: entry.expiresAt,
                    cachedAt: entry.cachedAt,
                });
            }

            clearError("persistence-failed");
        } catch (cause: unknown) {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;

            reportError("persistence-failed");
        }
    };
    const persistenceReady = loadPersistence();

    const runDiscovery = async (
        request: CachedRequest,
        signal: AbortSignal,
        expectedGeneration: number,
    ): Promise<DiscoveryResponse> => {
        await waitForDelay(debounceMs, signal);

        let discoveryRequest: DiscoveryRequest;
        if (request.cursor === undefined) {
            discoveryRequest = {
                sourceId: options.sourceId,
                cwd: options.cwd,
                trusted: options.trusted,
                query: request.query,
                path: request.path,
                limit: discoveryLimit,
                signal,
            };
        } else {
            discoveryRequest = {
                sourceId: options.sourceId,
                cwd: options.cwd,
                trusted: options.trusted,
                query: request.query,
                path: request.path,
                limit: discoveryLimit,
                cursor: request.cursor,
                signal,
            };
        }

        const response = await limiter.run(signal, async () => provider.discover(discoveryRequest));
        signal.throwIfAborted();
        if (isDisposed() || expectedGeneration !== generation) throw abortCause(lifetime.signal);

        const parsed = validateDiscoveryResponse(response, discoveryLimit);

        clearError("discovery-failed");

        return parsed;
    };

    const startShared = (key: string, request: CachedRequest): SharedRequest => {
        const current = inFlight.get(key);
        if (current !== undefined && !current.controller.signal.aborted) return current;

        const controller = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, controller.signal]);
        const expectedGeneration = generation;
        const shared: SharedRequest = {
            controller,
            waiters: 0,
            settled: false,
            promise: Promise.resolve({ items: [] }),
        };

        shared.promise = runDiscovery(request, signal, expectedGeneration)
            .then((response) => {
                if (cacheEnabled && !isDisposed() && expectedGeneration === generation) {
                    const cachedAt = now();
                    let expiresAt = Number.MAX_SAFE_INTEGER;
                    if (options.cacheTtlMs !== undefined) expiresAt = cachedAt + options.cacheTtlMs;

                    const entry: CacheEntry = {
                        request,
                        response,
                        expiresAt,
                        cachedAt,
                    };
                    touch(key, entry);
                    trimCache();
                    savePersistence();
                }

                failures.delete(key);

                return response;
            })
            .catch((cause: unknown) => {
                if (!signal.aborted && !isDisposed() && expectedGeneration === generation) {
                    rememberFailure(key);
                    reportError("discovery-failed");
                }

                throw cause;
            })
            .finally(() => {
                shared.settled = true;
                if (inFlight.get(key) === shared) inFlight.delete(key);
            });
        inFlight.set(key, shared);

        return shared;
    };

    const runResolution = async (
        segments: readonly string[],
        signal: AbortSignal,
        expectedResolutionGeneration: number,
    ): Promise<Resolution> => {
        const resolution = await limiter.run(signal, async () =>
            provider.resolve({
                sourceId: options.sourceId,
                cwd: options.cwd,
                trusted: options.trusted,
                segments,
                signal,
            }),
        );

        signal.throwIfAborted();

        if (isDisposed() || expectedResolutionGeneration !== resolutionGeneration)
            throw abortCause(lifetime.signal);

        const parsed = parseResolution(resolution);

        clearError("resolution-failed");

        return parsed;
    };

    const startSharedResolution = (key: string, segments: readonly string[]): SharedResolution => {
        const current = resolutionInFlight.get(key);
        if (current !== undefined && !current.controller.signal.aborted) return current;

        const controller = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, controller.signal]);
        const expectedResolutionGeneration = resolutionGeneration;
        const shared: SharedResolution = {
            controller,
            waiters: 0,
            settled: false,
            promise: Promise.resolve({ status: "unresolved", reason: "" }),
        };

        shared.promise = runResolution(segments, signal, expectedResolutionGeneration)
            .then((resolution) => {
                if (
                    cacheEnabled &&
                    resolution.status === "resolved" &&
                    !isDisposed() &&
                    expectedResolutionGeneration === resolutionGeneration
                ) {
                    const cachedAt = now();
                    let expiresAt = Number.MAX_SAFE_INTEGER;
                    if (options.cacheTtlMs !== undefined) expiresAt = cachedAt + options.cacheTtlMs;
                    touchResolution(key, { resolution, expiresAt, cachedAt });
                    trimResolutionCache();
                }

                return resolution;
            })
            .catch((cause: unknown) => {
                if (
                    !signal.aborted &&
                    !isDisposed() &&
                    expectedResolutionGeneration === resolutionGeneration
                ) {
                    reportError("resolution-failed");
                }

                throw cause;
            })
            .finally(() => {
                shared.settled = true;
                if (resolutionInFlight.get(key) === shared) resolutionInFlight.delete(key);
            });
        resolutionInFlight.set(key, shared);

        return shared;
    };

    const awaitShared = async <Result>(
        shared: SharedWork<Result>,
        signal?: AbortSignal,
    ): Promise<Result> => {
        if (signal?.aborted === true) return Promise.reject(abortCause(signal));

        shared.waiters += 1;

        let finished = false;
        const finish = (): void => {
            if (finished) return;

            finished = true;
            shared.waiters -= 1;
            if (shared.waiters === 0 && !shared.settled) shared.controller.abort();
        };

        return new Promise((resolve, reject) => {
            const abort = (): void => {
                signal?.removeEventListener("abort", abort);
                finish();

                if (signal !== undefined) reject(abortCause(signal));
            };

            signal?.addEventListener("abort", abort, { once: true });
            shared.promise.then(
                (response) => {
                    signal?.removeEventListener("abort", abort);

                    if (finished) return;

                    finish();
                    resolve(response);
                },
                (cause: unknown) => {
                    signal?.removeEventListener("abort", abort);

                    if (finished) return;

                    finish();

                    if (cause instanceof Error) reject(cause);
                    else reject(new Error("Mention source operation failed.", { cause }));
                },
            );
        });
    };

    const backgroundRefresh = (key: string, request: CachedRequest): void => {
        const shared = startShared(key, request);
        shared.waiters += 1;
        shared.promise.then(
            () => {
                shared.waiters -= 1;
            },
            () => {
                shared.waiters -= 1;
            },
        );
    };

    const discover = async (request: SourceControllerDiscovery): Promise<DiscoveryResponse> => {
        if (isDisposed()) throw new Error("source controller is disposed");

        request.signal?.throwIfAborted();
        await persistenceReady;

        if (isDisposed()) throw new Error("source controller is disposed");

        request.signal?.throwIfAborted();
        let cachedRequest: CachedRequest;
        if (request.cursor === undefined) {
            cachedRequest = { query: request.query, path: request.path };
        } else {
            cachedRequest = { query: request.query, path: request.path, cursor: request.cursor };
        }

        const key = keyFor(cachedRequest);
        const requestScope = requestScopeFor(cachedRequest);
        const currentTime = now();
        const previousKey = latestRequestFor(requestScope, currentTime);
        if (previousKey !== undefined && previousKey !== key) {
            const previous = inFlight.get(previousKey);
            if (previous !== undefined && previous.waiters <= 1) previous.controller.abort();
        }

        rememberLatestRequest(requestScope, key);

        if (cacheEnabled) {
            const entry = cache.get(key);
            if (entry !== undefined) {
                touch(key, entry);

                if (
                    currentTime >= entry.expiresAt &&
                    failureRetryAt(key, currentTime) === undefined
                ) {
                    backgroundRefresh(key, cachedRequest);
                }

                return entry.response;
            }
        }

        if (failureRetryAt(key, currentTime) !== undefined) {
            throw new Error("mention source discovery is temporarily unavailable");
        }

        return awaitShared(startShared(key, cachedRequest), request.signal);
    };

    const refreshRequests = async (requests: readonly CachedRequest[]): Promise<void> => {
        const unique = new Map<string, CachedRequest>();
        for (const request of requests) unique.set(keyFor(request), request);
        const settled = await Promise.allSettled(
            [...unique].map(async ([key, request]) => awaitShared(startShared(key, request))),
        );
        for (const result of settled) {
            if (result.status === "rejected" && isDisposed()) return;
        }
    };

    const refresh = async (): Promise<void> => {
        await persistenceReady;

        if (isDisposed()) return;

        const requests = [...cache.values()].map((entry) => entry.request);
        if (requests.length === 0) requests.push({ query: "", path: [] });

        for (const shared of resolutionInFlight.values()) shared.controller.abort();
        resolutionInFlight.clear();
        resolutionGeneration += 1;
        resolutionCache.clear();
        await refreshRequests(requests);
    };

    const invalidate = (): void => {
        if (isDisposed()) return;

        generation += 1;
        resolutionGeneration += 1;

        for (const shared of inFlight.values()) shared.controller.abort();
        inFlight.clear();

        for (const shared of resolutionInFlight.values()) shared.controller.abort();
        resolutionInFlight.clear();
        cache.clear();
        resolutionCache.clear();
        failures.clear();
        latestRequestByScope.clear();
        savePersistence();
    };

    let interval: ReturnType<typeof setInterval> | undefined;
    if (cacheEnabled && options.refreshIntervalMs !== undefined && options.refreshIntervalMs > 0) {
        interval = setInterval(() => {
            refresh().catch(() => reportError("discovery-failed"));
        }, options.refreshIntervalMs);
    }

    interval?.unref();

    if (cacheEnabled) {
        const namesByParent = new Map<string, Set<string>>();
        for (const file of options.watchFiles ?? []) {
            const resolvedFile = resolveWatchFilePath(file, options.cwd);
            const parent = dirname(resolvedFile);
            let names = namesByParent.get(parent);
            if (names === undefined) {
                names = new Set();
                namesByParent.set(parent, names);
            }

            names.add(basename(resolvedFile));
        }

        for (const [parent, names] of namesByParent) {
            try {
                const fileWatcher = watch(parent, (_eventType, filename) => {
                    if (filename !== null && !names.has(filename)) return;

                    clearTimeout(watchTimer);
                    watchTimer = setTimeout(invalidate, debounceMs);
                });

                fileWatcher.on("error", () => reportError("persistence-failed"));
                watchers.push(fileWatcher);
            } catch {
                reportError("persistence-failed");
            }
        }
    }

    return {
        discover,
        async resolve(segments, signal) {
            if (isDisposed()) throw new Error("source controller is disposed");

            signal?.throwIfAborted();
            const stableSegments = [...segments];
            const key = resolutionKeyFor(stableSegments);
            if (cacheEnabled) {
                const entry = resolutionCache.get(key);
                if (entry !== undefined) {
                    if (now() < entry.expiresAt) {
                        touchResolution(key, entry);
                        return entry.resolution;
                    }

                    resolutionCache.delete(key);
                }
            }

            return awaitShared(startSharedResolution(key, stableSegments), signal);
        },
        async warm() {
            await persistenceReady;

            if (!cacheEnabled || options.refreshOnStartup !== true || isDisposed()) return;
            try {
                await discover({ query: "", path: [] });
            } catch {
                // Discovery owns the safe diagnostic; warming must not delay startup with a rejection.
            }
        },
        refresh,
        invalidate,
        status() {
            const currentTime = now();
            pruneAuxiliary(currentTime);

            let oldestCacheAgeMs: number | undefined;
            let cachedCandidates = 0;
            for (const entry of cache.values()) {
                cachedCandidates += entry.response.items.length;

                const age = Math.max(0, currentTime - entry.cachedAt);
                if (oldestCacheAgeMs === undefined || age > oldestCacheAgeMs)
                    oldestCacheAgeMs = age;
            }

            return {
                cachedEntries: cache.size,
                cachedCandidates,
                inFlightRequests: inFlight.size + resolutionInFlight.size,
                queuedRequests: limiter.queued,
                failedRequestKeys: failures.size,
                latestRequestScopes: latestRequestByScope.size,
                oldestCacheAgeMs,
                errorCodes: [...errorCodes].sort(),
            };
        },
        async dispose() {
            if (disposal !== undefined) return disposal;

            generation += 1;
            resolutionGeneration += 1;
            lifetime.abort();

            for (const shared of inFlight.values()) shared.controller.abort();
            inFlight.clear();

            for (const shared of resolutionInFlight.values()) shared.controller.abort();
            resolutionInFlight.clear();
            resolutionCache.clear();
            failures.clear();
            clearInterval(interval);
            latestRequestByScope.clear();
            clearTimeout(watchTimer);

            for (const fileWatcher of watchers) fileWatcher.close();
            watchers.length = 0;
            disposal = Promise.resolve().then(async () => {
                try {
                    await provider.dispose?.();
                } catch {
                    recordError("provider-disposal-failed");
                }
            });

            return disposal;
        },
    };
}
