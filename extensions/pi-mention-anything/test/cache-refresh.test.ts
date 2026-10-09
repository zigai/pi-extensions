import assert from "node:assert/strict";
import { test } from "vitest";
import { createListProvider } from "../src/list-provider.ts";
import { createSourceController } from "../src/source-controller.ts";
import type { Candidate } from "../src/source-contract.ts";

const items: readonly Candidate[] = [
    { id: "one", label: "host", segment: "host", selectable: true, navigable: false },
];

test("startup warming is opt in and requires caching for list providers too", async () => {
    let calls = 0;
    const provider = createListProvider(async () => {
        calls += 1;
        return items;
    });
    for (const options of [{}, { cache: false, refreshOnStartup: true }]) {
        const source = createSourceController(provider, {
            sourceId: "hosts",
            cwd: process.cwd(),
            trusted: true,
            ...options,
        });
        await source.warm();
        await source.dispose();
    }

    assert.equal(calls, 0);
});

test("failed refresh retains a successful empty list and backs off between retries", async () => {
    let now = 0;
    let calls = 0;
    const notices: string[] = [];
    const provider = createListProvider(async () => {
        calls += 1;
        if (calls === 2) throw new Error("private upstream failure");
        if (calls === 1) return [];
        return items;
    });
    const source = createSourceController(provider, {
        sourceId: "hosts",
        cwd: process.cwd(),
        trusted: true,
        cache: true,
        cacheTtlMs: 100,
        now: () => now,
        onError: (message) => notices.push(message),
    });
    assert.deepEqual((await source.discover({ query: "", path: [] })).items, []);
    now = 100;
    assert.deepEqual((await source.discover({ query: "", path: [] })).items, []);
    await source.refresh();
    assert.equal(calls, 2);

    for (let index = 0; index < 5; index += 1)
        assert.deepEqual((await source.discover({ query: "", path: [] })).items, []);

    assert.equal(calls, 2);
    assert.equal(notices.length, 1);
    assert.doesNotMatch(notices[0] ?? "", /private/);
    now = 1100;
    await source.discover({ query: "", path: [] });
    await source.refresh();
    assert.deepEqual((await source.discover({ query: "", path: [] })).items, items);
    assert.equal(calls, 3);
    await source.dispose();
});

test("warmup and first autocomplete share work while one waiter cancels", async () => {
    let resolveItems: ((items: readonly Candidate[]) => void) | undefined;
    const itemsPromise = new Promise<readonly Candidate[]>((resolve) => {
        resolveItems = resolve;
    });
    let calls = 0;
    const provider = createListProvider(async () => {
        calls += 1;
        return itemsPromise;
    });
    const source = createSourceController(provider, {
        sourceId: "hosts",
        cwd: process.cwd(),
        trusted: true,
        cache: true,
        refreshOnStartup: true,
    });
    const warm = source.warm();
    const abort = new AbortController();
    const cancelled = source.discover({ query: "", path: [], signal: abort.signal });
    const rejection = assert.rejects(cancelled);
    const active = source.discover({ query: "", path: [] });
    abort.abort();
    await rejection;
    resolveItems?.(items);
    await warm;
    assert.deepEqual((await active).items, items);
    assert.deepEqual((await source.discover({ query: "", path: [] })).items, items);
    assert.equal(calls, 1);
    await source.dispose();
});
