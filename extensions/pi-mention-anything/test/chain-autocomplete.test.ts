import assert from "node:assert/strict";
import { test } from "vitest";

import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

import {
    createChainAutocompleteProvider,
    type ChainCompletionSource,
    type ChainSelection,
} from "../src/chain-autocomplete.ts";
import type { Candidate } from "../src/source-contract.ts";

const fallback: AutocompleteProvider = {
    async getSuggestions() {
        return {
            prefix: "fallback",
            items: [{ value: "fallback", label: "fallback" }],
        };
    },
    applyCompletion(lines, cursorLine, cursorCol) {
        return { lines, cursorLine, cursorCol };
    },
    shouldTriggerFileCompletion() {
        return true;
    },
};

const work: Candidate = {
    id: "session-work",
    label: "work",
    segment: "work",
    selectable: true,
    navigable: true,
};

const api: Candidate = {
    id: "window-api",
    label: "api",
    segment: "api",
    selectable: false,
    navigable: true,
};

const logs: Candidate = {
    id: "pane-logs",
    label: "logs",
    segment: "logs",
    selectable: true,
    navigable: false,
};

function itemNamed(items: readonly AutocompleteItem[], label: string): AutocompleteItem {
    const item = items.find((candidate) => candidate.label === label);
    if (item === undefined) assert.fail(`Expected completion row ${label}`);
    return item;
}

function treeSource(overrides: Partial<ChainCompletionSource> = {}): ChainCompletionSource {
    return {
        id: "tmux",
        trigger: "t:",
        separator: ":",
        completionSuffix: " ",
        filtering: "local",
        async discover({ path }) {
            if (path.length === 0) return { items: [work] };
            if (path.length === 1) return { items: [api] };

            return { items: [logs] };
        },
        async resolve(segments) {
            const candidates = [work, api, logs].slice(0, segments.length);
            if (candidates.every((candidate, index) => candidate.segment === segments[index])) {
                return { status: "resolved", path: candidates };
            }

            return { status: "unresolved", reason: "not found" };
        },
        ...overrides,
    };
}

const request = () => ({
    signal: new AbortController().signal,
});

function deferred() {
    let resolve = (): void => {};

    // Promise.withResolvers is unavailable under the repository's ES2023 library target.
    const promise = new Promise<void>((done) => {
        resolve = done;
    });

    return { promise, resolve };
}

test("local filtering searches the full bounded response before limiting retained rows", async () => {
    const candidates = Array.from({ length: 1500 }, (_unused, index) => ({
        ...logs,
        id: String(index),
        label: `candidate-${index}`,
        segment: `candidate-${index}`,
    }));
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [treeSource({ discover: async () => ({ items: candidates }) })],
    });
    const text = "t:candidate-1499";
    const suggestions = await provider.getSuggestions([text], 0, text.length, request());
    assert.equal(
        suggestions?.items.some((item) => item.label === "candidate-1499"),
        true,
    );
});

test("deleting and retyping a branch resolves its new identity through both editor and suggestion seams", async () => {
    for (const throughSuggestions of [true, false]) {
        let parent = work;
        let resolutions = 0;
        const childParents: string[] = [];
        const source = treeSource({
            async discover({ path }) {
                if (path.length === 0) return { items: [parent] };

                childParents.push(path[0]?.id ?? "");

                return { items: [logs] };
            },
            async resolve() {
                resolutions += 1;
                return { status: "resolved", path: [parent] };
            },
        });
        const provider = createChainAutocompleteProvider({ current: fallback, sources: [source] });
        const roots = await provider.getSuggestions(["t:"], 0, 2, request());
        if (roots === null) assert.fail("Expected roots");
        provider.applyCompletion(["t:"], 0, 2, itemNamed(roots.items, "work"), roots.prefix);

        if (throughSuggestions) await provider.getSuggestions([""], 0, 0, request());
        else provider.reconcile("");

        parent = { ...work, id: "new-session" };
        await provider.getSuggestions(["t:work:"], 0, 7, request());
        assert.equal(resolutions, 1);
        assert.deepEqual(childParents, ["new-session"]);
    }
});

