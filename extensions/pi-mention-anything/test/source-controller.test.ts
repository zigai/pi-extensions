import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, vi } from "vitest";

import {
    parseCandidate,
    type Candidate,
    type DiscoveryResponse,
    type JsonValue,
    type Provider,
    type Resolution,
} from "../src/source-contract.ts";
import { createSourceController } from "../src/source-controller.ts";

const candidate = (id: string): Candidate => ({
    id,
    label: id,
    segment: id,
    selectable: true,
    navigable: false,
});

type Deferred<T> = {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (cause?: Error) => void;
};

function deferred<T>(): Deferred<T> {
    let resolveDeferred = (_value: T): void => {
        throw new Error("deferred resolver was not initialized");
    };

    let rejectDeferred = (_cause?: Error): void => {
        throw new Error("deferred rejecter was not initialized");
    };

    const promise = new Promise<T>((resolve, reject) => {
        resolveDeferred = resolve;
        rejectDeferred = reject;
    });

    return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

function unresolvedProvider(discover: Provider["discover"]): Provider {
    return {
        filtering: "provider",
        discover,
        async resolve() {
            return { status: "unresolved", reason: "missing" };
        },
    };
}

test("candidate parsing rejects empty, disabled, oversized, and deeply nested values", () => {
    const valid = candidate("valid");
    for (const invalid of [
        { ...valid, id: "" },
        { ...valid, label: "" },
        { ...valid, segment: "" },
        { ...valid, id: "i".repeat(4097) },
        { ...valid, description: "d".repeat(16_385) },
        { ...valid, selectable: false, navigable: false },
        { ...valid, data: Array.from({ length: 257 }, () => null) },
    ]) {
        assert.throws(() => parseCandidate(invalid));
    }

    assert.equal(
        parseCandidate({ ...valid, replacement: "context".repeat(5000) }).replacement?.length,
        35000,
    );
    let nestedData: JsonValue = null;
    for (let depth = 0; depth < 9; depth += 1) nestedData = [nestedData];
    assert.throws(() => parseCandidate({ ...valid, data: nestedData }));
});

test("resolved paths require navigable ancestors but allow nonselectable ancestors", async () => {
    const navigableAncestor: Candidate = {
        ...candidate("ancestor"),
        selectable: false,
        navigable: true,
    };
    const provider: Provider = {
        filtering: "provider",
        async discover() {
            return { items: [] };
        },
        async resolve(request) {
            const scenario = request.segments.at(0);
            if (scenario === "empty") return { status: "resolved", path: [] };

            if (scenario === "blocked") {
                return {
                    status: "resolved",
                    path: [candidate("blocked-ancestor"), candidate("leaf")],
                };
            }

            if (scenario === "long") {
                const path = Array.from({ length: 65 }, (_unused, index) => ({
                    ...navigableAncestor,
                    id: String(index),
                    label: String(index),
                    segment: String(index),
                }));

                return { status: "resolved", path };
            }

            return {
                status: "resolved",
                path: [navigableAncestor, candidate("leaf")],
            };
        },
    };
    const controller = createSourceController(provider, {
        sourceId: "resolution-invariants",
        cwd: "/tmp",
        trusted: true,
    });

    await assert.rejects(controller.resolve(["empty"]));
    await assert.rejects(controller.resolve(["blocked"]), /ancestor at index 0 must be navigable/);
    await assert.rejects(controller.resolve(["long"]));
    assert.deepEqual(await controller.resolve(["allowed"]), {
        status: "resolved",
        path: [navigableAncestor, candidate("leaf")],
    });
    await controller.dispose();
});

test("equivalent requests share work while each waiter owns cancellation", async () => {
    const result = deferred<DiscoveryResponse>();
    let calls = 0;
    let providerSignal: AbortSignal | undefined;
    const provider = unresolvedProvider(async (request) => {
        calls += 1;
        providerSignal = request.signal;
        return result.promise;
    });
    const controller = createSourceController(provider, {
        sourceId: "shared",
        cwd: "/tmp",
        trusted: true,
    });
    const firstSignal = new AbortController();
    const first = controller.discover({ query: "a", path: [], signal: firstSignal.signal });
    const second = controller.discover({ query: "a", path: [] });
    await Promise.resolve();
    await Promise.resolve();

    const firstRejection = assert.rejects(first, { name: "AbortError" });
    firstSignal.abort();
    await firstRejection;
    assert.equal(providerSignal?.aborted, false);
    result.resolve({ items: [candidate("ready")] });
    assert.deepEqual(await second, { items: [candidate("ready")] });
    assert.equal(calls, 1);
    await controller.dispose();
});

test("equivalent exact resolutions share work and resolved paths expire with cache scope", async () => {
    let clock = 0;
    let calls = 0;
    let providerSignal: AbortSignal | undefined;
    const firstResult = deferred<Resolution>();
    const provider: Provider = {
        filtering: "provider",
        async discover() {
            return assert.fail("exact resolution must not run discovery or pagination");
        },
        async resolve(request) {
            calls += 1;
            providerSignal = request.signal;

            if (calls === 1) return firstResult.promise;
            return Promise.resolve({
                status: "resolved",
                path: [candidate(request.segments.join("/"))],
            });
        },
    };
    const controller = createSourceController(provider, {
        sourceId: "exact-shared",
        cwd: "/tmp",
        trusted: true,
        cache: true,
        cacheTtlMs: 100,
        now: () => clock,
    });
    const firstSignal = new AbortController();
    const first = controller.resolve(["parent"], firstSignal.signal);
    const second = controller.resolve(["parent"]);
    await vi.waitFor(() => {
        assert.equal(calls, 1);
        assert.equal(controller.status().inFlightRequests, 1);
    });

    const firstRejection = assert.rejects(first, { name: "AbortError" });
    firstSignal.abort();
    await firstRejection;
    assert.equal(providerSignal?.aborted, false);

    const resolved: Resolution = {
        status: "resolved",
        path: [candidate("parent")],
    };
    firstResult.resolve(resolved);
    assert.deepEqual(await second, resolved);
    assert.deepEqual(await controller.resolve(["parent"]), resolved);
    assert.equal(calls, 1);
    clock = 100;
    assert.deepEqual(await controller.resolve(["parent"]), resolved);
    assert.equal(calls, 2);
    controller.invalidate();
    assert.deepEqual(await controller.resolve(["parent"]), resolved);
    assert.equal(calls, 3);
    await controller.dispose();
});

test("exact resolution cache is bounded and never retains unresolved results", async () => {
    let calls = 0;
    const provider: Provider = {
        filtering: "provider",
        async discover() {
            return assert.fail("exact resolution must remain independent from discovery");
        },
        async resolve(request) {
            calls += 1;
            const segment = request.segments.at(0);
            if (segment === "missing") return { status: "unresolved", reason: "missing" };

            return { status: "resolved", path: [candidate(segment ?? "")] };
        },
    };
    const controller = createSourceController(provider, {
        sourceId: "exact-lru",
        cwd: "/tmp",
        trusted: true,
        cache: true,
        maxEntries: 2,
    });

    await controller.resolve(["one"]);
    await controller.resolve(["two"]);
    await controller.resolve(["three"]);
    await controller.resolve(["one"]);
    assert.equal(calls, 4);

    assert.deepEqual(await controller.resolve(["missing"]), {
        status: "unresolved",
        reason: "missing",
    });
    assert.deepEqual(await controller.resolve(["missing"]), {
        status: "unresolved",
        reason: "missing",
    });
    assert.equal(calls, 6);
    await controller.dispose();
});

test("local providers receive the enumerable limit before local filtering", async () => {
    const items = Array.from({ length: 101 }, (_unused, index) => {
        const item = candidate(String(index));
        if (index === 0) return { ...item, insertionText: "inserted target" };
        return item;
    });
    let receivedLimit = 0;
    const localProvider: Provider = {
        filtering: "local",
        async discover(request) {
            receivedLimit = request.limit;
            return { items };
        },
        async resolve() {
            return { status: "unresolved", reason: "missing" };
        },
    };
    const local = createSourceController(localProvider, {
        sourceId: "local",
        cwd: "/tmp",
        trusted: true,
        cache: true,
    });
    const localResult = await local.discover({ query: "", path: [] });
    assert.equal(localResult.items.length, 101);
    assert.equal(localResult.items[0]?.insertionText, "inserted target");
    assert.equal(receivedLimit, 10_000);
    assert.equal(local.status().cachedCandidates, 101);
    await local.dispose();

    let remoteLimit = 0;
    const providerRanked = unresolvedProvider(async (request) => {
        remoteLimit = request.limit;
        return Promise.resolve({ items });
    });
    const remote = createSourceController(providerRanked, {
        sourceId: "remote",
        cwd: "/tmp",
        trusted: true,
    });
    await assert.rejects(remote.discover({ query: "", path: [] }), /result limit/);
    assert.equal(remoteLimit, 100);
    await remote.dispose();
});

test("injected time deterministically drives TTL refresh and safe cache ages", async () => {
    let clock = 0;
    const refresh = deferred<DiscoveryResponse>();
    let calls = 0;
    const provider = unresolvedProvider(async () => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ items: [candidate("old")] });
        return refresh.promise;
    });
    const controller = createSourceController(provider, {
        sourceId: "ttl",
        cwd: "/tmp",
        trusted: true,
        cache: true,
        cacheTtlMs: 100,
        now: () => clock,
    });
    assert.deepEqual(await controller.discover({ query: "x", path: [] }), {
        items: [candidate("old")],
    });
    assert.deepEqual(controller.status(), {
        cachedEntries: 1,
        cachedCandidates: 1,
        inFlightRequests: 0,
        queuedRequests: 0,
        failedRequestKeys: 0,
        latestRequestScopes: 1,
        oldestCacheAgeMs: 0,
        errorCodes: [],
    });

    clock = 100;
    assert.deepEqual(await controller.discover({ query: "x", path: [] }), {
        items: [candidate("old")],
    });
    assert.deepEqual(await controller.discover({ query: "x", path: [] }), {
        items: [candidate("old")],
    });
    await Promise.resolve();
    assert.equal(calls, 2);
    assert.equal(controller.status().oldestCacheAgeMs, 100);
    refresh.resolve({ items: [candidate("new")] });
    await controller.refresh();
    assert.deepEqual(await controller.discover({ query: "x", path: [] }), {
        items: [candidate("new")],
    });
    assert.equal(controller.status().oldestCacheAgeMs, 0);
    await controller.dispose();
});

