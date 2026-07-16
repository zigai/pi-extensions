import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { CodexRenderTheme } from "../src/rendering/core.ts";
import { renderStreamingEditCallPreview } from "../src/rendering/edit-call-rendering.ts";
import { clearSyntaxHighlightCache, syntaxHighlightCacheStats } from "../src/syntax/highlighter.ts";
import { createThirdPartyToolRenderer } from "../src/third-party-tools/renderers.ts";
import { renderWriteCallPreview } from "../src/rendering/write-rendering.ts";

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

type StreamingRenderBounds = {
    readonly updates: number;
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

function runStreamingWriteScenario(updates: number): StreamingRenderBounds {
    clearSyntaxHighlightCache();
    let content = "";
    let lastComponent: Component | undefined;
    let lines: string[] = [];

    for (let index = 1; index <= updates; index += 1) {
        content += `export const generatedValue${index} = ${index};\n`;
        lastComponent = renderWriteCallPreview({ path: "src/generated.ts", content }, plainTheme, {
            isError: false,
            isPartial: true,
            expanded: false,
            labelMode: "lifecycle",
            lastComponent,
        });
        lines = lastComponent.render(120);
    }

    const cache = syntaxHighlightCacheStats();
    return {
        updates,
        renderedLines: lines.length,
        renderedCharacters: renderedCharacters(lines),
        syntaxCacheEntries: cache.entries,
        syntaxCacheBytes: cache.bytes,
    };
}

function runStreamingApplyPatchScenario(updates: number): StreamingRenderBounds {
    clearSyntaxHighlightCache();
    const renderer = createThirdPartyToolRenderer("apply_patch");
    let patch = "*** Begin Patch\n*** Update File: src/generated.ts\n@@\n";
    let lastComponent: Component | undefined;
    let lines: string[] = [];

    for (let index = 1; index <= updates; index += 1) {
        patch += `+export const generatedValue${index} = ${index};\n`;
        lastComponent = renderer.renderCall({ patch }, plainTheme, {
            ...renderContext,
            lastComponent,
        });
        lines = lastComponent.render(120);
    }

    const cache = syntaxHighlightCacheStats();
    return {
        updates,
        renderedLines: lines.length,
        renderedCharacters: renderedCharacters(lines),
        syntaxCacheEntries: cache.entries,
        syntaxCacheBytes: cache.bytes,
    };
}

function runStreamingEditScenario(updates: number): StreamingRenderBounds {
    clearSyntaxHighlightCache();
    let newText = "";
    let lines: string[] = [];

    for (let index = 1; index <= updates; index += 1) {
        newText += `export const generatedValue${index} = ${index};\n`;
        lines =
            renderStreamingEditCallPreview(
                {
                    path: "src/generated.ts",
                    edits: [{ oldText: "export const previous = true;", newText }],
                },
                plainTheme,
                {
                    isError: false,
                    isPartial: true,
                    argsComplete: false,
                    expanded: false,
                    labelMode: "lifecycle",
                    lineNumberStart: 1,
                },
            )?.render(120) ?? [];
    }

    const cache = syntaxHighlightCacheStats();
    return {
        updates,
        renderedLines: lines.length,
        renderedCharacters: renderedCharacters(lines),
        syntaxCacheEntries: cache.entries,
        syntaxCacheBytes: cache.bytes,
    };
}

describe("streaming render structural bounds", () => {
    it("keeps synthetic partial write rendering bounded", () => {
        const metrics = runStreamingWriteScenario(300);

        expect(metrics.renderedLines).toBeLessThanOrEqual(24);
        expect(metrics.renderedCharacters).toBeLessThan(6_000);
        expect(metrics.syntaxCacheEntries).toBe(0);
        expect(metrics.syntaxCacheBytes).toBe(0);
    });

    it("keeps synthetic partial apply_patch rendering bounded", () => {
        const metrics = runStreamingApplyPatchScenario(300);

        expect(metrics.renderedLines).toBeLessThanOrEqual(20);
        expect(metrics.renderedCharacters).toBeLessThan(6_000);
        expect(metrics.syntaxCacheEntries).toBe(0);
        expect(metrics.syntaxCacheBytes).toBe(0);
    });

    it("keeps synthetic partial edit rendering bounded", () => {
        const metrics = runStreamingEditScenario(300);

        expect(metrics.renderedLines).toBeLessThanOrEqual(20);
        expect(metrics.renderedCharacters).toBeLessThan(6_000);
        expect(metrics.syntaxCacheEntries).toBe(0);
        expect(metrics.syntaxCacheBytes).toBe(0);
    });
});