test("abandoned continuation identities have a bounded retained lifetime", async () => {
    let resolutions = 0;
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [
            treeSource({
                async resolve() {
                    resolutions += 1;
                    return { status: "resolved", path: [work] };
                },
            }),
        ],
    });
    let text = "";
    for (let index = 0; index < 65; index += 1) {
        const input = `${text}t:`;
        const roots = await provider.getSuggestions([input], 0, input.length, request());
        if (roots === null) assert.fail("Expected roots");

        const result = provider.applyCompletion(
            [input],
            0,
            input.length,
            itemNamed(roots.items, "work"),
            roots.prefix,
        );
        text = `${result.lines[0]} `;
    }

    await provider.getSuggestions([text], 0, 7, request());
    assert.equal(
        resolutions,
        1,
        "oldest abandoned occurrence should use exact resolution after eviction",
    );
});

test("traverses branches, exposes a selectable branch target, and completes a leaf", async () => {
    let continuations = 0;
    let selection: ChainSelection | undefined;
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [treeSource()],
        onContinue: () => {
            continuations += 1;
        },
        onSelection: (selected) => {
            selection = selected;
        },
    });

    const roots = await provider.getSuggestions(["t:"], 0, 2, request());
    if (roots === null) assert.fail("Expected root suggestions");

    const afterSession = provider.applyCompletion(
        ["t:"],
        0,
        2,
        itemNamed(roots.items, "work"),
        roots.prefix,
    );
    assert.deepEqual(afterSession, { lines: ["t:work:"], cursorLine: 0, cursorCol: 7 });
    assert.equal(continuations, 1);
    const windows = await provider.getSuggestions(afterSession.lines, 0, 7, request());
    if (windows === null) assert.fail("Expected window suggestions");

    assert.deepEqual(
        windows.items.map((item) => item.label),
        ["Use work", "api"],
    );
    const afterWindow = provider.applyCompletion(
        afterSession.lines,
        0,
        7,
        itemNamed(windows.items, "api"),
        windows.prefix,
    );
    assert.deepEqual(afterWindow, { lines: ["t:work:api:"], cursorLine: 0, cursorCol: 11 });
    const panes = await provider.getSuggestions(afterWindow.lines, 0, 11, request());
    if (panes === null) assert.fail("Expected pane suggestions");

    const completed = provider.applyCompletion(
        afterWindow.lines,
        0,
        11,
        itemNamed(panes.items, "logs"),
        panes.prefix,
    );

    assert.deepEqual(completed, { lines: ["t:work:api:logs "], cursorLine: 0, cursorCol: 16 });
    assert.deepEqual(selection, {
        sourceId: "tmux",
        start: 0,
        end: 15,
        text: "t:work:api:logs",
        path: [work, api, logs],
        editorText: "t:work:api:logs ",
    });
});

test("selecting a navigable parent use row removes the trailing separator", async () => {
    let selection: ChainSelection | undefined;
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [treeSource()],
        onSelection(selected) {
            selection = selected;
        },
    });
    const suggestions = await provider.getSuggestions(["t:work:"], 0, 7, request());
    if (suggestions === null) assert.fail("Expected child suggestions");

    const completed = provider.applyCompletion(
        ["t:work:"],
        0,
        7,
        itemNamed(suggestions.items, "Use work"),
        suggestions.prefix,
    );

    assert.deepEqual(completed, { lines: ["t:work "], cursorLine: 0, cursorCol: 7 });
    assert.equal(selection?.text, "t:work");
    assert.deepEqual(selection.path, [work]);
});