test("a newer query cancels unshared work in the same scope", async () => {
    let obsoleteSignal: AbortSignal | undefined;
    const provider = unresolvedProvider(async (request) => {
        if (request.query === "new") return Promise.resolve({ items: [candidate("new")] });

        obsoleteSignal = request.signal;

        return new Promise((_resolve, reject) => {
            request.signal.addEventListener(
                "abort",
                () => {
                    assert.ok(request.signal.reason instanceof Error);
                    reject(request.signal.reason);
                },
                { once: true },
            );
        });
    });
    const controller = createSourceController(provider, {
        sourceId: "superseded",
        cwd: "/tmp",
        trusted: true,
    });
    const obsolete = controller.discover({ query: "old", path: [] });
    const obsoleteRejection = assert.rejects(obsolete, { name: "AbortError" });
    await vi.waitFor(() => {
        assert.ok(obsoleteSignal !== undefined);
    });
    assert.deepEqual(await controller.discover({ query: "new", path: [] }), {
        items: [candidate("new")],
    });
    await obsoleteRejection;
    const receivedSignal = obsoleteSignal;
    if (receivedSignal === undefined) assert.fail("provider did not receive cancellation");
    assert.equal(receivedSignal.aborted, true);
    await controller.dispose();
});

test("cache uses bounded LRU scopes and discovery uses bounded concurrency", async () => {
    let calls = 0;
    const cacheProvider = unresolvedProvider(async (request) => {
        calls += 1;
        return Promise.resolve({ items: [candidate(request.query)] });
    });
    const cached = createSourceController(cacheProvider, {
        sourceId: "lru",
        cwd: "/tmp",
        trusted: true,
        cache: true,
        maxEntries: 2,
    });
    await cached.discover({ query: "one", path: [] });
    await cached.discover({ query: "two", path: [] });
    await cached.discover({ query: "three", path: [] });
    assert.equal(cached.status().cachedEntries, 2);
    await cached.discover({ query: "one", path: [] });
    assert.equal(calls, 4);
    await cached.dispose();

    const pending = [
        deferred<DiscoveryResponse>(),
        deferred<DiscoveryResponse>(),
        deferred<DiscoveryResponse>(),
    ];

    let active = 0;
    let peak = 0;
    let index = 0;
    const limitedProvider = unresolvedProvider(async () => {
        const current = pending.at(index);
        index += 1;

        if (current === undefined) assert.fail("unexpected provider call");
        active += 1;
        peak = Math.max(peak, active);
        const response = await current.promise;
        active -= 1;
        return response;
    });
    const limited = createSourceController(limitedProvider, {
        sourceId: "limited",
        cwd: "/tmp",
        trusted: true,
        maxConcurrent: 2,
    });
    const requests = ["one", "two", "three"].map(async (query) =>
        limited.discover({ query, path: [candidate(`scope-${query}`)] }),
    );
    await vi.waitFor(() => {
        assert.equal(active, 2);
        assert.equal(limited.status().queuedRequests, 1);
    });
    pending[0]?.resolve({ items: [] });
    await vi.waitFor(() => {
        assert.equal(active, 2);
    });
    pending[1]?.resolve({ items: [] });
    pending[2]?.resolve({ items: [] });
    await Promise.all(requests);
    assert.equal(peak, 2);
    await limited.dispose();
});

