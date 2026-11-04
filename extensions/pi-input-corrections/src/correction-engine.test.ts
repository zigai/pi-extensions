import { describe, expect, it } from "vitest";
import {
    createCorrectionEngine,
    MAX_INPUT_LENGTH,
    MAX_REGEX_INPUT_LENGTH,
    type CorrectionRule,
} from "./correction-engine.ts";

function engine(rules: CorrectionRule[] = [], trailingQuestionMark = true, enabled = true) {
    return createCorrectionEngine({ enabled, trailingQuestionMark, rules });
}

const literal = (find: string, replacement: string): CorrectionRule => ({
    name: "test",
    find,
    replacement,
});

const regex = (find: string, replacement = "fixed", flags = "g"): CorrectionRule => ({
    name: "test",
    kind: "regex",
    find,
    replacement,
    flags,
});

describe("guarded trailing apostrophe", () => {
    it.each([
        ["can you help'", "can you help?"],
        ["can you help' \n", "can you help? \n"],
        ["why isn't it working'", "why isn't it working?"],
        ["what about 'quoted text' now'", "what about 'quoted text' now?"],
        ["what about naïve café'", "what about naïve café?"],
    ])("corrects %s", (input, output) => expect(engine().correct(input)).toBe(output));

    it.each([
        "",
        "'",
        "dogs'",
        "why'",
        "don't",
        "I'm ready",
        "what is this?",
        "why??",
        "what is this? ",
        "what is 'this'",
        "what is 'this",
        "what is 'don't'",
        "what is this\\'",
        "what is this\\\\'",
        'what is "this\'"',
        "`what is this'`",
        "`what is this'",
        "what is https://example.org/path'",
        "what is www.example.org/path'",
        "/help'",
        " /skill:foo what is this'",
        "!echo hello'",
        "```\nwhat is this'\n```",
        "~~~\nwhat is this'",
        "    what is this'",
        "const value = hello'",
        "foo => hello'",
    ])("preserves %s", (input) => expect(engine().correct(input)).toBe(input));

    it("can disable built-in independently or disable everything", () => {
        expect(engine([], false).correct("what is this'")).toBe("what is this'");
        expect(engine([literal("what", "why")], true, false).correct("what is this'")).toBe(
            "what is this'",
        );
    });
});

