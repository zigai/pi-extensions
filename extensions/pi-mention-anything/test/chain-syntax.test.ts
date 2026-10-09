import assert from "node:assert/strict";
import { test } from "vitest";

import { activeChainSegment, formatChain, parseMentions } from "../src/chain-syntax.ts";

const definitions = [{ id: "tmux", trigger: "t:", separator: ":" }] as const;

test("parses independently quoted and escaped segments", () => {
    const text = String.raw`open t:"work:remote":"api logs":pane\:0 now`;

    assert.deepEqual(parseMentions(text, definitions), [
        {
            sourceId: "tmux",
            trigger: "t:",
            start: 5,
            end: 39,
            segments: ["work:remote", "api logs", "pane:0"],
            complete: true,
        },
    ]);
});

test("uses the longest trigger and leaves sentence punctuation unowned", () => {
    const parsed = parseMentions("See (team:core), then t:one!", [
        { id: "short", trigger: "t:" },
        { id: "long", trigger: "team:" },
    ]);

    assert.deepEqual(parsed, [
        {
            sourceId: "long",
            trigger: "team:",
            start: 5,
            end: 14,
            segments: ["core"],
            complete: true,
        },
        {
            sourceId: "short",
            trigger: "t:",
            start: 22,
            end: 27,
            segments: ["one"],
            complete: true,
        },
    ]);
});

test("reports incomplete empty, trailing-separator, and unterminated quoted chains", () => {
    assert.deepEqual(
        parseMentions('t: t:work: t:"remote', definitions).map((mention) => ({
            segments: mention.segments,
            complete: mention.complete,
        })),
        [
            { segments: [], complete: false },
            { segments: ["work"], complete: false },
            { segments: ["remote"], complete: false },
        ],
    );
});

test("locates an earlier active segment and owns invalid descendants", () => {
    const text = "before t:work:api:logs after";
    const active = activeChainSegment(text, definitions, 11);
    assert.equal(active?.index, 0);
    assert.equal(active.query, "wo");
    assert.deepEqual(active.path, []);
    assert.equal(active.start, 9);
    assert.equal(active.ownedEnd, 22);
});

test("locates the empty segment after a separator", () => {
    const text = "t:work:";

    const active = activeChainSegment(text, definitions, text.length);
    assert.equal(active?.index, 1);
    assert.equal(active.query, "");
    assert.deepEqual(active.path, ["work"]);
    assert.equal(active.start, text.length);
    assert.equal(active.ownedEnd, text.length);
});

test("only an odd escape run protects trailing punctuation", () => {
    assert.deepEqual(parseMentions(String.raw`t:foo\\,`, definitions), [
        {
            sourceId: "tmux",
            trigger: "t:",
            start: 0,
            end: 7,
            segments: ["foo\\"],
            complete: true,
        },
    ]);
});

test("formatting round-trips punctuation, separators, quotes, escapes, and Unicode", () => {
    const segments = ["work:remote", "api logs", 'pane "zero"', String.raw`C:\tmp`, "東京", "x,"];
    const formatted = formatChain(segments, "t:", ":");

    assert.equal(
        formatted,
        String.raw`t:"work:remote":"api logs":"pane \"zero\"":"C:\\tmp":東京:"x,"`,
    );
    assert.deepEqual(parseMentions(formatted, definitions)[0]?.segments, segments);
});

test("rejects duplicate triggers rather than selecting by registration order", () => {
    assert.throws(
        () =>
            parseMentions("t:item", [
                { id: "one", trigger: "t:" },
                { id: "two", trigger: "t:" },
            ]),
        /Duplicate mention trigger: t:/,
    );
});
