import assert from "node:assert/strict";
import { test } from "vitest";

import { highlightEditorRenderLines } from "../src/editor-highlighting.ts";
import type { HighlightStyles } from "../src/highlight-text.ts";

const ESC = String.fromCharCode(0x1b);
const styles: HighlightStyles = {
    url: "<url>",
    filepath: "<path>",
};

function stripTestStyles(text: string): string {
    return text.replaceAll("<url>", "").replaceAll("<path>", "").replaceAll(`${ESC}[39m`, "");
}

test("highlights editor paths across soft-wrapped rendered lines", () => {
    const target = {
        getText() {
            return "copy /mnt/d/Software/Linux Distros/Fedora-Server-dvd-x86_64-44-1.7.iso now";
        },
        getPaddingX() {
            return 0;
        },
        autocompleteState: null,
    };

    const renderedLines = [
        "────────────────────────────────────────",
        "copy /mnt/d/Software/Linux ",
        "Distros/Fedora-Server-dvd-x86_64-44-1.7.iso now",
        "────────────────────────────────────────",
    ];

    const highlighted = highlightEditorRenderLines(target, 60, renderedLines, styles);
    assert.deepEqual(highlighted.map(stripTestStyles), renderedLines);
    assert.equal(highlighted[1]?.includes(`<path>/mnt/d/Software/Linux${ESC}[39m `), true);
    assert.equal(
        highlighted[2]?.includes(`<path>Distros/Fedora-Server-dvd-x86_64-44-1.7.iso${ESC}[39m now`),
        true,
    );
});
