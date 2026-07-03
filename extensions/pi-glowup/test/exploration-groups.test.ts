import { describe, expect, it } from "vitest";
import { ExplorationGroupStore } from "../src/exploration-groups.ts";

function noop(): void {}

describe("exploration groups", () => {
    it("coalesces consecutive exploration calls under the first rendered component", () => {
        let invalidations = 0;
        const store = new ExplorationGroupStore();

        const first = store.register(
            {
                toolCallId: "first",
                invalidate: () => {
                    invalidations += 1;
                },
            },
            "Read a.ts",
        );
        const second = store.register({ toolCallId: "second", invalidate: noop }, "Search needle");
        const refreshedFirst = store.register(
            { toolCallId: "first", invalidate: noop },
            "Read a.ts",
        );

        expect(first).toEqual({ kind: "owner", actions: ["Read a.ts"] });
        expect(second).toEqual({ kind: "child" });
        expect(refreshedFirst).toEqual({ kind: "owner", actions: ["Read a.ts", "Search needle"] });
        expect(invalidations).toBe(1);
    });

    it("does not invalidate the owner when a child re-renders unchanged", () => {
        let invalidations = 0;
        const store = new ExplorationGroupStore();

        store.register(
            {
                toolCallId: "first",
                invalidate: () => {
                    invalidations += 1;
                },
            },
            "Read a.ts",
        );
        store.register({ toolCallId: "second", invalidate: noop }, "Search needle");
        store.register({ toolCallId: "second", invalidate: noop }, "Search needle");
        store.register({ toolCallId: "second", invalidate: noop }, "Search needle");

        expect(invalidations).toBe(1);
    });

    it("invalidates the owner when a child action changes", () => {
        let invalidations = 0;
        const store = new ExplorationGroupStore();

        store.register(
            {
                toolCallId: "first",
                invalidate: () => {
                    invalidations += 1;
                },
            },
            "Read a.ts",
        );
        store.register({ toolCallId: "second", invalidate: noop }, "Search needle");
        store.register({ toolCallId: "second", invalidate: noop }, "Search haystack");

        const refreshedFirst = store.register(
            { toolCallId: "first", invalidate: noop },
            "Read a.ts",
        );

        expect(refreshedFirst).toEqual({
            kind: "owner",
            actions: ["Read a.ts", "Search haystack"],
        });
        expect(invalidations).toBe(2);
    });

    it("starts a new owner after closing the active group", () => {
        const store = new ExplorationGroupStore();

        store.register({ toolCallId: "first", invalidate: noop }, "Read a.ts");
        store.closeActiveGroup();
        const second = store.register({ toolCallId: "second", invalidate: noop }, "Read b.ts");

        expect(second).toEqual({ kind: "owner", actions: ["Read b.ts"] });
    });

    it("does not retain closed group invalidation callbacks", () => {
        let invalidations = 0;
        const store = new ExplorationGroupStore();

        store.register(
            {
                toolCallId: "first",
                invalidate: () => {
                    invalidations += 1;
                },
            },
            "Read a.ts",
        );
        store.register({ toolCallId: "second", invalidate: noop }, "Search needle");
        store.closeActiveGroup();
        store.register({ toolCallId: "second", invalidate: noop }, "Search haystack");

        expect(invalidations).toBe(1);
    });

    it("evicts the oldest closed group when retained tool calls exceed the limit", () => {
        const store = new ExplorationGroupStore(2);

        store.register({ toolCallId: "first", invalidate: noop }, "Read a.ts");
        store.register({ toolCallId: "first-child", invalidate: noop }, "Search needle");
        store.closeActiveGroup();
        store.register({ toolCallId: "second", invalidate: noop }, "Read b.ts");
        store.closeActiveGroup();

        const firstChildAgain = store.register(
            { toolCallId: "first-child", invalidate: noop },
            "Search needle",
        );

        expect(firstChildAgain).toEqual({ kind: "owner", actions: ["Search needle"] });
    });
});