test("selection positions are absolute in joined editor lines", async () => {
    let selection: ChainSelection | undefined;
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [
            treeSource({
                async discover() {
                    return { items: [logs] };
                },
            }),
        ],
        onSelection(selected) {
            selection = selected;
        },
    });
    const lines = ["intro", "pick t:lo tail"];
    const suggestions = await provider.getSuggestions(lines, 1, 9, request());
    if (suggestions === null) assert.fail("Expected leaf suggestions");

    const completed = provider.applyCompletion(
        lines,
        1,
        9,
        itemNamed(suggestions.items, "logs"),
        suggestions.prefix,
    );

    assert.deepEqual(completed, {
        lines: ["intro", "pick t:logs tail"],
        cursorLine: 1,
        cursorCol: 12,
    });
    assert.deepEqual(selection, {
        sourceId: "tmux",
        start: 11,
        end: 17,
        text: "t:logs",
        path: [logs],
        editorText: "intro\npick t:logs tail",
    });
});

test("uses insertionText only for the final target and snapshots the inserted span", async () => {
    const branch: Candidate = {
        ...work,
        id: "branch",
        label: "branch",
        segment: "branch",
        insertionText: "must-not-be-used-for-navigation",
    };
    const leaf: Candidate = {
        ...logs,
        id: "leaf",
        label: "leaf",
        segment: "leaf",
        insertionText: "<target %7>",
    };
    let selection: ChainSelection | undefined;
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [
            treeSource({
                async discover({ path }) {
                    if (path.length === 0) return { items: [branch] };

                    return { items: [leaf] };
                },
            }),
        ],
        onSelection(selected) {
            selection = selected;
        },
    });

    const roots = await provider.getSuggestions(["t:"], 0, 2, request());
    if (roots === null) assert.fail("Expected branch suggestions");

    const continued = provider.applyCompletion(
        ["t:"],
        0,
        2,
        itemNamed(roots.items, "branch"),
        roots.prefix,
    );
    assert.deepEqual(continued, { lines: ["t:branch:"], cursorLine: 0, cursorCol: 9 });
    const children = await provider.getSuggestions(continued.lines, 0, 9, request());
    if (children === null) assert.fail("Expected leaf suggestions");

    const completed = provider.applyCompletion(
        continued.lines,
        0,
        9,
        itemNamed(children.items, "leaf"),
        children.prefix,
    );

    assert.deepEqual(completed, { lines: ["<target %7> "], cursorLine: 0, cursorCol: 12 });
    assert.deepEqual(selection, {
        sourceId: "tmux",
        start: 0,
        end: 11,
        text: "<target %7>",
        path: [branch, leaf],
        editorText: "<target %7> ",
    });
});

test("completion prefixes never trigger Pi's slash-command submit fallthrough", async () => {
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [
            treeSource({
                filtering: "provider",
                async discover() {
                    return { items: [logs] };
                },
            }),
        ],
    });

    const suggestions = await provider.getSuggestions(["t:/lo"], 0, 5, request());
    assert.equal(suggestions?.prefix, "");
});

test("keeps duplicate-segment branch IDs through chained navigation", async () => {
    const duplicateA: Candidate = {
        ...work,
        id: "session-a",
        label: "duplicate A",
        segment: "duplicate",
    };
    const duplicateB: Candidate = {
        ...work,
        id: "session-b",
        label: "duplicate B",
        segment: "duplicate",
    };
    let resolutionCalls = 0;
    const discoveredPaths: Array<readonly Candidate[]> = [];
    let selection: ChainSelection | undefined;
    const source = treeSource({
        async discover({ path }) {
            discoveredPaths.push(path);

            if (path.length === 0) return { items: [duplicateA, duplicateB] };

            return { items: [logs] };
        },
        async resolve() {
            resolutionCalls += 1;
            return { status: "unresolved", reason: "ambiguous segment" };
        },
    });
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [source],
        onSelection(selected) {
            selection = selected;
        },
    });

    const roots = await provider.getSuggestions(["t:"], 0, 2, request());
    if (roots === null) assert.fail("Expected duplicate roots");

    const continued = provider.applyCompletion(
        ["t:"],
        0,
        2,
        itemNamed(roots.items, "duplicate B"),
        roots.prefix,
    );
    const children = await provider.getSuggestions(continued.lines, 0, 12, request());
    if (children === null) assert.fail("Expected duplicate branch children");

    provider.applyCompletion(
        continued.lines,
        0,
        12,
        itemNamed(children.items, "logs"),
        children.prefix,
    );

    assert.equal(resolutionCalls, 0);
    assert.deepEqual(discoveredPaths, [[], [duplicateB]]);
    assert.deepEqual(selection?.path, [duplicateB, logs]);
});

