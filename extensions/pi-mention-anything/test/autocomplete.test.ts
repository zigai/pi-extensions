import assert from "node:assert/strict";
import { test } from "vitest";

import type { AutocompleteProvider } from "@earendil-works/pi-tui";

import { createMentionAutocompleteProvider } from "../src/autocomplete.ts";

type Candidate = { readonly name: string; readonly replacement: string };

const fallback: AutocompleteProvider = {
    async getSuggestions() {
        return null;
    },
    applyCompletion(lines, cursorLine, cursorCol) {
        return { lines, cursorLine, cursorCol };
    },
};

test("loads fresh candidates for each autocomplete request and reports the selected object", async () => {
    let loads = 0;
    let selected: Candidate | undefined;
    const provider = createMentionAutocompleteProvider<Candidate>({
        current: fallback,
        trigger: "%",
        completionSuffix: " ",
        initialSuggestions: { strategy: "sourceOrder", pinned: [] },
        loadItems() {
            loads += 1;
            return [{ name: "production", replacement: `version-${loads}` }];
        },
        nameOf: (candidate) => candidate.name,
        onSelection: (candidate) => {
            selected = candidate;
        },
    });
    const request = { signal: new AbortController().signal };

    await provider.getSuggestions(["%pro"], 0, 4, request);
    const suggestions = await provider.getSuggestions(["%prod"], 0, 5, request);
    const item = suggestions?.items[0];
    if (item === undefined) assert.fail("expected a mention suggestion");
    provider.applyCompletion(["%prod"], 0, 5, item, "%prod");
    assert.equal(loads, 2);
    assert.deepEqual(selected, { name: "production", replacement: "version-2" });
});

test("cancellation during loading or ranking returns the fallback instead of stale items", async () => {
    for (const stage of ["load", "rank"]) {
        const cancellation = new AbortController();
        let fallbacks = 0;
        const provider = createMentionAutocompleteProvider<Candidate>({
            current: {
                ...fallback,
                async getSuggestions() {
                    fallbacks += 1;
                    return null;
                },
            },
            trigger: "%",
            completionSuffix: " ",
            initialSuggestions: { strategy: "frecency", pinned: [] },
            loadItems() {
                if (stage === "load") cancellation.abort();
                return [{ name: "production", replacement: "value" }];
            },
            nameOf: (candidate) => candidate.name,
            history: {
                async load() {
                    cancellation.abort();
                    return new Map();
                },
                recordSelection() {},
                async flush() {},
            },
        });
        assert.equal(
            await provider.getSuggestions(["%"], 0, 1, { signal: cancellation.signal }),
            null,
        );
        assert.equal(fallbacks, 1);
    }
});
