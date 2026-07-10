import { describe, expect, it } from "vitest";
import { ExplorationGroupStore } from "../src/rendering/exploration-groups.ts";

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

        expect(first).toEqual({ kind: "owner", actions: ["Read a.ts"], active: false });
        expect(second).toEqual({ kind: "child" });
        expect(refreshedFirst).toEqual({
            kind: "owner",
            actions: ["Read a.ts", "Search needle"],
            active: false,
        });
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
            active: false,
        });
        expect(invalidations).toBe(2);
    });

    it("starts a new owner after closing the active group", () => {
        const store = new ExplorationGroupStore();

        store.register({ toolCallId: "first", invalidate: noop }, "Read a.ts");
        store.closeActiveGroup();
        const second = store.register({ toolCallId: "second", invalidate: noop }, "Read b.ts");

        expect(second).toEqual({ kind: "owner", actions: ["Read b.ts"], active: false });
    });

    it("does not let a repainted older boundary close a newer exploration group", () => {
        const store = new ExplorationGroupStore();

        store.registerBoundary("earlier-bash");
        store.register({ toolCallId: "first", invalidate: noop }, "Read a.ts");
        store.register({ toolCallId: "second", invalidate: noop }, "Search needle");

        // Pi repaints the complete transcript after the child invalidates its owner.
        store.registerBoundary("earlier-bash");
        const third = store.register({ toolCallId: "third", invalidate: noop }, "List src");
        const refreshedFirst = store.register(
            { toolCallId: "first", invalidate: noop },
            "Read a.ts",
        );

        expect(third).toEqual({ kind: "child" });
        expect(refreshedFirst).toEqual({
            kind: "owner",
            actions: ["Read a.ts", "Search needle", "List src"],
            active: false,
        });
    });

    it("closes a group when a new boundary tool call is observed", () => {
        const store = new ExplorationGroupStore();

        store.register({ toolCallId: "first", invalidate: noop }, "Read a.ts");
        store.registerBoundary("bash");
        const second = store.register({ toolCallId: "second", invalidate: noop }, "Read b.ts");

        expect(second).toEqual({ kind: "owner", actions: ["Read b.ts"], active: false });
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

        expect(firstChildAgain).toEqual({
            kind: "owner",
            actions: ["Search needle"],
            active: false,
        });
    });

    it("updates the owner when a child moves from active to completed", () => {
        let invalidations = 0;
        const store = new ExplorationGroupStore();
        const invalidate = (): void => {
            invalidations += 1;
        };

        store.register(
            {
                toolCallId: "first",
                invalidate,
            },
            "Read a.ts",
        );
        store.register(
            { toolCallId: "second", invalidate: noop, isPartial: true },
            "Search needle",
        );
        const activeOwner = store.register({ toolCallId: "first", invalidate }, "Read a.ts");
        store.register(
            { toolCallId: "second", invalidate: noop, isPartial: false },
            "Search needle",
        );
        const completedOwner = store.register({ toolCallId: "first", invalidate }, "Read a.ts");

        expect(activeOwner).toMatchObject({ kind: "owner", active: true });
        expect(completedOwner).toMatchObject({ kind: "owner", active: false });
        expect(invalidations).toBe(2);
    });
});
