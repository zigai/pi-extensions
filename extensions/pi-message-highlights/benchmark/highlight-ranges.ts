import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { highlightEditorRenderLines } from "../src/editor-highlighting.ts";
import { collectHighlightRanges, type HighlightStyles } from "../src/highlight-text.ts";

// Informational only. The editor measurement covers this extension's viewport
// decoration, not native Editor layout, terminal painting, or complete input latency.
type Variant = "urls" | "paths" | "bare-single-line" | "mixed";

function iterations(argument: string | undefined, fallback: number): number {
    const value = Number(argument ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 100)
        throw new RangeError("Benchmark iterations must be an integer from 1 through 100");

    return value;
}

function reference(variant: Variant, index: number): string {
    if (variant === "urls") return `See https://example.test/report/${index}/src/file.ts`;
    if (variant === "paths") return `Read /workspace/project-${index}/src/file.ts`;
    if (variant === "bare-single-line") return `file-${index}.ts`;

    return `See https://example.test/(src/file-${index}.ts) and /workspace/file-${index}.ts`;
}

const repeats = iterations(process.argv[2], 5);
const redraws = iterations(process.argv[3], 20);
const variants: readonly Variant[] = ["urls", "paths", "bare-single-line", "mixed"];
const styles: HighlightStyles = { url: "\u001b[36m", filepath: "\u001b[33m" };
console.log(JSON.stringify({ node: process.version, repeats, redraws }));

for (const variant of variants) {
    for (const size of [500, 2000, 5000]) {
        const parts = Array.from({ length: size }, (_, index) => reference(variant, index));
        let separator = "\n";
        if (variant === "bare-single-line") separator = " ";

        const text = parts.join(separator);
        const visible = ["─".repeat(100), ...parts.slice(-8), "─".repeat(100)];
        const target = { getText: () => text, getPaddingX: () => 0, autocompleteState: null };

        for (let repeat = 0; repeat < repeats; repeat += 1) {
            global.gc?.();

            const started = performance.now();
            const ranges = collectHighlightRanges(text, styles);
            const collectMs = performance.now() - started;
            let frame: string[] = [];
            const redrawStarted = performance.now();

            for (let redraw = 0; redraw < redraws; redraw += 1)
                frame = highlightEditorRenderLines(target, 100, visible, styles);

            const redrawMs = performance.now() - redrawStarted;
            let expectedRanges = size;
            if (variant === "mixed") expectedRanges *= 2;
            assert.equal(ranges.length, expectedRanges);
            console.log(
                JSON.stringify({
                    variant,
                    size,
                    repeat,
                    bytes: Buffer.byteLength(text, "utf8"),
                    collectMs,
                    redrawMs,
                    ranges: ranges.length,
                    rangeDigest: createHash("sha256").update(JSON.stringify(ranges)).digest("hex"),
                    frameDigest: createHash("sha256").update(JSON.stringify(frame)).digest("hex"),
                }),
            );
        }
    }
}
