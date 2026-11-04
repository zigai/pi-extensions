import { randomBytes, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../test/support/theme-colors.ts";
import { createExplorationFeature } from "../src/tools/built-in/exploration.ts";
import { buildPierreDiffPayload } from "../src/rendering/diff/payload.ts";
import {
    clearQueuedDiffHighlights,
    pierreDiffHighlightStats,
    renderPierreDiff,
} from "../src/rendering/diff/pierre-renderer.ts";
import {
    clearCompletedLineCache,
    configureCompletedLineCache,
    completedLineCacheStats,
} from "../src/rendering/rendered-line-cache.ts";

const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
const hash = createHash("sha256");
async function collect(): Promise<void> {
    for (let index = 0; index < 6; index += 1) {
        global.gc?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}
function data(index: number, rows: number) {
    const oldContent = Array.from(
        { length: rows },
        (_value, n) => `const previous${n} = formatValue("old_${index}", ${n});`,
    ).join("\n");
    const newContent = Array.from(
        { length: rows },
        (_value, n) => `const next${n} = formatValue("new_${index}", ${n});`,
    ).join("\n");
    const result = buildPierreDiffPayload({
        path: `cache-${index}.txt`,
        oldContent,
        newContent,
        oldSizeBytes: Buffer.byteLength(oldContent),
        newSizeBytes: Buffer.byteLength(newContent),
        canBuildPierreDiff: true,
    });
    if (result?.kind !== "renderable") throw new Error("Expected renderable payload");
    return result;
}
async function hidden() {
    const feature = createExplorationFeature();
    const live: Component[] = [];
    const callbacks: (() => void)[] = [];
    await collect();
    const before = process.memoryUsage();
    function row() {
        const text = randomBytes(512 * 1024).toString("hex");
        const invalidate = () => {};
        callbacks.push(invalidate);
        const result = { content: [{ type: "text", text }] };
        const options = { syntaxPath: "source.txt", invalidate };
        feature.renderExplorationResult(result, true, theme, options);
        const component = feature.renderExplorationResult(result, false, theme, options);
        hash.update(JSON.stringify(component.render(80)));
        live.push(component);
    }
    for (let index = 0; index < 12; index += 1) row();
    await collect();
    const after = process.memoryUsage();
    return {
        live: live.length,
        callbacks: callbacks.length,
        sourceBytes: 12 * 1024 * 1024,
        heapDelta: after.heapUsed - before.heapUsed,
        externalDelta: after.external - before.external,
        accountedCacheBytes: completedLineCacheStats().completedLineCacheBytes,
    };
}
async function caches() {
    const count = Number(process.argv[3] ?? 30);
    const maxBytes = Number(process.argv[4] ?? 4096);
    if (!Number.isInteger(count) || count < 1 || !Number.isInteger(maxBytes) || maxBytes < 0)
        throw new Error("Invalid cache workload arguments");
    configureCompletedLineCache({ maxBytes, maxEntries: 10_000 });
    const live: Component[] = [];
    await collect();
    const before = process.memoryUsage();
    const start = performance.now();
    for (let index = 0; index < count; index += 1) {
        const component = renderPierreDiff(
            data(index, 400),
            theme,
            { expanded: true, expandedRows: "full" },
            { toolCallId: `cache-${index}`, lastComponent: undefined },
        );
        for (const width of [80, 180, 80]) hash.update(JSON.stringify(component.render(width)));
        live.push(component);
    }
    const creationMs = performance.now() - start;
    clearQueuedDiffHighlights();
    await collect();
    const after = process.memoryUsage();
    const held = {
        live: live.length,
        cacheBudgetBytes: maxBytes,
        heapDelta: after.heapUsed - before.heapUsed,
        externalDelta: after.external - before.external,
        accountedCacheBytes: completedLineCacheStats().completedLineCacheBytes,
        creationMs,
    };
    const redrawStart = performance.now();
    for (const component of live) {
        for (const width of [180, 80]) hash.update(JSON.stringify(component.render(width)));
    }
    return { ...held, redrawMs: performance.now() - redrawStart };
}
async function queue() {
    let component: Component | undefined;
    let invalidations = 0;
    const start = performance.now();
    for (let index = 0; index < 100; index += 1) {
        component = renderPierreDiff(
            data(index, 1),
            theme,
            { expanded: true },
            {
                toolCallId: "one",
                lastComponent: component,
                invalidate() {
                    invalidations += 1;
                },
            },
        );
    }
    const pending = pierreDiffHighlightStats();
    while (
        pierreDiffHighlightStats().queuedHighlights > 0 ||
        pierreDiffHighlightStats().activeHighlights > 0
    ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        if (performance.now() - start > 30_000) throw new Error("Highlight queue did not drain");
    }
    hash.update(JSON.stringify(component?.render(80)));
    return {
        updates: 100,
        queued: pending.queuedHighlights,
        elapsedMs: performance.now() - start,
        invalidations,
    };
}
const scenario = process.argv[2] ?? "queue";
try {
    let result: unknown;
    if (scenario === "queue") result = await queue();
    else if (scenario === "hidden") result = await hidden();
    else if (scenario === "caches") result = await caches();
    else throw new Error("Choose queue, hidden, or caches");
    console.log(
        JSON.stringify({ scenario, result, ansiSha256: hash.digest("hex"), node: process.version }),
    );
} finally {
    clearQueuedDiffHighlights();
    clearCompletedLineCache();
}