test("prefers an occurrence snapshot before exact provider resolution", async () => {
    const selectedParent: Candidate = {
        ...work,
        id: "selected-duplicate",
        label: "selected duplicate",
        segment: "duplicate",
    };
    let resolutionCalls = 0;
    let selectedLookup:
        | {
              readonly sourceId: string;
              readonly segments: readonly string[];
              readonly start: number;
          }
        | undefined;
    let discoveredPath: readonly Candidate[] | undefined;
    const source = treeSource({
        async discover({ path }) {
            discoveredPath = path;
            return { items: [logs] };
        },
        async resolve() {
            resolutionCalls += 1;
            return { status: "unresolved", reason: "ambiguous segment" };
        },
    });
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [source],
        resolveSelected(sourceId, segments, start) {
            selectedLookup = { sourceId, segments, start };
            return [selectedParent];
        },
    });

    const suggestions = await provider.getSuggestions(["say t:duplicate:"], 0, 16, request());
    assert.notEqual(suggestions, null);
    assert.deepEqual(selectedLookup, {
        sourceId: "tmux",
        segments: ["duplicate"],
        start: 4,
    });
    assert.equal(resolutionCalls, 0);
    assert.deepEqual(discoveredPath, [selectedParent]);
});

test("completing an earlier segment removes descendants and preserves surrounding prose", async () => {
    const other = { ...work, id: "session-other", label: "other", segment: "other" };
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [
            treeSource({
                filtering: "provider",
                async discover() {
                    return { items: [other] };
                },
            }),
        ],
    });
    const line = "before t:work:api:logs after";
    const suggestions = await provider.getSuggestions([line], 0, 11, request());
    if (suggestions === null) assert.fail("Expected replacement suggestions");

    const completed = provider.applyCompletion(
        [line],
        0,
        11,
        itemNamed(suggestions.items, "other"),
        suggestions.prefix,
    );

    assert.deepEqual(completed, {
        lines: ["before t:other: after"],
        cursorLine: 0,
        cursorCol: 15,
    });
});

test("provider-owned filtering is preserved while local sources are fuzzy filtered", async () => {
    const remote = treeSource({
        filtering: "provider",
        async discover() {
            return { items: [work, { ...logs, id: "remote", label: "remote", segment: "remote" }] };
        },
    });
    const local = treeSource({
        filtering: "local",
        async discover() {
            return { items: [work, { ...logs, id: "remote", label: "remote", segment: "remote" }] };
        },
    });

    const remoteProvider = createChainAutocompleteProvider({
        current: fallback,
        sources: [remote],
    });
    const localProvider = createChainAutocompleteProvider({ current: fallback, sources: [local] });
    const remoteSuggestions = await remoteProvider.getSuggestions(["t:zz"], 0, 4, request());
    const localSuggestions = await localProvider.getSuggestions(["t:zz"], 0, 4, request());

    assert.deepEqual(
        remoteSuggestions?.items.map((item) => item.label),
        ["work", "remote"],
    );
    assert.deepEqual(localSuggestions?.items, []);
});