describe("ordered configured corrections", () => {
    it("applies built-in first and each rule exactly once in order", () => {
        expect(
            engine([literal("?", "ready"), literal("ready", "ready again")]).correct("are you'"),
        ).toBe("are youready again");

        expect(engine([literal("a", "aa")], false).correct("a")).toBe("aa");
    });

    it("uses literal find/replacement, all occurrences and optional defaults", () => {
        expect(engine([literal("a*b", "$&$1")], false).correct("a*b a*b axb")).toBe(
            "$&$1 $&$1 axb",
        );
    });

    it("supports regex flags, anchors, word boundaries, classes and one repetition", () => {
        const rule = regex("\\bfoo[0-9]+\\b", "$1", "gi");
        const correct = engine([rule], false).correct;
        expect(correct("FOO12 foo3")).toBe("$1 $1");
        expect(correct("FOO12 foo3")).toBe("$1 $1");
        expect(engine([regex("^foo$", "ok", "gm")], false).correct("foo\nfoo")).toBe("ok\nok");
        expect(engine([regex("foo", "ok", "")], false).correct("foo foo")).toBe("ok foo");
    });

    it("protects quoted/code/URL spans and matches crossing them", () => {
        const correct = engine([literal("foo", "bar")], false).correct;
        expect(correct("foo \"foo\" 'foo' `foo` https://foo.org www.foo.org foo")).toBe(
            "bar \"foo\" 'foo' `foo` https://foo.org www.foo.org bar",
        );

        expect(engine([regex("foo.*", "bad")], false).correct('foo "literal"')).toBe(
            'foo "literal"',
        );

        expect(correct("foo 'foo")).toBe("bar 'foo");
        expect(correct("foo “foo” ‘foo’")).toBe("bar “foo” ‘foo’");
        expect(correct("```foo```")).toBe("```foo```");
    });

    it("preserves path tokens while correcting adjacent prose", () => {
        const correct = engine([regex("\\bteh\\b", "the")], false).correct;
        expect(correct("please edit /tmp/teh/file.ts and src/teh.ts then teh text")).toBe(
            "please edit /tmp/teh/file.ts and src/teh.ts then the text",
        );

        expect(
            correct("open ./teh/file ../teh/file ~/teh/file C:\\teh\\file and teh.ts with teh"),
        ).toBe("open ./teh/file ../teh/file ~/teh/file C:\\teh\\file and teh.ts with the");
    });

    it("bounds regex separately from linear built-in and literal rules", () => {
        const text = "a ".repeat(MAX_REGEX_INPUT_LENGTH) + "can you help'";
        expect(engine([regex("help", "assist")]).correct(text)).toBe(text.slice(0, -1) + "?");
        expect(engine([literal("help", "assist")]).correct(text)).toBe(
            text.slice(0, -5) + "assist?",
        );
    });

    it("replaces opt-in words only at Unicode-aware boundaries, not identifiers or flags", () => {
        const correct = engine(
            [{ name: "word", kind: "word", find: "teh", replacement: "the" }],
            false,
        ).correct;
        expect(
            correct("teh teh! (teh) TEH teh_suffix suffixteh teh2 éteh tehé 𐐀teh teh𐐀 tehe\u0301"),
        ).toBe("the the! (the) TEH teh_suffix suffixteh teh2 éteh tehé 𐐀teh teh𐐀 tehe\u0301");

        expect(correct("teh --teh -teh --option=teh foo.teh.value .teh src/teh.ts and teh")).toBe(
            "the --teh -teh --option=teh foo.teh.value .teh src/teh.ts and the",
        );

        expect(
            engine(
                [{ name: "invalid word", kind: "word", find: "two words", replacement: "x" }],
                false,
            ).diagnostics,
        ).toHaveLength(1);
    });

    it("recomputes protection after each rule", () => {
        expect(
            engine([literal("foo", '"bar"'), literal("bar", "oops")], false).correct("foo"),
        ).toBe('"bar"');
    });

    it.each([
        {
            name: "shorter output shifts protected quotes",
            rules: [literal("prefix", ""), literal("word", "fixed")],
            input: "prefix 'word' word",
            output: " 'word' fixed",
        },
        {
            name: "word changes turn a contraction into an opening quote",
            rules: [literal("prefix", " "), literal("word", "fixed")],
            input: "prefix'word and word",
            output: " 'word and word",
        },
        {
            name: "all replacements within one rule use its original protection",
            rules: [literal("mark", "'"), literal("word", "fixed")],
            input: "mark word mark",
            output: "' word '",
        },
        {
            name: "new code syntax stops later corrections",
            rules: [literal("seed", "const value"), literal("value", "fixed")],
            input: "seed",
            output: "const value",
        },
    ])("reclassifies changed text: $name", ({ rules, input, output }) => {
        expect(engine(rules, false).correct(input)).toBe(output);
    });

    it("does not revisit a skipped earlier rule when a later rule creates its match", () => {
        expect(
            engine([literal("target", "fixed"), literal("seed", "target")], false).correct("seed"),
        ).toBe("target");
    });

    it("does not advance a nonglobal regex beyond a protected first match", () => {
        expect(engine([regex("word", "fixed", "")], false).correct("'word' word")).toBe(
            "'word' word",
        );
    });

    it("keeps protection local to each input, including identity replacements", () => {
        const correct = engine([literal("word", "word"), literal("word", "fixed")], false).correct;
        expect(correct("'word' word")).toBe("'word' fixed");
        expect(correct("word 'word'")).toBe("fixed 'word'");
        expect(correct("word")).toBe("fixed");
    });

    it("skips disabled rules without diagnostics", () => {
        const result = engine([{ ...regex("("), enabled: false }], false);
        expect(result.diagnostics).toEqual([]);
        expect(result.correct("hello")).toBe("hello");
    });

    it.each([
        "",
        "[",
        "(",
        "a|b",
        "(a+)+",
        "a+a+",
        "a{2}",
        "a*",
        "a?",
        "^$",
        "\\b",
        "(?=a)",
        "\\1",
        "\\p{L}",
        "[a-z]**",
    ])("rejects unsafe or empty pattern %s", (find) => {
        const result = engine([regex(find)], false);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.correct("hello aaaa")).toBe("hello aaaa");
        expect(result.diagnostics.join()).not.toContain(find + " secret");
    });

    it.each(["gg", "v", "y", "d", "z", "G"])("rejects flag %s without exposing config", (flags) => {
        const result = engine([
            { ...regex("secret-pattern", "secret-replacement", flags), name: "secret-name" },
        ]);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics.join()).not.toContain("secret");
    });

    it("uses UTF-16 size limits without splitting astral characters", () => {
        const correct = engine([literal("😀", "x")], false).correct;
        expect(correct("😀".repeat(MAX_INPUT_LENGTH / 2))).toBe("x".repeat(MAX_INPUT_LENGTH / 2));
        const oversized = "😀".repeat(MAX_INPUT_LENGTH / 2 + 1);
        expect(correct(oversized)).toBe(oversized);
    });

    it("includes combining marks and astral letters in word boundaries without normalization", () => {
        const correct = engine(
            [{ name: "word", kind: "word", find: "café", replacement: "coffee" }],
            false,
        ).correct;
        expect(correct("café café́ 𐐀café café𐐀 café")).toBe("coffee café́ 𐐀café café𐐀 café");
    });

    it("accepts exact output capacity and rolls back earlier built-in changes on overflow", () => {
        const correct = engine([literal("a", "b".repeat(1024))]).correct;
        expect(correct("a".repeat(128))).toBe("b".repeat(131_072));
        const prompt = "a".repeat(128) + " why'";
        expect(correct(prompt)).toBe(prompt);
    });

    it("runs regex rules at the exact regex size limit but not one unit above it", () => {
        const correct = engine([regex("^a", "b")], false).correct;
        expect(correct("a".repeat(MAX_REGEX_INPUT_LENGTH))).toBe(
            "b" + "a".repeat(MAX_REGEX_INPUT_LENGTH - 1),
        );
        const oversized = "a".repeat(MAX_REGEX_INPUT_LENGTH + 1);
        expect(correct(oversized)).toBe(oversized);
    });

    it("bounds input and output without truncation", () => {
        const large = "a".repeat(MAX_INPUT_LENGTH + 1);
        expect(engine([literal("a", "b")], false).correct(large)).toBe(large);
        expect(engine([literal("a", "b")], false).correct("a".repeat(MAX_INPUT_LENGTH))).toBe(
            "b".repeat(MAX_INPUT_LENGTH),
        );

        expect(engine([literal("a", "b".repeat(1024))], false).correct("a".repeat(200))).toBe(
            "a".repeat(200),
        );

        expect(
            engine([literal("a", "bb"), literal("b", "c")], false).correct("a".repeat(40_000)),
        ).toBe("b".repeat(80_000));
    });
});
