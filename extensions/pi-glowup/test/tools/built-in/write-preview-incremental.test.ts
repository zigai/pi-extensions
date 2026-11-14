import { createHash } from "node:crypto";
import { fc } from "@fast-check/vitest";
import type { Component } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { exactFrames, theme } from "../../../benchmark/write-preview.ts";
import { renderWriteCallPreview } from "../../../src/tools/built-in/write-preview.ts";

// Captured from the frozen /tmp/pi-glowup-round3/baseline before implementation.
// Includes every ANSI byte, every update and every resize, not stripped text.
test("matches frozen baseline ANSI through CRLF, grapheme edges, rewrites and resizing", () => {
    const frames = exactFrames(renderWriteCallPreview);
    expect(frames).toHaveLength(1240);
    expect(createHash("sha256").update(JSON.stringify(frames)).digest("hex")).toBe(
        "b68860658f4740447e73fb7a6e8c7a308943c1c33d223d514ad5c50b9055fe5d",
    );
});

test("incremental writes equal cold renders with deferred draws and non-append display streams", () => {
    fc.assert(
        fc.property(
            fc.array(
                fc.record({
                    chunk: fc.constantFrom(
                        "a",
                        "\r",
                        "\n",
                        "\ud83d",
                        "\ude00",
                        "e",
                        "\u0301",
                        "👩",
                        "\u200d",
                        "💻",
                        " ",
                        "x".repeat(2001),
                    ),
                    rewrite: fc.boolean(),
                    draw: fc.boolean(),
                    transformed: fc.boolean(),
                    width: fc.integer({ min: 14, max: 120 }),
                }),
                { minLength: 10, maxLength: 60 },
            ),
            (updates) => {
                for (const movingViewport of [false, true]) {
                    let previous: Component | undefined;
                    let content = "";
                    for (const update of updates) {
                        if (update.rewrite)
                            content = content.slice(0, Math.floor(content.length / 2));

                        content += update.chunk;
                        const streamCode = ({ source }: { source: string }): string => {
                            if (update.transformed) return source.slice(-40);
                            return source;
                        };
                        const context = {
                            toolCallId: "property-write",
                            isError: false,
                            isPartial: true,
                            argsComplete: false,
                            expanded: false,
                            movingViewport,
                            streamCode,
                        };
                        previous = renderWriteCallPreview({ path: "notes.txt", content }, theme, {
                            ...context,
                            lastComponent: previous,
                        });

                        if (!update.draw) continue;

                        const cold = renderWriteCallPreview(
                            { path: "notes.txt", content },
                            theme,
                            context,
                        );
                        for (const width of [update.width, 80, update.width]) {
                            expect(previous.render(width)).toEqual(cold.render(width));
                        }
                    }
                }
            },
        ),
        { seed: 0xabc123, numRuns: 40 },
    );
});

test("snapshots primitive args when the producer mutates its object in place", () => {
    const args = { path: "notes.txt", content: "one\n" };
    const context = {
        toolCallId: "mutable-args",
        isError: false,
        isPartial: true,
        expanded: false,
        streamCode: ({ source }: { source: string }) => source,
    };
    let previous = renderWriteCallPreview(args, theme, context);
    previous.render(80);

    for (const content of ["one\ntwo\n", "replacement\n", "replacement\nnext", "", "final\n"]) {
        args.content = content;
        previous = renderWriteCallPreview(args, theme, { ...context, lastComponent: previous });
        const cold = renderWriteCallPreview(args, theme, context);
        for (const width of [80, 20, 80])
            expect(previous.render(width)).toEqual(cold.render(width));
    }
});

test("retains bounded blank-line sampling and raw LF-only streaming statistics", () => {
    for (const movingViewport of [false, true]) {
        let previous: Component | undefined;
        for (const content of [
            "first\n",
            `first\n${" \r\n".repeat(2000)}`,
            `first\n${" \r\n".repeat(2000)}last`,
            "first\rlast\r",
            "first\rlast\r\n",
        ]) {
            const context = {
                toolCallId: "blank-write",
                isError: false,
                isPartial: true,
                expanded: false,
                movingViewport,
                streamCode: ({ source }: { source: string }) => source,
            };
            previous = renderWriteCallPreview({ path: "notes.txt", content }, theme, {
                ...context,
                lastComponent: previous,
            });
            const cold = renderWriteCallPreview({ path: "notes.txt", content }, theme, context);
            expect(previous.render(80)).toEqual(cold.render(80));
        }
    }
});