test("owned empty and failed discovery never falls through to another provider", async () => {
    let fallbackRequests = 0;
    const states: Array<{
        readonly sourceId: string;
        readonly status: "ready" | "unresolved" | "failed";
    }> = [];
    const countingFallback: AutocompleteProvider = {
        ...fallback,
        async getSuggestions() {
            fallbackRequests += 1;
            return fallback.getSuggestions([], 0, 0, request());
        },
    };
    const empty = treeSource({
        async discover() {
            return { items: [] };
        },
    });
    const failed = treeSource({
        async discover() {
            throw new Error("offline");
        },
    });

    const emptyResult = await createChainAutocompleteProvider({
        current: countingFallback,
        sources: [empty],
        onState(sourceId, status) {
            states.push({ sourceId, status });
        },
    }).getSuggestions(["t:"], 0, 2, request());
    const failedResult = await createChainAutocompleteProvider({
        current: countingFallback,
        sources: [failed],
        onState(sourceId, status) {
            states.push({ sourceId, status });
        },
    }).getSuggestions(["t:"], 0, 2, request());

    assert.deepEqual(emptyResult, { prefix: "", items: [] });
    assert.deepEqual(failedResult, { prefix: "", items: [] });
    assert.equal(fallbackRequests, 0);
    assert.deepEqual(states, [
        { sourceId: "tmux", status: "ready" },
        { sourceId: "tmux", status: "failed" },
    ]);
});

test("reports unresolved parents without attempting discovery", async () => {
    let discoveries = 0;
    const states: string[] = [];
    const source = treeSource({
        async discover() {
            discoveries += 1;
            return { items: [logs] };
        },
        async resolve() {
            return { status: "unresolved", reason: "missing parent" };
        },
    });
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [source],
        onState(_sourceId, status) {
            states.push(status);
        },
    });

    const suggestions = await provider.getSuggestions(["t:missing:"], 0, 10, request());
    assert.deepEqual(suggestions, { prefix: "", items: [] });
    assert.equal(discoveries, 0);
    assert.deepEqual(states, ["unresolved"]);
});

test("an explicit More row requests and accumulates the next page", async () => {
    const cursors: Array<string | undefined> = [];
    let continuations = 0;

    const source = treeSource({
        async discover({ cursor }) {
            cursors.push(cursor);

            if (cursor === undefined) return { items: [work], nextCursor: "page-2" };

            return { items: [logs] };
        },
    });
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [source],
        onContinue: () => {
            continuations += 1;
        },
    });

    const first = await provider.getSuggestions(["t:"], 0, 2, request());
    if (first === null) assert.fail("Expected first page");
    provider.applyCompletion(["t:"], 0, 2, itemNamed(first.items, "More…"), first.prefix);
    const second = await provider.getSuggestions(["t:"], 0, 2, request());
    assert.deepEqual(cursors, [undefined, "page-2"]);
    assert.equal(continuations, 1);
    assert.deepEqual(
        second?.items.map((item) => item.label),
        ["work", "logs"],
    );
});

test("caps local suggestions and provider-retained candidates", async () => {
    const candidates = Array.from({ length: 1_100 }, (_, index): Candidate => ({
        id: `candidate-${index}`,
        label: `candidate-${index}`,
        segment: `candidate-${index}`,
        selectable: true,
        navigable: false,
    }));
    const local = createChainAutocompleteProvider({
        current: fallback,
        sources: [
            treeSource({
                async discover() {
                    return { items: candidates };
                },
            }),
        ],
    });
    const providerFiltered = createChainAutocompleteProvider({
        current: fallback,
        sources: [
            treeSource({
                filtering: "provider",
                async discover() {
                    return { items: candidates, nextCursor: "overflow" };
                },
            }),
        ],
    });

    const localSuggestions = await local.getSuggestions(["t:"], 0, 2, request());
    const providerSuggestions = await providerFiltered.getSuggestions(["t:"], 0, 2, request());
    assert.equal(localSuggestions?.items.length, 100);
    assert.equal(providerSuggestions?.items.length, 1_000);
    assert.equal(
        providerSuggestions.items.some((item) => item.label === "More…"),
        false,
    );
});