test("invalid output reports one safe diagnostic and disposal rejects stale completion", async () => {
    const diagnostics: string[] = [];
    const invalid = unresolvedProvider(async () =>
        Promise.resolve({ items: [candidate("duplicate"), candidate("duplicate")] }),
    );
    const invalidController = createSourceController(invalid, {
        sourceId: "secret-source-name",
        cwd: "/secret/project",
        trusted: true,
        onError: (message) => diagnostics.push(message),
    });
    await assert.rejects(
        invalidController.discover({ query: "secret-query", path: [] }),
        /duplicate/,
    );
    assert.deepEqual(diagnostics, ["Mention source discovery failed."]);
    assert.deepEqual(invalidController.status(), {
        cachedEntries: 0,
        cachedCandidates: 0,
        inFlightRequests: 0,
        queuedRequests: 0,
        oldestCacheAgeMs: undefined,
        failedRequestKeys: 1,
        latestRequestScopes: 1,
        errorCodes: ["discovery-failed"],
    });
    await invalidController.dispose();

    const late = deferred<DiscoveryResponse>();
    let signal: AbortSignal | undefined;
    const provider = unresolvedProvider(async (request) => {
        signal = request.signal;
        return late.promise;
    });
    const controller = createSourceController(provider, {
        sourceId: "late",
        cwd: "/tmp",
        trusted: true,
        cache: true,
        onError: () => assert.fail("disposed completion emitted a diagnostic"),
    });
    const discovery = controller.discover({ query: "", path: [] });
    const rejection = assert.rejects(discovery);
    await vi.waitFor(() => {
        assert.ok(signal !== undefined);
    });
    await controller.dispose();
    assert.equal(signal?.aborted, true);
    late.resolve({ items: [candidate("late")] });
    await rejection;
    assert.equal(controller.status().cachedEntries, 0);
});

