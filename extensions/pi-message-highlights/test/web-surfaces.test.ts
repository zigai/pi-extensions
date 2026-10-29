import assert from "node:assert/strict";
import { test } from "vitest";
import { Markdown, Text, stripTerminalSequences, type MarkdownTheme } from "@earendil-works/pi-tui";
import {
    highlightWebLinkLabels,
    highlightFallbackMarkdownLinkLabels,
} from "../src/highlight-text.ts";
import {
    installMessageHighlightPatch,
    loadMessageHighlightTargets,
} from "../src/message-highlight-patch.ts";
import { DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG } from "../src/settings.ts";

const blue = "\u001b[38;2;135;215;255m";
const identity = (value: string) => value;
const markdownTheme: MarkdownTheme = {
    heading: identity,
    link: identity,
    linkUrl: identity,
    code: identity,
    codeBlock: identity,
    codeBlockBorder: identity,
    quote: identity,
    quoteBorder: identity,
    hr: identity,
    listBullet: identity,
    bold: identity,
    italic: identity,
    strikethrough: identity,
    underline: identity,
};

test("OSC 8 links color only web destinations without touching the link controls", () => {
    const line =
        "\u001b]8;;https://example.com\u0007docs\u001b]8;;\u0007 and \u001b]8;;mailto:a@b\u0007mail\u001b]8;;\u0007";
    const result = highlightWebLinkLabels(line, blue);
    assert.ok(result.includes(`${blue}docs`));
    assert.ok(!result.includes(`${blue}mail`));
    assert.equal(stripTerminalSequences(result), stripTerminalSequences(line));
});

test("fallback label matching is conservative about ambiguity and code", () => {
    const source = "see [docs](https://example.com)";
    const line = "see docs (https://example.com)";
    assert.ok(highlightFallbackMarkdownLinkLabels([line], source, blue)[0].includes(`${blue}docs`));
    assert.deepEqual(highlightFallbackMarkdownLinkLabels([line, line], source, blue), [line, line]);
    assert.deepEqual(highlightFallbackMarkdownLinkLabels([line], `\`${source}\``, blue), [line]);
});

test("real Text widget and Markdown web labels are patched and disposed", async () => {
    const targets = await loadMessageHighlightTargets();
    assert.ok(targets);
    const text = new Text("tool output https://example.com tail", 0, 0);
    const markdown = new Markdown("[docs](https://example.com)", 0, 0, markdownTheme);
    const before = text.render(100).join("\n");
    const patch = installMessageHighlightPatch(
        targets,
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    try {
        const result = text.render(100).join("\n");
        assert.ok(result.includes(`${blue}https://example.com`));
        assert.equal(stripTerminalSequences(result), stripTerminalSequences(before));
        assert.ok(markdown.render(100).join("\n").includes(`${blue}docs`));
    } finally {
        patch.dispose();
    }
    assert.equal(text.render(100).join("\n"), before);
});

test("unknown assistant structure is left untouched rather than guessing thinking identity", () => {
    const nested = new Text("https://example.com", 0, 0);
    const assistantPrototype = { render: (width: number) => nested.render(width) };
    const userPrototype = { render: () => [] };
    const editorPrototype = { render: () => [] };
    const baseline = assistantPrototype.render(80);
    const patch = installMessageHighlightPatch(
        { assistantPrototype, userPrototype, editorPrototype },
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    try {
        assert.deepEqual(assistantPrototype.render(80), baseline);
    } finally {
        patch.dispose();
    }
});

test("OSC 8 link state spans lines and closes or switches destinations", async () => {
    const { highlightWebLinkLabelLines } = await import("../src/highlight-text.ts");
    const lines = [
        "before \u001b]8;id=one;https://example.com\u0007first",
        "second \u001b]8;;mailto:a@b\u0007mail",
        "still mail\u001b]8;;https://other.example\u001b\\third",
        "fourth\u001b]8;;\u0007 after",
        "plain",
    ];
    const result = highlightWebLinkLabelLines(lines, blue);
    assert.ok(result[0].includes(`${blue}first`));
    assert.ok(result[1].includes(`${blue}second `));
    assert.ok(!result[1].includes(`${blue}mail`));
    assert.ok(result[2].includes(`${blue}third`));
    assert.ok(result[3].includes(`${blue}fourth`));
    assert.ok(!result[3].includes(`${blue} after`));
    assert.ok(!result[4].includes(blue));
    assert.deepEqual(result.map(stripTerminalSequences), lines.map(stripTerminalSequences));
    assert.deepEqual(highlightWebLinkLabelLines(lines, ""), lines);
});

test("Text renderer colors an OSC 8 label across wrapping and stops at close", async () => {
    const targets = await loadMessageHighlightTargets();
    assert.ok(targets);
    const content =
        "\u001b]8;;https://example.com\u0007abcdefghijklmnopqrstuv\u001b]8;;\u0007 tail";
    const text = new Text(content, 0, 0);
    const patch = installMessageHighlightPatch(
        targets,
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    try {
        const lines = text.render(10);
        const labelLines = lines.filter((line) =>
            /abcdef|klmnop|uv/.test(stripTerminalSequences(line)),
        );
        assert.ok(labelLines.length >= 2);
        for (const line of labelLines) assert.ok(line.includes(blue));
        const closing = lines.find((line) => stripTerminalSequences(line).includes("tail"));
        if (closing === undefined) assert.fail("missing tail line");
        assert.ok(!closing.includes(`${blue}tail`));
    } finally {
        patch.dispose();
    }
});
