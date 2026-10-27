import type { Component } from "@earendil-works/pi-tui";
import { renderScriptCall } from "../../../src/tools/built-in/bash/script-renderer.ts";
import { createPlainTheme } from "../../support/plain-theme.ts";
import { VirtualTerminal } from "../../support/virtual-terminal.ts";
import { afterEach, expect, it } from "vitest";
import {
    clearSyntaxHighlightCache,
    disposeSyntaxHighlighting,
    highlightSyntaxCode,
    initializeSyntaxHighlighting,
    observeSyntaxHighlightSource,
    settleSyntaxHighlights,
    syntaxHighlightCacheStats,
} from "../../../src/rendering/syntax/highlighter.ts";

afterEach(async () => {
    await disposeSyntaxHighlighting();
});

it.each([
    { name: "job count", count: 140, padding: "" },
    { name: "source bytes", count: 40, padding: `# ${"padding ".repeat(2500)}\n` },
])(
    "retries restored previews after $name backpressure without losing colors",
    async ({ count, padding }) => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["python"] });
        const rendered: string[][] = [];
        const sources = Array.from(
            { length: count },
            (_value, index) => `${padding}print("history_${index}")`,
        );
        const redraws: Array<() => void> = sources.map((source, index) => () => {
            rendered[index] = highlightSyntaxCode(source, "python", { invalidate: redraws[index] });
        });
        for (const redraw of redraws) redraw();
        await settleSyntaxHighlights();
        expect(rendered).toHaveLength(count);
        expect(rendered.filter((lines) => !lines.join("\n").includes("\u001b["))).toHaveLength(0);
    },
);

it("retries a rejected request even when capacity returns before its pending entry settles", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["python"] });
    const controller = new AbortController();
    highlightSyntaxCode('print("cancelled")', "python", { signal: controller.signal });
    for (let index = 1; index < 100; index += 1)
        highlightSyntaxCode(`print("occupied_${index}")`, "python");

    let rendered: string[] = [];
    const redraw = () => {
        rendered = highlightSyntaxCode('print("retried")', "python", { invalidate: redraw });
    };
    redraw();
    controller.abort();
    await settleSyntaxHighlights();
    expect(rendered.join("\n")).toContain("\u001b[");
});

it("resubmits rejected work without depending on a host redraw", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["python"] });
    for (let index = 0; index < 100; index += 1)
        highlightSyntaxCode(`print("occupied_${index}")`, "python");

    let invalidations = 0;
    const invalidate = () => {
        invalidations += 1;
    };
    const source = 'print("retried_without_redraw")';
    expect(highlightSyntaxCode(source, "python", { invalidate })).toEqual([source]);
    await settleSyntaxHighlights();
    const colored = highlightSyntaxCode(source, "python", { invalidate });
    expect(colored.join("\n")).toContain("\u001b[");
    expect(invalidations).toBe(1);
});

it("does not invalidate a superseded restored source when capacity returns", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["python"] });
    for (let index = 0; index < 100; index += 1) {
        highlightSyntaxCode(`print("occupied_${index}")`, "python", { invalidate: () => {} });
    }
    let invalidations = 0;
    const invalidate = () => {
        invalidations += 1;
    };
    highlightSyntaxCode('print("obsolete")', "python", { invalidate });
    observeSyntaxHighlightSource('print("replacement")', invalidate);
    await settleSyntaxHighlights();
    expect(invalidations).toBe(0);
});

it("colors the last real script preview after a restored history burst", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["python"] });
    const theme = createPlainTheme();
    const components: Array<Component | undefined> = [];
    const rendered: string[][] = [];
    const redraws = Array.from({ length: 140 }, (_value, index) => {
        const redraw = (): void => {
            const component = renderScriptCall(
                theme,
                {
                    label: "Python",
                    language: "python",
                    code: `print("history_${index}")`,
                },
                {
                    state: "success",
                    expanded: false,
                    invalidate: redraw,
                    lastComponent: components[index],
                },
            );
            components[index] = component;
            rendered[index] = component.render(120);
        };
        return redraw;
    });
    for (const redraw of redraws) redraw();
    await settleSyntaxHighlights();
    const terminal = new VirtualTerminal(120, 12);
    try {
        terminal.write((rendered[139] ?? []).join("\r\n"));
        await terminal.settle();
        const row = terminal.interpretedRows().find((line) => line.text.includes("history_139"));
        expect(row).toBeDefined();
        expect(
            row?.cells.some((cell) => cell.chars.trim().length > 0 && cell.isForegroundRgb),
        ).toBe(true);
    } finally {
        terminal.dispose();
    }
});

it("does not resubmit backpressured work after an explicit cache clear", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["python"] });
    for (let index = 0; index < 100; index += 1)
        highlightSyntaxCode(`print("occupied_${index}")`, "python");

    let invalidations = 0;
    const invalidate = () => {
        invalidations += 1;
    };
    const source = 'print("owned")';
    highlightSyntaxCode(source, "python", { invalidate });
    clearSyntaxHighlightCache();
    await settleSyntaxHighlights();
    expect(invalidations).toBe(0);
    expect(syntaxHighlightCacheStats()).toEqual({ entries: 0, bytes: 0 });

    highlightSyntaxCode(source, "python", { invalidate });
    await settleSyntaxHighlights();
    expect(invalidations).toBe(1);
    expect(highlightSyntaxCode(source, "python", { invalidate }).join("\n")).toContain("\u001b[");
});