test("warm and periodic refresh only start when caching is enabled", async () => {
    vi.useFakeTimers();
    try {
        let uncachedCalls = 0;
        const uncached = createSourceController(
            unresolvedProvider(async () => {
                uncachedCalls += 1;
                return Promise.resolve({ items: [] });
            }),
            {
                sourceId: "uncached",
                cwd: "/tmp",
                trusted: true,
                refreshOnStartup: true,
                refreshIntervalMs: 5,
            },
        );
        await uncached.warm();
        await vi.advanceTimersByTimeAsync(20);
        assert.equal(uncachedCalls, 0);
        await uncached.dispose();

        let cachedCalls = 0;
        const cached = createSourceController(
            unresolvedProvider(async () => {
                cachedCalls += 1;
                return Promise.resolve({ items: [] });
            }),
            {
                sourceId: "cached",
                cwd: "/tmp",
                trusted: true,
                cache: true,
                refreshOnStartup: true,
                refreshIntervalMs: 5,
            },
        );
        await cached.warm();
        assert.equal(cachedCalls, 1);
        await vi.advanceTimersByTimeAsync(5);
        assert.equal(cachedCalls, 2);
        await cached.dispose();
    } finally {
        vi.useRealTimers();
    }
});

test("persistent input is bounded and disposed loads cannot change state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mention-persistence-bounds-"));
    const cachePath = join(directory, "cache.json");
    try {
        await writeFile(cachePath, "");
        await truncate(cachePath, 8 * 1024 * 1024 + 1);
        const options = {
            sourceId: "bounded",
            cwd: directory,
            trusted: true,
            cache: true,
            persistentCachePath: cachePath,
            configurationKey: "v1",
        };
        const provider = unresolvedProvider(async () => ({ items: [] }));
        const source = createSourceController(provider, options);
        await source.warm();
        assert.deepEqual(source.status().errorCodes, ["persistence-failed"]);
        await source.dispose();
        const disposed = createSourceController(provider, options);
        await disposed.dispose();
        await disposed.warm();
        assert.equal(disposed.status().cachedEntries, 0);
        assert.deepEqual(disposed.status().errorCodes, []);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("persistent caches require a nonempty configuration key before starting resources", () => {
    assert.throws(
        () =>
            createSourceController(
                unresolvedProvider(async () => Promise.resolve({ items: [] })),
                {
                    sourceId: "persistent",
                    cwd: "/tmp",
                    trusted: true,
                    cache: true,
                    persistentCachePath: "/tmp/should-not-be-created.json",
                    configurationKey: "",
                },
            ),
        /^Error: configurationKey is required for persistentCachePath$/,
    );
});

test("file watching resolves cwd and home paths, observes atomic replacement, and restores persistence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mention-controller-"));
    const homeDirectory = await mkdtemp(join(homedir(), ".pi-mention-watch-"));
    const watchedPath = join(directory, "source.txt");
    const homeWatchedPath = join(homeDirectory, "source.txt");
    const cachePath = join(directory, "cache.json");
    await Promise.all([writeFile(watchedPath, "first"), writeFile(homeWatchedPath, "first")]);
    let calls = 0;
    const provider = unresolvedProvider(async () => {
        calls += 1;
        return Promise.resolve({ items: [candidate("persisted")] });
    });

    try {
        const controller = createSourceController(provider, {
            sourceId: "persistent",
            cwd: directory,
            trusted: false,
            configurationKey: "generation-1",
            cache: true,
            refreshOnStartup: true,
            watchFiles: ["source.txt", `~/${basename(homeDirectory)}/source.txt`],
            persistentCachePath: cachePath,
            debounceMs: 5,
            now: () => 500,
        });
        try {
            await controller.warm();
            assert.equal(calls, 1);
            await vi.waitFor(async () => {
                assert.match(await readFile(cachePath, "utf8"), /persisted/);
            });
            assert.deepEqual(controller.status(), {
                cachedEntries: 1,
                cachedCandidates: 1,
                inFlightRequests: 0,
                queuedRequests: 0,
                failedRequestKeys: 0,
                latestRequestScopes: 1,
                oldestCacheAgeMs: 0,
                errorCodes: [],
            });

            const relativeReplacement = `${watchedPath}.replacement`;
            await writeFile(relativeReplacement, "second");
            await rename(relativeReplacement, watchedPath);
            await vi.waitFor(() => {
                assert.deepEqual(controller.status(), {
                    cachedEntries: 0,
                    cachedCandidates: 0,
                    inFlightRequests: 0,
                    queuedRequests: 0,
                    failedRequestKeys: 0,
                    latestRequestScopes: 0,
                    oldestCacheAgeMs: undefined,
                    errorCodes: [],
                });
            });

            await controller.discover({ query: "", path: [] });
            const homeReplacement = `${homeWatchedPath}.replacement`;
            await writeFile(homeReplacement, "second");
            await rename(homeReplacement, homeWatchedPath);
            await vi.waitFor(() => {
                assert.deepEqual(controller.status(), {
                    cachedEntries: 0,
                    cachedCandidates: 0,
                    inFlightRequests: 0,
                    queuedRequests: 0,
                    failedRequestKeys: 0,
                    latestRequestScopes: 0,
                    oldestCacheAgeMs: undefined,
                    errorCodes: [],
                });
            });
            await controller.discover({ query: "", path: [] });
            await vi.waitFor(async () => {
                assert.match(await readFile(cachePath, "utf8"), /persisted/);
            });
        } finally {
            await controller.dispose();
        }

        const restored = createSourceController(
            unresolvedProvider(() => assert.fail("persistent cache should satisfy discovery")),
            {
                sourceId: "persistent",
                cwd: directory,
                trusted: false,
                configurationKey: "generation-1",
                cache: true,
                persistentCachePath: cachePath,
                now: () => 500,
            },
        );
        try {
            assert.deepEqual(await restored.discover({ query: "", path: [] }), {
                items: [candidate("persisted")],
            });
            assert.deepEqual(restored.status(), {
                cachedEntries: 1,
                cachedCandidates: 1,
                inFlightRequests: 0,
                queuedRequests: 0,
                failedRequestKeys: 0,
                latestRequestScopes: 1,
                oldestCacheAgeMs: 0,
                errorCodes: [],
            });
        } finally {
            await restored.dispose();
        }
    } finally {
        await Promise.all([
            rm(directory, { recursive: true, force: true }),
            rm(homeDirectory, { recursive: true, force: true }),
        ]);
    }
});

