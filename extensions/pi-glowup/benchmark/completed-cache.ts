import { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { writeHeapSnapshot } from "node:v8";
import {
    configureBuiltInToolRendererPatch,
    toolRendererPatchStats,
} from "../src/pi/patches/tool-execution-patch.ts";
import type { PiRendererDefinition } from "../src/tools/built-in/context.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../test/support/theme-colors.ts";

const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
const prototype = {
    getCallRenderer(): PiRendererDefinition["renderCall"] {
        return undefined;
    },
};

configureBuiltInToolRendererPatch(
    true,
    {
        renderCall: (_tool, _args, _theme, context) => ({
            render: (width) =>
                Array.from({ length: 2048 }, (_value, index) =>
                    truncateToWidth(
                        `\u001b[32m${context.toolCallId}:${index}: ${"x".repeat(120)}\u001b[39m`,
                        width,
                        "",
                    ),
                ),
            invalidate() {},
        }),
        renderResult: () => undefined,
    },
    prototype,
);

function create(id: string): Component {
    const component = prototype.getCallRenderer.call({ toolName: "read" })?.({}, theme, {
        args: {},
        state: {},
        toolCallId: id,
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: true,
        showImages: false,
        isError: false,
    });
    if (component === undefined) throw new Error("Expected cached completed component");
    return component;
}

async function collect(): Promise<void> {
    for (let index = 0; index < 6; index++) {
        await setImmediate();
        globalThis.gc?.();
    }

    await setImmediate();
}

const live = create("live");
const golden = createHash("sha256");
golden.update(JSON.stringify(live.render(80)));
await collect();

const startingHeap = process.memoryUsage().heapUsed;
const started = performance.now();
const cpu = process.cpuUsage();
const samples: number[] = [];
for (let index = 0; index < 100; index++) {
    const start = performance.now();

    create(`abandoned-${index}`).render(120);
    samples.push(performance.now() - start);
}

const elapsed = performance.now() - started;
const cpuUsed = process.cpuUsage(cpu);
const beforeCollection = toolRendererPatchStats(prototype);

await collect();

const retainedHeapBytes = process.memoryUsage().heapUsed - startingHeap;
const afterCollection = toolRendererPatchStats(prototype);

for (const width of [80, 40, 180, 40, 80]) golden.update(JSON.stringify(live.render(width)));
live.invalidate();
golden.update(JSON.stringify(live.render(80)));
samples.sort((a, b) => a - b);

const goldenPath = process.argv.indexOf("--golden");
if (goldenPath >= 0) {
    const path = process.argv.at(goldenPath + 1);
    if (path === undefined) throw new Error("--golden requires a path");

    writeFileSync(path, `${golden.digest("hex")}\n`);
}

const snapshot = process.argv.indexOf("--snapshot");
if (snapshot >= 0) {
    const path = process.argv.at(snapshot + 1);
    if (path === undefined) throw new Error("--snapshot requires a path");

    writeHeapSnapshot(path);
}

console.log(
    JSON.stringify(
        {
            milliseconds: elapsed,
            cpuMilliseconds: (cpuUsed.user + cpuUsed.system) / 1000,
            rendersPerSecond: 100000 / elapsed,
            p50: samples[49],
            p95: samples[94],
            p99: samples[98],
            peakRssKiB: process.resourceUsage().maxRSS,
            retainedHeapBytes,
            entriesBeforeCollection: beforeCollection.completedLineCacheEntries,
            entriesAfterCollection: afterCollection.completedLineCacheEntries,
            cacheBytesAfterCollection: afterCollection.completedLineCacheBytes,
        },
        null,
        2,
    ),
);

configureBuiltInToolRendererPatch(false, undefined, prototype);
