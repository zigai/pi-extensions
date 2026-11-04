import { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as highlights from "../../../src/rendering/diff/highlight.ts";
import { buildPierreDiffPayload } from "../../../src/rendering/diff/payload.ts";
import {
    clearQueuedDiffHighlights,
    pierreDiffHighlightStats,
    renderPierreDiff,
} from "../../../src/rendering/diff/pierre-renderer.ts";
import {
    clearCompletedLineCache,
    completedLineCacheStats,
    configureCompletedLineCache,
    RenderedLineCache,
    RenderedValueCache,
} from "../../../src/rendering/rendered-line-cache.ts";
import { createExplorationFeature } from "../../../src/tools/built-in/exploration.ts";
import {
    cachedSyntaxCode,
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    observeSyntaxHighlightSource,
    settleSyntaxHighlights,
} from "../../../src/rendering/syntax/highlighter.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../../support/theme-colors.ts";

const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
function payload(index: number, rows = 1) {
    const oldContent = Array.from({ length: rows }, (_value, n) => `const old${n} = ${n};`).join(
        "\n",
    );
    const newContent = Array.from(
        { length: rows },
        (_value, n) => `const next${n} = ${n + index + 1};`,
    ).join("\n");
    const result = buildPierreDiffPayload({
        path: "retention.ts",
        oldContent,
        newContent,
        oldSizeBytes: Buffer.byteLength(oldContent),
        newSizeBytes: Buffer.byteLength(newContent),
        canBuildPierreDiff: true,
    });
    if (result?.kind !== "renderable") throw new Error("Expected renderable payload");
    return result;
}

afterEach(async () => {
    clearQueuedDiffHighlights();
    clearCompletedLineCache();
    configureCompletedLineCache({ maxBytes: 64 * 1024 * 1024, maxEntries: 10_000 });
    vi.useRealTimers();
    vi.restoreAllMocks();
    await disposeSyntaxHighlighting();
});

describe("reclaimable Pierre rendering", () => {
    it("never evicts a completed frame just to admit rebuildable rows", () => {
        configureCompletedLineCache({ maxBytes: 100, maxEntries: 10 });
        const frame = new RenderedLineCache();
        const rows = new RenderedValueCache<readonly string[]>();
        frame.set(80, ["frame"]);
        rows.set(["rebuildable"], 90);
        expect(frame.get(80)).toEqual(["frame"]);
        expect(rows.get()).toBeUndefined();
        rows.set(["small"], 30);
        expect(rows.get()).toEqual(["small"]);
        frame.set(80, ["frame".repeat(12)]);
        expect(frame.get(80)).toEqual(["frame".repeat(12)]);
        expect(completedLineCacheStats().completedLineCacheBytes).toBeLessThanOrEqual(100);
    });

    it("only highlights the latest of 100 superseded versions", async () => {
        vi.useFakeTimers();
        const load = vi
            .spyOn(highlights, "loadHighlightedDiffResult")
            .mockResolvedValue({ value: highlights.emptyHighlightedDiffSet(), failed: false });
        const invalidate = vi.fn();
        let previous: Component | undefined;
        for (let index = 0; index < 100; index += 1) {
            previous = renderPierreDiff(
                payload(index),
                theme,
                { expanded: true },
                { toolCallId: "one", lastComponent: previous, invalidate },
            );
        }
        expect(pierreDiffHighlightStats().queuedHighlights).toBe(1);
        await vi.runAllTimersAsync();
        expect(load).toHaveBeenCalledTimes(1);
        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(previous?.render(80).join("\n")).toContain("100");
    });

    it("keeps shared work for another current subscriber", async () => {
        vi.useFakeTimers();
        const load = vi
            .spyOn(highlights, "loadHighlightedDiffResult")
            .mockResolvedValue({ value: highlights.emptyHighlightedDiffSet(), failed: false });
        const shared = payload(0);
        const firstInvalidate = vi.fn();
        const secondInvalidate = vi.fn();
        let first = renderPierreDiff(
            shared,
            theme,
            { expanded: true },
            { toolCallId: "first", lastComponent: undefined, invalidate: firstInvalidate },
        );
        const second = renderPierreDiff(
            shared,
            theme,
            { expanded: true },
            { toolCallId: "second", lastComponent: undefined, invalidate: secondInvalidate },
        );
        first = renderPierreDiff(
            payload(1),
            theme,
            { expanded: true },
            { toolCallId: "first", lastComponent: first, invalidate: firstInvalidate },
        );
        expect(pierreDiffHighlightStats().queuedHighlights).toBe(2);
        await vi.runAllTimersAsync();
        expect(load).toHaveBeenCalledTimes(2);
        expect(firstInvalidate).toHaveBeenCalledTimes(1);
        expect(secondInvalidate).toHaveBeenCalledTimes(1);
        expect(first.render(80)).not.toEqual(second.render(80));
    });

    it("rejoins an active highlight when a call changes A to B and back to A", async () => {
        vi.useFakeTimers();
        let finish: (result: highlights.HighlightedDiffLoadResult) => void = () => {};
        const pending = new Promise<highlights.HighlightedDiffLoadResult>((resolve) => {
            finish = resolve;
        });
        const load = vi.spyOn(highlights, "loadHighlightedDiffResult").mockReturnValue(pending);
        const invalidate = vi.fn();
        let component = renderPierreDiff(
            payload(0),
            theme,
            { expanded: true },
            { toolCallId: "active", lastComponent: undefined, invalidate },
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(pierreDiffHighlightStats().activeHighlights).toBe(1);
        component = renderPierreDiff(
            payload(1),
            theme,
            { expanded: true },
            { toolCallId: "active", lastComponent: component, invalidate },
        );
        component = renderPierreDiff(
            payload(0),
            theme,
            { expanded: true },
            { toolCallId: "active", lastComponent: component, invalidate },
        );
        expect(pierreDiffHighlightStats().queuedHighlights).toBe(0);
        finish({ value: highlights.emptyHighlightedDiffSet(), failed: false });
        await vi.runAllTimersAsync();
        expect(load).toHaveBeenCalledTimes(1);
        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(component.render(80).join("\n")).toContain("next0");
    });

    it("rebuilds identical syntax-colored frames after global cache eviction", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        const data = payload(8, 150);
        await highlights.loadHighlightedDiffResult(data.metadata);
        const component = renderPierreDiff(
            data,
            theme,
            { expanded: true, expandedRows: "full" },
            { toolCallId: "colored-budget", lastComponent: undefined },
        );
        const widths = [80, 180, 40, 80];
        const original = widths.map((width) => component.render(width));
        expect(original[0]?.join("\n")).toContain("86;156;214");
        clearCompletedLineCache();
        configureCompletedLineCache({ maxBytes: 64, maxEntries: 1 });
        expect(widths.map((width) => component.render(width))).toEqual(original);
    });

    it("rebuilds identical narrow/wide frames after global cache eviction", () => {
        const data = payload(3, 400);
        const component = renderPierreDiff(
            data,
            theme,
            { expanded: true, expandedRows: "full" },
            { toolCallId: "budget", lastComponent: undefined },
        );
        const widths = [80, 180, 80];
        const original = widths.map((width) => component.render(width));
        expect(completedLineCacheStats().completedLineCacheBytes).toBeGreaterThan(0);
        clearCompletedLineCache();
        expect(completedLineCacheStats().completedLineCacheBytes).toBe(0);
        configureCompletedLineCache({ maxBytes: 64, maxEntries: 1 });
        expect(widths.map((width) => component.render(width))).toEqual(original);
        expect(completedLineCacheStats().completedLineCacheBytes).toBeLessThanOrEqual(64);
        expect(completedLineCacheStats().completedLineCacheEntries).toBeLessThanOrEqual(1);
    });
});

describe("hidden exploration syntax ownership", () => {
    it("releases a hidden source-only owner without touching another slot", () => {
        const feature = createExplorationFeature();
        const invalidate = vi.fn();
        const otherInvalidate = vi.fn();
        const result = { content: [{ type: "text", text: "plain text" }] };
        feature.renderExplorationResult(result, true, theme, {
            syntaxPath: "source.txt",
            invalidate,
        });
        const current = observeSyntaxHighlightSource("plain text", invalidate);
        const otherCurrent = observeSyntaxHighlightSource("other", otherInvalidate);
        expect(
            feature
                .renderExplorationResult(result, false, theme, {
                    syntaxPath: "source.txt",
                    invalidate,
                })
                .render(80),
        ).toEqual([]);
        expect(current()).toBe(false);
        expect(otherCurrent()).toBe(true);
    });

    it("preserves pending work when collapsing and reopening before completion", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        const feature = createExplorationFeature();
        const source = Array.from(
            { length: 300 },
            (_value, n) => `const pending${n} = callValue("color_${n}");`,
        ).join("\n");
        const result = { content: [{ type: "text", text: source }] };
        let current: Component | undefined;
        const invalidate = () => current?.invalidate();
        const options = { syntaxPath: "source.ts", invalidate };
        current = feature.renderExplorationResult(result, true, theme, options);
        current.render(80);
        const isCurrent = observeSyntaxHighlightSource(source, invalidate);
        feature.renderExplorationResult(result, false, theme, options);
        expect(isCurrent()).toBe(true);
        current = feature.renderExplorationResult(result, true, theme, options);
        current.render(80);
        await settleSyntaxHighlights();
        const widths = [80, 180, 40, 80];
        const completed = widths.map((width) => current?.render(width));
        expect(completed[0]?.join("\n")).toContain("86;156;214");
        feature.renderExplorationResult(result, false, theme, options);
        current = feature.renderExplorationResult(result, true, theme, options);
        expect(widths.map((width) => current?.render(width))).toEqual(completed);
    });

    it("keeps finished colors on the very first re-expanded frame", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        const feature = createExplorationFeature();
        const source = Array.from(
            { length: 300 },
            (_value, n) => `const value${n} = formatValue("color_${n}", ${n});`,
        ).join("\n");
        expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
        const result = { content: [{ type: "text", text: source }] };
        let current: Component | undefined;
        const invalidate = vi.fn(() => current?.invalidate());
        const otherInvalidate = vi.fn();
        const otherCurrent = observeSyntaxHighlightSource("other", otherInvalidate);
        const options = { syntaxPath: "source.ts", invalidate };
        const expanded = feature.renderExplorationResult(result, true, theme, options);
        current = expanded;
        expanded.render(100);
        await settleSyntaxHighlights();
        const before = expanded.render(100);
        expect(cachedSyntaxCode(source, "typescript", { invalidate, cache: false })).toBeDefined();
        expect(feature.renderExplorationResult(result, false, theme, options).render(100)).toEqual(
            [],
        );
        expect(cachedSyntaxCode(source, "typescript", { invalidate, cache: false })).toBeDefined();
        expect(otherCurrent()).toBe(true);
        const reopened = feature.renderExplorationResult(result, true, theme, options);
        current = reopened;
        expect(reopened.render(100)).toEqual(before);
        await settleSyntaxHighlights();
        expect(reopened.render(100)).toEqual(before);
    });
});