test("fresh same-key requests do not join aborted discovery or resolution work", async () => {
    let discoveryCalls = 0;
    let resolutionCalls = 0;
    let oldDiscoverySignal: AbortSignal | undefined;
    let oldResolutionSignal: AbortSignal | undefined;
    const oldDiscoveryResult = deferred<DiscoveryResponse>();
    const freshDiscoveryResult = deferred<DiscoveryResponse>();
    const oldResolutionResult = deferred<Resolution>();
    const freshResolutionResult = deferred<Resolution>();
    const provider: Provider = {
        filtering: "provider",
        async discover(request) {
            discoveryCalls += 1;
            if (discoveryCalls > 1) return freshDiscoveryResult.promise;

            oldDiscoverySignal = request.signal;
            return oldDiscoveryResult.promise;
        },
        async resolve(request) {
            resolutionCalls += 1;
            if (resolutionCalls > 1) return freshResolutionResult.promise;

            oldResolutionSignal = request.signal;
            return oldResolutionResult.promise;
        },
    };
    const controller = createSourceController(provider, {
        sourceId: "aborted-shared",
        cwd: "/tmp",
        trusted: true,
    });

    const discoveryAbort = new AbortController();
    const oldDiscovery = controller.discover({
        query: "same",
        path: [],
        signal: discoveryAbort.signal,
    });
    await vi.waitFor(() => {
        assert.equal(discoveryCalls, 1);
    });
    const oldDiscoveryRejection = assert.rejects(oldDiscovery, { name: "AbortError" });
    discoveryAbort.abort();
    await oldDiscoveryRejection;
    const freshDiscovery = controller.discover({ query: "same", path: [] });
    await vi.waitFor(() => {
        assert.equal(discoveryCalls, 2);
    });
    assert.equal(oldDiscoverySignal?.aborted, true);
    oldDiscoveryResult.reject(new Error("old discovery aborted"));
    await vi.waitFor(() => {
        assert.equal(controller.status().inFlightRequests, 1);
    });
    freshDiscoveryResult.resolve({ items: [candidate("fresh-discovery")] });
    assert.deepEqual(await freshDiscovery, {
        items: [candidate("fresh-discovery")],
    });

    const resolutionAbort = new AbortController();
    const oldResolution = controller.resolve(["same"], resolutionAbort.signal);
    await vi.waitFor(() => {
        assert.equal(resolutionCalls, 1);
    });
    const oldResolutionRejection = assert.rejects(oldResolution, { name: "AbortError" });
    resolutionAbort.abort();
    await oldResolutionRejection;
    const freshResolution = controller.resolve(["same"]);
    await vi.waitFor(() => {
        assert.equal(resolutionCalls, 2);
    });
    assert.equal(oldResolutionSignal?.aborted, true);
    oldResolutionResult.reject(new Error("old resolution aborted"));
    await vi.waitFor(() => {
        assert.equal(controller.status().inFlightRequests, 1);
    });
    freshResolutionResult.resolve({
        status: "resolved",
        path: [candidate("fresh-resolution")],
    });

    assert.deepEqual(await freshResolution, {
        status: "resolved",
        path: [candidate("fresh-resolution")],
    });
    await controller.dispose();
});

