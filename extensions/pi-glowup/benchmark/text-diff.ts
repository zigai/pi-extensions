import { Theme } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { renderGlowupDiff } from "../src/rendering/diff/text-renderer.ts";
import { textDiffGolden } from "../test/support/text-diff-corpus.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../test/support/theme-colors.ts";

const goldenPath = process.argv.indexOf("--golden");
if (goldenPath >= 0) {
    const path = process.argv.at(goldenPath + 1);
    if (path === undefined) throw new Error("--golden requires a path");

    writeFileSync(path, await textDiffGolden());
} else {
    const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");

    const sections = [
        {
            path: "generated.txt",
            added: 600,
            removed: 0,
            lines: Array.from(
                { length: 600 },
                (_value, index) => `+${index + 1} generated value ${index}`,
            ),
        },
    ];

    const run = () => {
        renderGlowupDiff(theme, sections, false).render(120);
    };

    for (let index = 0; index < 20; index++) run();
    globalThis.gc?.();

    const session = new Session();
    const allocations = process.argv.includes("--allocations");
    if (allocations) {
        session.connect();
        await session.post("HeapProfiler.startSampling", {
            samplingInterval: 16384,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
        });
    }

    const startingHeap = process.memoryUsage().heapUsed;
    const cpu = process.cpuUsage();
    const timings: number[] = [];
    const started = performance.now();

    for (let sample = 0; sample < 100; sample++) {
        const start = performance.now();

        for (let index = 0; index < 10; index++) run();
        timings.push((performance.now() - start) / 10);
    }

    const elapsed = performance.now() - started;
    const cpuUsage = process.cpuUsage(cpu);
    let sampledAllocatedBytes: number | undefined;
    if (allocations) {
        const { profile } = await session.post("HeapProfiler.stopSampling");
        const size = (node: HeapProfiler.SamplingHeapProfileNode): number =>
            node.selfSize + node.children.reduce((sum, child) => sum + size(child), 0);

        sampledAllocatedBytes = size(profile.head);
        session.disconnect();
    }

    globalThis.gc?.();
    timings.sort((a, b) => a - b);
    console.log(
        JSON.stringify(
            {
                renders: 1000,
                milliseconds: elapsed,
                rendersPerSecond: 1_000_000 / elapsed,
                p50: timings[49],
                p95: timings[94],
                p99: timings[98],
                cpuMilliseconds: (cpuUsage.user + cpuUsage.system) / 1000,
                peakRssKiB: process.resourceUsage().maxRSS,
                retainedHeapBytes: process.memoryUsage().heapUsed - startingHeap,
                sampledAllocatedBytes,
            },
            null,
            2,
        ),
    );
}
