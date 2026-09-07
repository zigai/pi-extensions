import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { GlowupRenderTheme } from "../../../src/rendering/theme.ts";
import {
    clearSyntaxHighlightCache,
    syntaxHighlightCacheStats,
} from "../../../src/rendering/syntax/highlighter.ts";
import { renderWriteCallPreview } from "../../../src/tools/built-in/write-preview.ts";

const plainTheme: GlowupRenderTheme = {
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

describe("streaming render structural bounds", () => {
    it("keeps synthetic partial write rendering bounded", () => {
        const metrics = runStreamingWriteScenario(300);

        expect(metrics.renderedLines).toBeLessThanOrEqual(24);
        expect(metrics.renderedCharacters).toBeLessThan(6_000);
        expect(metrics.syntaxCacheEntries).toBe(0);
        expect(metrics.syntaxCacheBytes).toBe(0);
    });
});
