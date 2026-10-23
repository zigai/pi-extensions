import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { StoredHistory } from "../src/stored-history.ts";

describe("stored history", () => {
    it("finds pre-compaction and hidden content without changing the active context", () => {
        const session = SessionManager.inMemory("/sample");
        const oldId = session.appendMessage({ role: "user", content: "old needle", timestamp: 1 });
        const keptId = session.appendMessage({ role: "user", content: "recent", timestamp: 2 });
        session.appendCompaction("short summary", keptId, 100);
        const hiddenId = session.appendMessage({
            role: "custom",
            customType: "record",
            content: "hidden needle",
            display: false,
            timestamp: 3,
        });
        const leaf = session.getLeafId();
        const context = session.buildSessionContext();
        const history = new StoredHistory(session);

        expect(history.search("needle").map((result) => result.id)).toEqual([oldId, hiddenId]);
        expect(history.open(oldId)?.text).toContain("old needle");
        expect(session.getLeafId()).toBe(leaf);
        expect(session.buildSessionContext()).toEqual(context);
    });

    it("limits searches to the current branch unless all branches are explicitly selected", () => {
        const session = SessionManager.inMemory("/sample");
        const root = session.appendMessage({ role: "user", content: "root", timestamp: 1 });
        const other = session.appendMessage({
            role: "user",
            content: "branch needle",
            timestamp: 2,
        });
        session.branch(root);
        const active = session.appendMessage({
            role: "user",
            content: "current needle",
            timestamp: 3,
        });
        const history = new StoredHistory(session);

        expect(history.search("needle").map((result) => result.id)).toEqual([active]);
        expect(history.search("needle", "all").map((result) => result.id)).toEqual([other, active]);
        expect(history.open(other)?.onCurrentBranch).toBe(false);
        expect(session.getLeafId()).toBe(active);
    });

    it("indexes literal structured values, multiline text and non-ASCII content", () => {
        const session = SessionManager.inMemory("/sample");
        const id = session.appendCustomEntry("record", {
            arguments: { path: "/sample/[a].md", nested: "résumé", id: "job-token" },
            output: "first\nsecond",
        });
        const history = new StoredHistory(session);

        expect(history.search("[a].md").map((result) => result.id)).toEqual([id]);
        expect(history.search("RÉSUMÉ").map((result) => result.id)).toEqual([id]);
        expect(history.search("first\nsecond").map((result) => result.id)).toEqual([id]);
        expect(history.search("job-token").map((result) => result.id)).toEqual([id]);
        expect(history.search("")).toEqual([]);
        expect(history.open("missing")).toBeUndefined();
    });
});
