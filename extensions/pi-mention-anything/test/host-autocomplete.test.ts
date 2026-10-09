import assert from "node:assert/strict";
import { test } from "vitest";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
    createChainAutocompleteProvider,
    type ChainCompletionSource,
} from "../src/chain-autocomplete.ts";

type HostComposition = {
    createBaseAutocompleteProvider(): AutocompleteProvider;
    autocompleteProviderWrappers: ((current: AutocompleteProvider) => AutocompleteProvider)[];
    autocompleteProvider?: AutocompleteProvider;
    defaultEditor: { setAutocompleteProvider(provider: AutocompleteProvider): void };
    editor: { setAutocompleteProvider(provider: AutocompleteProvider): void };
};

function isSetup(value: unknown): value is (this: HostComposition) => void {
    return typeof value === "function";
}

test("installed Pi composes and assigns mention trigger characters without losing other providers", () => {
    const setup: unknown = Object.getOwnPropertyDescriptor(
        InteractiveMode.prototype,
        "setupAutocompleteProvider",
    )?.value;
    assert.ok(isSetup(setup), "installed Pi must expose its autocomplete composition seam");
    const sources: ChainCompletionSource[] = [
        {
            id: "tmux",
            trigger: "t:",
            separator: ":",
            completionSuffix: " ",
            filtering: "local",
            discover: async () => ({ items: [] }),
            resolve: async () => ({ status: "unresolved", reason: "missing" }),
        },
    ];

    const base: AutocompleteProvider = {
        getSuggestions: async () => null,
        applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    };
    let installed: AutocompleteProvider | undefined;
    const editor = {
        setAutocompleteProvider(provider: AutocompleteProvider) {
            installed = provider;
        },
    };
    const host: HostComposition = {
        createBaseAutocompleteProvider: () => base,
        autocompleteProviderWrappers: [
            (current) => ({ ...current, triggerCharacters: ["#"] }),
            (current) => createChainAutocompleteProvider({ current, sources }),
        ],
        defaultEditor: editor,
        editor,
    };
    setup.call(host);
    assert.equal(installed, host.autocompleteProvider);
    assert.deepEqual(new Set(installed?.triggerCharacters), new Set(["#", "t"]));
    sources.push({ ...sources[0], id: "ssh", trigger: "s:" });
    assert.deepEqual(new Set(installed?.triggerCharacters), new Set(["#", "t", "s"]));
});