test("refresh invalidates cached and in-flight resolutions while retaining stale discovery", async () => {
    let resolutionVersion = "old";
    let discoveryShouldFail = false;
    let pendingResolutionCalls = 0;
    const delayedPendingRejection = deferred<Resolution>();
    const provider: Provider = {
        filtering: "provider",
        async discover() {
            if (discoveryShouldFail) throw new Error("refresh failed");
            return { items: [candidate("last-good")] };
        },
        async resolve(request) {
            const segment = request.segments.at(0) ?? "";
            if (segment === "pending") {
                pendingResolutionCalls += 1;
                if (pendingResolutionCalls === 1) return delayedPendingRejection.promise;
            }

            return Promise.resolve({
                status: "resolved",
                path: [candidate(`${resolutionVersion}-${segment}`)],
            });
        },
    };
    const controller = createSourceController(provider, {
        sourceId: "refresh-resolution",
        cwd: "/tmp",
        trusted: true,
        cache: true,
    });

    assert.deepEqual(await controller.discover({ query: "known", path: [] }), {
        items: [candidate("last-good")],
    });
    assert.deepEqual(await controller.resolve(["cached"]), {
        status: "resolved",
        path: [candidate("old-cached")],
    });
    const oldPending = controller.resolve(["pending"]);
    await vi.waitFor(() => {
        assert.equal(pendingResolutionCalls, 1);
    });
    const oldPendingRejection = assert.rejects(oldPending, /old resolution aborted/);

    resolutionVersion = "new";
    discoveryShouldFail = true;
    await controller.refresh();
    assert.deepEqual(await controller.discover({ query: "known", path: [] }), {
        items: [candidate("last-good")],
    });
    assert.deepEqual(await controller.resolve(["cached"]), {
        status: "resolved",
        path: [candidate("new-cached")],
    });
    assert.deepEqual(await controller.resolve(["pending"]), {
        status: "resolved",
        path: [candidate("new-pending")],
    });
    assert.equal(pendingResolutionCalls, 2);
    delayedPendingRejection.reject(new Error("old resolution aborted"));
    await oldPendingRejection;
    await controller.dispose();
});

