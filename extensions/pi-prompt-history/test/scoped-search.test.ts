import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
    extract,
    matching,
    parseTranscript,
    ProjectIdentity,
    type Occurrence,
} from "../src/search.ts";
import { HistorySource, type SearchSnapshot } from "../src/source.ts";
import { HistoryIndex } from "../src/history-index.ts";

// Git subprocesses and async file fixtures need headroom on loaded CI hosts.
const integrationTimeout = 60_000;
const temporary: string[] = [];
afterEach(async () => {
    for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
    const root = await mkdtemp(join(process.cwd(), ".cache-history-"));
    temporary.push(root);
    await writeFile(join(root, ".git"), "gitdir: missing-fixture-git-dir\n");

    return root;
}

function entry(text: string, id = "e", timestamp = "2026-01-01T00:00:00.000Z") {
    return { type: "message", id, timestamp, message: { role: "user", content: text } };
}

function transcript(session: string, cwd: string, texts: string[]) {
    return [
        { type: "session", id: session, cwd },
        ...texts.map((text, i) => entry(text, String(i))),
    ]
        .map((row) => JSON.stringify(row))
        .join("\n");
}

test("full original text, user-only blocks, multiline/Unicode/literal AND matching and deterministic dedup", () => {
    const rows = extract(
        [
            entry("  HéLLo\nworld [.*]  ", "1"),
            { ...entry("assistant"), message: { role: "assistant", content: "assistant" } },
            { ...entry("tool"), message: { role: "toolResult", content: "user-looking" } },
            {
                ...entry("blocks", "2"),
                message: {
                    role: "user",
                    content: [
                        { type: "image", data: "binary" },
                        { type: "text", text: "one " },
                        { type: "text", text: "two" },
                    ],
                },
            },
            {
                ...entry("image"),
                message: { role: "user", content: [{ type: "image", data: "binary" }] },
            },
        ],
        "a",
        "/a",
    );
    expect(rows.map((row) => row.text)).toEqual(["  HéLLo\nworld [.*]  ", "one two"]);
    expect(matching(rows, "[.*]\n HÉLLO\tworld")).toEqual([rows[0]]);
    expect(matching(rows, "hello")).toEqual([]);
    const original = rows.at(0);
    expect(original).toBeDefined();

    if (original === undefined) return;

    const duplicate: Occurrence = { ...original, session: "b" };
    expect(matching([original, duplicate], " ")[0]?.session).toBe("b");
    expect(matching([duplicate, original], " ")[0]?.session).toBe("b");
    expect(() => parseTranscript('{"type":"session"}\n')).toThrow("Invalid session header");
});

test(
    "Git worktree identity groups subdirectories and symlinks, excludes separate worktree/non-Git prefix",
    async () => {
        const root = await fixture();
        const a = join(root, "a ; literal ");
        const other = join(root, "a-other");
        await mkdir(join(a, "sub"), { recursive: true });
        execFileSync("git", ["init", "-q", a]);
        execFileSync(
            "git",
            ["-C", a, "worktree", "add", "--orphan", "-b", "fixture-other", other],
            {
                stdio: "pipe",
            },
        );
        const alias = join(root, "alias");
        await symlink(a, alias);
        const projects = new ProjectIdentity();
        expect(await projects.resolve(join(a, "sub"))).toBe(await projects.resolve(a));
        expect(await projects.resolve(alias)).toBe(await projects.resolve(a));
        expect(await projects.resolve(other)).not.toBe(await projects.resolve(a));
        expect(await projects.resolve(join(root, "app"))).not.toBe(
            await projects.resolve(join(root, "application")),
        );
    },
    integrationTimeout,
);

test(
    "session/project/global occurrence scope, shared text in both projects, 1000+ old matches and corrupt partial",
    async () => {
        const root = await fixture();
        const storage = join(root, "sessions");
        const a = join(root, "a");
        const b = join(root, "b");
        await mkdir(storage);
        await mkdir(a);
        await mkdir(b);
        await writeFile(
            join(storage, "a2.jsonl"),
            transcript("a2", a, [
                "shared",
                ...Array.from({ length: 1001 }, (_, i) => `older ${i}`),
            ]),
        );
        await writeFile(join(storage, "b1.jsonl"), transcript("b1", b, ["shared", "only B"]));
        await writeFile(join(storage, "corrupt.jsonl"), "not JSON");
        const live = [entry("live", "unsaved"), entry("branch", "saved-branch")];
        const source = new HistorySource({
            root: storage,
            session: "a1",
            cwd: a,
            live: () => live,
        });
        let state: SearchSnapshot | undefined;
        const update = (next: SearchSnapshot) => {
            state = next;
        };
        await source.scan("session", update);
        expect(state?.rows.map((row) => row.text)).toEqual(["live", "branch"]);
        await source.scan("project", update);
        expect(state?.rows).toHaveLength(1004);
        expect(state?.failures).toBe(1);
        expect(state?.loading).toBe(false);
        expect(state?.rows.some((row) => row.text === "only B")).toBe(false);
        expect(matching(state?.rows ?? [], "older 0").length).toBeGreaterThan(0);
        await source.scan("global", update);
        expect(state?.rows.filter((row) => row.text === "shared")).toHaveLength(2);
        const bSource = new HistorySource({
            root: storage,
            session: "new-B",
            cwd: b,
            live: () => [],
        });
        await bSource.scan("project", update);
        expect(matching(state?.rows ?? [], "shared")[0]?.session).toBe("b1");
        source.cancel();
        bSource.cancel();
    },
    integrationTimeout,
);

test(
    "rapid supersession/disposal rejects stale completions; live refresh; fresh scans see same-size rewrite",
    async () => {
        const root = await fixture();
        const file = join(root, "session.jsonl");
        await writeFile(file, transcript("old", root, ["before"]));
        const live = [entry("live")];
        const source = new HistorySource({ root, session: "current", cwd: root, live: () => live });
        const snapshots: SearchSnapshot[] = [];
        const pending = source.scan("global", (state) => {
            snapshots.push(state);
        });
        await source.scan("session", (state) => {
            snapshots.push(state);
        });
        const count = snapshots.length;
        await pending;
        expect(snapshots).toHaveLength(count);
        live.push(entry("new live", "new"));
        source.refreshLive();
        expect(snapshots.at(-1)?.rows).toHaveLength(2);
        await writeFile(file, transcript("old", root, ["after!"]));
        await source.scan("global", (state) => {
            snapshots.push(state);
        });
        expect(snapshots.at(-1)?.rows.some((row) => row.text === "after!")).toBe(true);
        const pending2 = source.scan("global", (state) => {
            snapshots.push(state);
        });
        source.cancel();
        const cancelledCount = snapshots.length;
        await pending2;
        expect(snapshots).toHaveLength(cancelledCount);
    },
    integrationTimeout,
);

test(
    "storage failure reports live-only coverage distinctly",
    async () => {
        const root = await fixture();
        const source = new HistorySource({
            root: join(root, "missing"),
            session: "s",
            cwd: root,
            live: () => [entry("live")],
        });
        let state: SearchSnapshot | undefined;
        await source.scan("global", (next) => {
            state = next;
        });
        expect(state?.storageUnavailable).toBe(true);
        expect(state?.rows).toHaveLength(1);
        expect(state?.loading).toBe(false);
    },
    integrationTimeout,
);

test(
    "project live entries obey recorded session cwd, never the current process cwd",
    async () => {
        const root = await fixture();
        const a = join(root, "a");
        const b = join(root, "b");
        await mkdir(a);
        await mkdir(b);
        const source = new HistorySource({
            root,
            session: "B",
            cwd: a,
            sessionCwd: b,
            live: () => [entry("only B")],
        });
        const snapshots: SearchSnapshot[] = [];
        await source.scan("project", (state) => {
            snapshots.push(state);
        });
        expect(snapshots.every((state) => state.rows.length === 0)).toBe(true);
        await source.scan("session", (state) => {
            snapshots.push(state);
        });
        expect(snapshots.at(-1)?.rows.at(0)?.cwd).toBe(b);
        source.cancel();
    },
    integrationTimeout,
);

test(
    "file progress is batched, final snapshots stay immutable and every open rescans storage",
    async () => {
        const root = await fixture();
        await Promise.all(
            Array.from({ length: 96 }, async (_, i) =>
                writeFile(join(root, `${i}.jsonl`), transcript(`s${i}`, root, [`prompt ${i}`])),
            ),
        );
        const source = new HistorySource({ root, session: "live", cwd: root, live: () => [] });
        const snapshots: SearchSnapshot[] = [];
        vi.useFakeTimers();
        try {
            await source.scan("global", (state) => {
                snapshots.push(state);
            });
            expect(snapshots).toHaveLength(5); // initial + three 32-file batches + final
            expect(snapshots[0]?.rows).toHaveLength(0);
            expect(snapshots[1]?.rows).toHaveLength(32);
            expect(snapshots.at(-1)?.rows).toHaveLength(96);
            expect(snapshots.at(-1)?.loading).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
            await rm(join(root, "0.jsonl"));
            await writeFile(join(root, "new.jsonl"), transcript("new", root, ["fresh prompt"]));
            await source.scan("global", (state) => {
                snapshots.push(state);
            });
            expect(snapshots.at(-1)?.rows.some((row) => row.text === "prompt 0")).toBe(false);
            expect(snapshots.at(-1)?.rows.some((row) => row.text === "fresh prompt")).toBe(true);
            const pending = source.scan("global", (state) => {
                snapshots.push(state);

                if (state.rows.length > 0) source.cancel();
            });
            await pending;
            const count = snapshots.length;
            await vi.runAllTimersAsync();
            expect(snapshots).toHaveLength(count);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            source.cancel();
            vi.useRealTimers();
        }
    },
    integrationTimeout,
);

test("live replacement/deletion and reopen do not retain stale indexed prompts", async () => {
    let live = [entry("old", "a"), entry("duplicate", "b"), entry("duplicate", "c", "2027-01-01")];
    const source = new HistorySource({
        root: "/unused",
        session: "live",
        cwd: "/fixture",
        live: () => live,
    });
    const index = new HistoryIndex();
    const update = (state: SearchSnapshot) => {
        index.update(state.rows);
    };
    await source.scan("session", update);
    expect(index.query("duplicate")[0]?.entry).toBe("c");
    live = [entry("new", "a"), entry("duplicate", "b")];
    source.refreshLive();
    expect(index.query("old")).toEqual([]);
    expect(index.query("duplicate")[0]?.entry).toBe("b");
    expect(index.query("new")).toHaveLength(1);
    live = [];
    source.refreshLive();
    expect(index.query("")).toEqual([]);
    source.cancel();
    live = [entry("fresh", "d")];
    await source.scan("session", update);
    expect(index.query("").map((row) => row.text)).toEqual(["fresh"]);
    source.cancel();
});
