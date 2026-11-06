import { expect, test } from "vitest";
import { HistoryIndex } from "../src/history-index.ts";
import { matching, type Occurrence } from "../src/search.ts";

function row(text: string, entry: string, session = "s", timestamp = "2026-01-01"): Occurrence {
    return { text, entry, session, timestamp, cwd: "/fixture" };
}

const queries = ["", "a", "al", "ALPHA", "alpha fox", "fox", "β", "[.*]", " ", "absent"];

test("incremental snapshots preserve deterministic newest duplicate ordering across query changes", () => {
    const index = new HistoryIndex();
    const rows: Occurrence[] = [];

    const batches = [
        [row("Alpha\nfox [.*]", "1"), row("β fox", "2"), row("Alpha\nfox [.*]", "0")],
        [row("Alpha\nfox [.*]", "1", "z"), row("alpha only", "3")],
        [row("Alpha\nfox [.*]", "9", "z"), row("new fox", "0", "s", "2027-01-01")],
    ];
    for (const batch of batches) {
        rows.push(...batch);
        index.update(rows);

        for (const query of queries) expect(index.query(query)).toEqual(matching(rows, query));
    }

    index.update(rows.slice());
    expect(index.query("fox")).toEqual(matching(rows, "fox"));
});

test("replacements, same-length rewrites, truncation and fresh empty scans invalidate query caches", () => {
    const index = new HistoryIndex();
    const a = row("before", "1");
    const b = row("other", "2");
    for (const rows of [[a, b], [row("after!", "1"), b], [a], [], [b, a]]) {
        index.update(rows);

        for (const query of ["be", "before", "after", "", "other"])
            expect(index.query(query)).toEqual(matching(rows, query));
    }
});

test("many out-of-order append batches agree with the full sort oracle", () => {
    const index = new HistoryIndex();
    const rows: Occurrence[] = [];
    for (let batch = 0; batch < 20; batch++) {
        for (let i = 0; i < 31; i++) {
            const n = batch * 31 + i;
            rows.push(row(`text ${n % 97}`, String(n % 11), String(n % 7), String(n % 13)));
        }

        index.update(rows.slice());

        for (const query of ["", "text 1", "9", "text 97"])
            expect(index.query(query)).toEqual(matching(rows, query));
    }
});

test("large initial batches avoid argument-count limits", () => {
    const index = new HistoryIndex();
    const rows = Array.from({ length: 150_000 }, (_, i) => row(`prompt ${i}`, String(i)));
    index.update(rows);
    expect(index.query("prompt 149999")).toEqual([rows[149999]]);
    expect(index.query("")).toHaveLength(rows.length);
});

test("preserves stable source order for tied identities across merges and duplicate promotion", () => {
    const a = row("first", "same");
    const b = row("second", "same");
    const index = new HistoryIndex();
    index.update([a]);
    index.update([a, b]);
    expect(index.query("")).toEqual(matching([a, b], ""));
    const older = row("second", "old", "s", "2025-01-01");
    index.update([older, a, b]);
    expect(index.query("")).toEqual(matching([older, a, b], ""));
});

test("normalizes whitespace without changing Unicode, empty edges or lone surrogates", () => {
    const rows = [
        row(" \tAlpha\r\nβ\u00a0🦊 \u2028", "1"),
        row("\ud800 literal [.*]\udfff", "2"),
        row("\uFEFFMixed\tCASE", "3"),
        row("", "4"),
    ];

    const index = new HistoryIndex();
    index.update(rows);

    for (const query of ["", "alpha β", "β 🦊", "\ud800", "[.*]\udfff", "mixed case", "not found"])
        expect(index.query(query)).toEqual(matching(rows, query));
});