test("failed request and latest-scope tracking are bounded LRU entries with expiry", async () => {
    let clock = 0;
    const controller = createSourceController(
        unresolvedProvider(async () => {
            throw new Error("unavailable");
        }),
        {
            sourceId: "bounded-auxiliary",
            cwd: "/tmp",
            trusted: true,
            maxEntries: 2,
            now: () => clock,
        },
    );

    for (const key of ["one", "two", "three"]) {
        await assert.rejects(
            controller.discover({ query: key, path: [candidate(`scope-${key}`)] }),
            /unavailable/,
        );
    }

    assert.equal(controller.status().failedRequestKeys, 2);
    assert.equal(controller.status().latestRequestScopes, 2);
    clock = 60_001;
    assert.equal(controller.status().failedRequestKeys, 0);
    assert.equal(controller.status().latestRequestScopes, 0);
    await controller.dispose();
});

test("provider disposal runs once and reports failures without leaking causes", async () => {
    const diagnostics: string[] = [];
    let disposeCalls = 0;
    const provider: Provider = {
        filtering: "provider",
        async discover() {
            return { items: [] };
        },
        async resolve() {
            return { status: "unresolved", reason: "missing" };
        },
        async dispose() {
            disposeCalls += 1;
            throw new Error("secret provider disposal cause");
        },
    };
    const controller = createSourceController(provider, {
        sourceId: "provider-disposal",
        cwd: "/secret/project",
        trusted: true,
        onError: (message) => diagnostics.push(message),
    });

    await Promise.all([controller.dispose(), controller.dispose()]);
    assert.equal(disposeCalls, 1);
    assert.deepEqual(diagnostics, ["Mention source provider disposal failed."]);
    assert.deepEqual(controller.status().errorCodes, ["provider-disposal-failed"]);
});

