import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import type { Component } from "@earendil-works/pi-tui";
import { renderWriteCallPreview } from "../src/tools/built-in/write-preview.ts";

export const theme = {
    fg: (_token: string, text: string) => `\x1b[36m${text}\x1b[39m`,
    bg: (_token: string, text: string) => `\x1b[44m${text}\x1b[49m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

export function sources(): string[] {
    const updates = [""];
    let source = "";

    const chunks = [
        " \r",
        "\n",
        "first\r",
        "\nsecond\n",
        "\n\n",
        "third\n",
        "fourth\nfifth\nsixth\nseventh\n",
        "😀e",
        "\u0301👩",
        "\u200d💻\r",
        "\n",
        "x".repeat(1998),
        "\ud83d",
        "\ude00",
        "\u0301",
        "tail\n",
        " ".repeat(2001),
        "visible beyond bound\n",
        "last",
    ];
    for (const chunk of chunks) {
        source += chunk;
        updates.push(source);
    }

    updates.push("REWRITE\r", "REWRITE\r\n", "REWRITE\r\nnew", "", "final\n");

    // Every UTF-16 boundary, including surrogate/ZWJ/combining and budget edges.
    for (const text of ["👩\u200d💻e\u0301🇦🇧\r\nend", `${"a".repeat(1998)}e\u0301👩\u200d💻!`]) {
        updates.push("");

        const start = Math.max(1, text.length - 18);
        for (let end = start; end <= text.length; end += 1) updates.push(text.slice(0, end));
    }

    return updates;
}

export function exactFrames(render: typeof renderWriteCallPreview): string[][] {
    const frames: string[][] = [];
    for (const movingViewport of [false, true]) {
        for (const streamed of [false, true]) {
            let previous: Component | undefined;
            for (const content of sources()) {
                previous = render({ path: "notes.txt", content }, theme, {
                    toolCallId: "exact-write",
                    isError: false,
                    isPartial: true,
                    expanded: false,
                    argsComplete: false,
                    movingViewport,
                    lastComponent: previous,
                    ...(streamed && { streamCode: ({ source }) => source }),
                });
                for (const width of [18, 40, 100, 23, 100]) frames.push(previous.render(width));
            }
        }
    }

    return frames;
}

async function retainedMemory(): Promise<void> {
    const collect = async (): Promise<void> => {
        for (let index = 0; index < 6; index += 1) {
            global.gc?.();
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    };
    await collect();
    const before = process.memoryUsage();
    let previous: Component | undefined;
    let content = "";
    for (let index = 0; index < 4000; index += 1) {
        content += `${"x".repeat(127)}\n`;
        previous = renderWriteCallPreview({ path: "notes.txt", content }, theme, {
            toolCallId: "write-retention",
            isError: false,
            isPartial: true,
            expanded: false,
            lastComponent: previous,
            streamCode: ({ source }) => source,
        });
        previous.render(100);
    }
    await collect();
    const after = process.memoryUsage();
    console.log(
        JSON.stringify({
            sourceChars: content.length,
            heapDelta: after.heapUsed - before.heapUsed,
            externalDelta: after.external - before.external,
            ansiSha256: createHash("sha256")
                .update(JSON.stringify(previous?.render(100) ?? []))
                .digest("hex"),
        }),
    );
}

async function main(): Promise<void> {
    if (process.argv.includes("--memory")) {
        await retainedMemory();
        return;
    }
    const render = renderWriteCallPreview;
    const frames = exactFrames(render);
    const capture = process.env.WRITE_PREVIEW_CAPTURE;
    if (capture !== undefined) writeFileSync(capture, JSON.stringify(frames));

    console.log(
        JSON.stringify({
            exactFrames: frames.length,
            hash: createHash("sha256").update(JSON.stringify(frames)).digest("hex"),
        }),
    );

    const chunk = `${"x".repeat(127)}\n`;
    for (const updates of [500, 1000, 2000, 4000]) {
        const times: number[] = [];
        let hash = "";
        for (let repeat = 0; repeat < 3; repeat += 1) {
            global.gc?.();

            let previous: Component | undefined;
            let content = "";
            const digest = createHash("sha256");
            const start = performance.now();

            for (let index = 0; index < updates; index += 1) {
                content += chunk;
                previous = render({ path: "notes.txt", content }, theme, {
                    toolCallId: "bench-write",
                    isError: false,
                    isPartial: true,
                    expanded: false,
                    argsComplete: false,
                    lastComponent: previous,
                    streamCode: ({ source }) => source,
                });
                digest.update(JSON.stringify(previous.render(100)));
            }

            times.push(performance.now() - start);
            hash = digest.digest("hex");
        }

        console.log(JSON.stringify({ updates, bytes: updates * 128, timesMs: times, hash }));
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
