import { writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { decodeGlowupNode } from "../src/tools/protocol/decode.ts";
import { mutation, summary } from "../src/tools/protocol/nodes.ts";
import { protocolDecodingGolden } from "../test/support/protocol-decoding-corpus.ts";

const goldenPath = process.argv.indexOf("--golden");
if (goldenPath >= 0) {
    const path = process.argv.at(goldenPath + 1);
    if (path === undefined) throw new Error("--golden requires a path");

    writeFileSync(path, protocolDecodingGolden());
} else {
    const nodes = [
        mutation({ static: "Patch", running: "Patching", completed: "Patched" }, [
            {
                path: "src/generated.ts",
                added: 500,
                removed: 0,
                lines: Array.from({ length: 500 }, (_value, index) => ({
                    kind: "addition" as const,
                    text: `export const value${index} = ${index};`,
                    newLine: index + 1,
                })),
            },
        ]),
        summary(
            Array.from({ length: 500 }, (_value, index) => ({
                label: { kind: "text" as const, text: `field${index}`, tone: "accent" as const },
                value: `value${index}`,
            })),
        ),
    ];

    const run = () => {
        for (const node of nodes) {
            if (decodeGlowupNode(node) === undefined) throw new Error("Benchmark decode failed");
        }
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
        timings.push((performance.now() - start) / 2 / 10);
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
                decodes: 2000,
                milliseconds: elapsed,
                decodesPerSecond: 2_000_000 / elapsed,
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