test("concurrent and repeated disposal disposes the provider once", async () => {
    let disposals = 0;
    const controller = createSourceController(
        {
            ...unresolvedProvider(async () => ({ items: [] })),
            dispose() {
                disposals += 1;
            },
        },
        { sourceId: "dispose-identity", cwd: "/tmp", trusted: true },
    );
    const first = controller.dispose();
    await Promise.all([first, controller.dispose()]);
    await controller.dispose();
    assert.equal(disposals, 1);
});

test("provider rejection preserves Errors and safely classifies non-Error causes", async () => {
    for (const reason of [
        new Error("provider detail"),
        new DOMException("cancelled", "AbortError"),
        { secret: "not-for-diagnostics" },
    ]) {
        const upstream = new AbortController();
        upstream.abort(reason);
        const diagnostics: string[] = [];
        const controller = createSourceController(
            unresolvedProvider(async () => {
                upstream.signal.throwIfAborted();
                return { items: [] };
            }),
            {
                sourceId: "failure-classification",
                cwd: "/tmp",
                trusted: true,
                onError: (message) => {
                    diagnostics.push(message);
                },
            },
        );
        await assert.rejects(controller.discover({ query: "", path: [] }), (cause) => {
            assert.ok(cause instanceof Error);

            if (reason instanceof Error) assert.equal(cause, reason);
            else {
                assert.equal(cause.message, "Mention source operation failed.");
                assert.equal(cause.cause, reason);
            }

            return true;
        });
        assert.ok(diagnostics.every((message) => !message.includes("not-for-diagnostics")));
        await controller.dispose();
    }
});
