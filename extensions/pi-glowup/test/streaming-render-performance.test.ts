import { performance } from "node:perf_hooks";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { CodexRenderTheme } from "../src/rendering.ts";
import { clearSyntaxHighlightCache, syntaxHighlightCacheStats } from "../src/syntax/highlighter.ts";
import { createThirdPartyToolRenderer } from "../src/third-party-renderers.ts";
import { renderWriteCallPreview } from "../src/write-rendering.ts";

const plainTheme: CodexRenderTheme = {
    fg(_token: string, text: string): string {
        return text;
    },
    bg(_token: string, text: string): string {
        return text;
    },
    bold(text: string): string {
        return text;
    },
};

type StreamingRenderMetrics = {
    readonly iterations: number;
    readonly elapsedMs: number;
    readonly heapDeltaBytes: number;
    readonly renderedLines: number;
    readonly renderedCharacters: number;
    readonly syntaxCacheEntries: number;
    readonly syntaxCacheBytes: number;
};

const renderContext = {
    args: {},
    toolCallId: "call-streaming-apply-patch",
    executionStarted: true,
    argsComplete: false,
    isPartial: true,
    expanded: false,
    showImages: false,
    isError: false,
};

function renderedCharacters(lines: ReadonlyArray<string>): number {
    let characters = 0;
    for (const line of lines) {
        characters += line.length;
    }
    return characters;
}

function heapUsed(): number {
    return process.memoryUsage().heapUsed;
}

function runStreamingWriteScenario(iterations: number): StreamingRenderMetrics {
    clearSyntaxHighlightCache();
    const startedHeap = heapUsed();
    const startedMs = performance.now();
    let content = "";
    let lastComponent: Component | undefined;
    let lines: string[] = [];

    for (let index = 1; index <= iterations; index += 1) {
        content += `export const generatedValue${index} = ${index};\n`;
        lastComponent = renderWriteCallPreview({ path: "src/generated.ts", content }, plainTheme, {
            isError: false,
            isPartial: true,
            expanded: false,
            dynamicStatusLabels: true,
            lastComponent,
        });
        lines = lastComponent.render(120);
    }

    const cache = syntaxHighlightCacheStats();
    return {
        iterations,
        elapsedMs: performance.now() - startedMs,
        heapDeltaBytes: heapUsed() - startedHeap,
        renderedLines: lines.length,
        renderedCharacters: renderedCharacters(lines),
        syntaxCacheEntries: cache.entries,
        syntaxCacheBytes: cache.bytes,
    };
}

function runStreamingApplyPatchScenario(iterations: number): StreamingRenderMetrics {
    clearSyntaxHighlightCache();
    const renderer = createThirdPartyToolRenderer("apply_patch");
    const startedHeap = heapUsed();
    const startedMs = performance.now();
    let patch = "*** Begin Patch\n*** Update File: src/generated.ts\n@@\n";
    let lines: string[] = [];

    for (let index = 1; index <= iterations; index += 1) {
        patch += `+export const generatedValue${index} = ${index};\n`;
        lines = renderer.renderCall({ patch }, plainTheme, renderContext).render(120);
    }

    const cache = syntaxHighlightCacheStats();
    return {
        iterations,
        elapsedMs: performance.now() - startedMs,
        heapDeltaBytes: heapUsed() - startedHeap,
        renderedLines: lines.length,
        renderedCharacters: renderedCharacters(lines),
        syntaxCacheEntries: cache.entries,
        syntaxCacheBytes: cache.bytes,
    };
}

describe("streaming render performance harness", () => {
    it("keeps synthetic partial write rendering bounded", () => {
        const metrics = runStreamingWriteScenario(300);

        expect(metrics.renderedLines).toBeLessThanOrEqual(24);
        expect(metrics.renderedCharacters).toBeLessThan(6_000);
        expect(metrics.syntaxCacheEntries).toBe(0);
        expect(metrics.syntaxCacheBytes).toBe(0);
    });

    it("keeps synthetic partial apply_patch rendering bounded", () => {
        const metrics = runStreamingApplyPatchScenario(300);

        expect(metrics.renderedLines).toBeLessThanOrEqual(1);
        expect(metrics.renderedCharacters).toBeLessThan(200);
        expect(metrics.syntaxCacheEntries).toBe(0);
        expect(metrics.syntaxCacheBytes).toBe(0);
    });
});