test("stops repeated cursors without duplicating candidates", async () => {
    const cursors: Array<string | undefined> = [];
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [
            treeSource({
                filtering: "provider",
                async discover({ cursor }) {
                    cursors.push(cursor);

                    if (cursor === undefined) return { items: [work], nextCursor: "repeat" };

                    return { items: [work, logs], nextCursor: "repeat" };
                },
            }),
        ],
    });

    const first = await provider.getSuggestions(["t:"], 0, 2, request());
    if (first === null) assert.fail("Expected first page");
    provider.applyCompletion(["t:"], 0, 2, itemNamed(first.items, "More…"), first.prefix);
    const second = await provider.getSuggestions(["t:"], 0, 2, request());
    assert.deepEqual(cursors, [undefined, "repeat"]);
    assert.deepEqual(
        second?.items.map((item) => item.label),
        ["work", "logs"],
    );
});

test("stops pagination after ten retained pages", async () => {
    let calls = 0;
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [
            treeSource({
                filtering: "provider",
                async discover({ cursor }) {
                    const page = cursor ?? "0";
                    calls += 1;

                    return {
                        items: [
                            {
                                ...logs,
                                id: `page-${page}`,
                                label: `page-${page}`,
                                segment: `page-${page}`,
                            },
                        ],
                        nextCursor: String(Number(page) + 1),
                    };
                },
            }),
        ],
    });

    let suggestions = await provider.getSuggestions(["t:"], 0, 2, request());
    for (let page = 1; page < 10; page += 1) {
        if (suggestions === null) assert.fail("Expected paged suggestions");

        provider.applyCompletion(
            ["t:"],
            0,
            2,
            itemNamed(suggestions.items, "More…"),
            suggestions.prefix,
        );
        suggestions = await provider.getSuggestions(["t:"], 0, 2, request());
    }

    assert.equal(calls, 10);
    assert.equal(suggestions?.items.length, 10);
    assert.equal(
        suggestions.items.some((item) => item.label === "More…"),
        false,
    );
});

test("a newer request aborts obsolete discovery", async () => {
    const firstGate = deferred();
    let firstSignal: AbortSignal | undefined;
    let calls = 0;
    const states: string[] = [];
    const source = treeSource({
        async discover({ signal }) {
            calls += 1;
            if (calls === 1) {
                firstSignal = signal;
                await firstGate.promise;
            }

            return { items: [work] };
        },
    });
    const provider = createChainAutocompleteProvider({
        current: fallback,
        sources: [source],
        onState(_sourceId, status) {
            states.push(status);
        },
    });

    const obsolete = provider.getSuggestions(["t:w"], 0, 3, request());
    await Promise.resolve();
    const current = provider.getSuggestions(["t:wo"], 0, 4, request());
    firstGate.resolve();
    assert.equal(firstSignal?.aborted, true);
    assert.equal(await obsolete, null);
    assert.deepEqual(
        (await current)?.items.map((item) => item.label),
        ["work"],
    );
    assert.deepEqual(states, ["ready"]);
});

test("retains a mutable sources array and suppresses file completion only for owned input", async () => {
    const sources: ChainCompletionSource[] = [];
    const provider = createChainAutocompleteProvider({ current: fallback, sources });
    sources.push(treeSource());
    assert.deepEqual(provider.triggerCharacters, ["t"]);
    assert.equal(provider.shouldTriggerFileCompletion?.(["t:"], 0, 2), false);
    assert.equal(provider.shouldTriggerFileCompletion(["ordinary"], 0, 8), true);
    assert.deepEqual(
        (await provider.getSuggestions(["t:"], 0, 2, request()))?.items.map((item) => item.label),
        ["work"],
    );
});
