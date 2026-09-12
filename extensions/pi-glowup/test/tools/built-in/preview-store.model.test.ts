import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { PreviewStore } from "../../../src/tools/built-in/file-previews.ts";
import { propertyReplayParameters } from "../../support/property-replay.ts";

type Entry = { readonly key: string; readonly value: string };
type Budget = { readonly maxEntries: number; readonly maxBytes: number };

const keys = ["first", "second", "third", "fourth"] as const;
const keyArbitrary = fc.constantFrom(...keys);
const valueArbitrary = fc
    .array(fc.constantFrom("a", "é", "e\u0301", "🧪", "\n"), { maxLength: 8 })
    .map((parts) => parts.join(""));
const setArbitrary = fc.record({
    kind: fc.constant("set" as const),
    key: keyArbitrary,
    value: valueArbitrary,
});
const operationArbitrary = fc.oneof(
    setArbitrary,
    setArbitrary,
    fc.record({ kind: fc.constant("get" as const), key: keyArbitrary }),
    fc.record({ kind: fc.constant("clear" as const) }),
);
const scenarioArbitrary = fc.record({
    maxEntries: fc.integer({ min: 1, max: 5 }),
    maxBytes: fc.integer({ min: 1, max: 32 }),
    operations: fc.array(operationArbitrary, { maxLength: 80 }),
});

function measuredBytes(entries: readonly Entry[]): number {
    return entries.reduce((total, entry) => total + Buffer.byteLength(entry.value, "utf8"), 0);
}

// The model derives the longest admissible insertion suffix. It does not copy
// the production Map bookkeeping, incremental byte counters, or trim loop.
function modelSet(entries: readonly Entry[], next: Entry, budget: Budget): readonly Entry[] {
    const candidates = [...entries.filter((entry) => entry.key !== next.key), next];
    const firstRetained = candidates.findIndex((_entry, index) => {
        const suffix = candidates.slice(index);
        return suffix.length <= budget.maxEntries && measuredBytes(suffix) <= budget.maxBytes;
    });
    return firstRetained === -1 ? [] : candidates.slice(firstRetained);
}

function expectState(store: PreviewStore<string>, model: readonly Entry[], budget: Budget): void {
    for (const key of keys) {
        expect(store.get(key)).toBe(model.find((entry) => entry.key === key)?.value);
    }

    expect(store.stats()).toEqual({ entries: model.length, bytes: measuredBytes(model) });
    expect(store.stats().entries).toBeLessThanOrEqual(budget.maxEntries);
    expect(store.stats().bytes).toBeLessThanOrEqual(budget.maxBytes);
}

describe("preview-store operation histories", () => {
    it.prop([scenarioArbitrary], propertyReplayParameters())(
        "matches a recomputed insertion-suffix model after every operation",
        (scenario) => {
            const store = new PreviewStore<string>({
                maxEntries: scenario.maxEntries,
                maxBytes: scenario.maxBytes,
                measureBytes: (value) => Buffer.byteLength(value, "utf8"),
            });
            let model: readonly Entry[] = [];
            expectState(store, model, scenario);

            for (const operation of scenario.operations) {
                switch (operation.kind) {
                    case "set": {
                        store.set(operation.key, operation.value);
                        model = modelSet(model, operation, scenario);
                        break;
                    }
                    case "get": {
                        expect(store.get(operation.key)).toBe(
                            model.find((entry) => entry.key === operation.key)?.value,
                        );
                        break;
                    }
                    case "clear": {
                        store.clear();
                        model = [];
                        break;
                    }
                }

                expectState(store, model, scenario);
            }
        },
    );

    it("replacement releases old bytes and updates insertion recency", () => {
        const store = new PreviewStore<string>({
            maxEntries: 2,
            maxBytes: 4,
            measureBytes: (value) => Buffer.byteLength(value, "utf8"),
        });
        store.set("first", "é");
        store.set("second", "a");
        store.set("first", "b");
        store.set("third", "c");

        expect(store.get("second")).toBeUndefined();
        expect(store.get("first")).toBe("b");
        expect(store.get("third")).toBe("c");
        expect(store.stats()).toEqual({ entries: 2, bytes: 2 });
    });

    it("reads do not refresh insertion recency", () => {
        const store = new PreviewStore<string>(2);
        store.set("first", "a");
        store.set("second", "b");
        expect(store.get("first")).toBe("a");
        store.set("third", "c");

        expect(store.get("first")).toBeUndefined();
        expect(store.get("second")).toBe("b");
    });

    it("pins the current oversized-admission policy instead of inventing LRU semantics", () => {
        const store = new PreviewStore<string>({
            maxEntries: 3,
            maxBytes: 3,
            measureBytes: (value) => Buffer.byteLength(value, "utf8"),
        });
        store.set("first", "a");
        store.set("second", "🧪");

        // Current contract: insertion then eviction, including the oversized item.
        // A future reject-without-eviction policy must deliberately update this test.
        expect(store.get("first")).toBeUndefined();
        expect(store.get("second")).toBeUndefined();
        expect(store.stats()).toEqual({ entries: 0, bytes: 0 });
        store.clear();
        store.clear();
        store.set("third", "é");
        expect(store.stats()).toEqual({ entries: 1, bytes: 2 });
    });
});
