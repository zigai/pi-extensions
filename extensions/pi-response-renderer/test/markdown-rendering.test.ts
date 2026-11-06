import assert from "node:assert/strict";
import { test } from "vitest";

import { collapseAssistantBlankLines } from "../src/markdown-rendering.ts";

test("keeps boundary blanks while collapsing only interior paragraph gaps", () => {
    assert.deepEqual(collapseAssistantBlankLines([], "", new Set()), []);
    assert.deepEqual(collapseAssistantBlankLines([""], "", new Set()), [""]);
    assert.deepEqual(
        collapseAssistantBlankLines(
            ["", "First paragraph.", "", "Last paragraph.", ""],
            "",
            new Set(),
        ),
        ["", "First paragraph.", "Last paragraph.", ""],
    );
});

test("shares plain-line classification without losing ANSI, heading, intro or table boundaries", () => {
    const paragraph = "\u001b[31mA rendered paragraph with punctuation.\u001b[0m";
    const next = "A second rendered paragraph with punctuation.";
    assert.deepEqual(collapseAssistantBlankLines([paragraph, "\u001b[0m ", next], "", new Set()), [
        paragraph,
        next,
    ]);
    assert.deepEqual(collapseAssistantBlankLines(["Introduction:", "", "- item"], "", new Set()), [
        "Introduction:",
        "- item",
    ]);
    assert.deepEqual(collapseAssistantBlankLines(["Micro heading", "", next], "", new Set()), [
        "Micro heading",
        "",
        next,
    ]);
    assert.deepEqual(
        collapseAssistantBlankLines([paragraph, "", next], "", new Set(), new Set([next])),
        [paragraph, "", next],
    );
    assert.deepEqual(collapseAssistantBlankLines([paragraph, "", next], "", new Set([next])), [
        paragraph,
        "",
        next,
    ]);
    assert.deepEqual(collapseAssistantBlankLines([paragraph, "", next], "\u001b[31m", new Set()), [
        paragraph,
        "",
        next,
    ]);
    assert.deepEqual(collapseAssistantBlankLines([paragraph, "", next], "", new Set()), [
        paragraph,
        next,
    ]);
});

test("removes fence rows before evaluating blank-line adjacency in the same pass", () => {
    const lines = ["Introduction:", "", "\u001b[31m```ts\u001b[0m", "- item", "```"];
    assert.deepEqual(collapseAssistantBlankLines(lines, "", new Set(), undefined, true), [
        "Introduction:",
        "- item",
    ]);
    assert.deepEqual(collapseAssistantBlankLines(lines, "", new Set()), [
        "Introduction:",
        lines[2],
        "- item",
        "```",
    ]);
    assert.deepEqual(collapseAssistantBlankLines(["", "```", ""], "", new Set(), undefined, true), [
        "",
        "",
    ]);
});
