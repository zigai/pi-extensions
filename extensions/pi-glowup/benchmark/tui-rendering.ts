import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { buildPierreDiffPayload, buildUnifiedDiffRows } from "../src/diffs/diff.ts";
import {
    clearQueuedDiffHighlights,
    getPierreDiffPayloadFromDetails,
    renderPierreDiff,
} from "../src/diffs/renderer.ts";
import { emptyHighlightedDiffSet, loadHighlightedDiff } from "../src/diffs/highlight.ts";
import { getPierrePalette } from "../src/diffs/theme.ts";
import { applyPatchOwnerToolDefinition } from "../test/support/apply-patch-owner-fixture.ts";
import {
    configureRenderingAppearance,
    renderGlowupDiff,
    type GlowupRenderTheme,
} from "../src/rendering/core.ts";
import { renderWriteCallPreview } from "../src/rendering/write-rendering.ts";
import {
    clearSyntaxHighlightCache,
    disposeSyntaxHighlighting,
    highlightSyntaxCode,
    initializeSyntaxHighlighting,
    syntaxHighlightCacheStats,
} from "../src/syntax/highlighter.ts";
import { createThirdPartyToolRenderer } from "../src/third-party-tools/renderers.ts";

type BenchmarkOptions = {
    readonly quick: boolean;
    readonly outputPath: string | undefined;
};

type TimingSummary = {
    readonly unit: "ms";
    readonly samples: number;
    readonly median: number;
    readonly p95: number;
    readonly minimum: number;
    readonly maximum: number;
};

type BenchmarkReport = {
    readonly schemaVersion: 1;
    readonly generatedAt: string;
    readonly mode: "full" | "quick";
    readonly runtime: {
        readonly node: string;
        readonly platform: NodeJS.Platform;
        readonly architecture: string;
    };
    readonly comparisonPolicy: {
        readonly status: "informational";
        readonly futureGate: {
            readonly operator: "and";
            readonly requires: readonly ["relative-regression", "absolute-regression"];
        };
    };
    readonly timings: Readonly<Record<string, TimingSummary>>;
    readonly retained: {
        readonly heapBytes: number;
        readonly syntaxCacheEntries: number;
        readonly syntaxCacheBytes: number;
    };
};

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

const fgColors = {
    accent: "#8ab4f8",
    border: "#666666",
    borderAccent: "#8ab4f8",
    borderMuted: "#555555",
    success: "#64c987",
    error: "#f28b82",
    warning: "#fdd663",
    muted: "#888888",
    dim: "#777777",
    text: "#dddddd",
    thinkingText: "#bbbbbb",
    userMessageText: "#ffffff",
    customMessageText: "#dddddd",
    customMessageLabel: "#8ab4f8",
    toolTitle: "#dddddd",
    toolOutput: "#cccccc",
    mdHeading: "#8ab4f8",
    mdLink: "#8ab4f8",
    mdLinkUrl: "#777777",
    mdCode: "#c4a7e7",
    mdCodeBlock: "#dddddd",
    mdCodeBlockBorder: "#555555",
    mdQuote: "#bbbbbb",
    mdQuoteBorder: "#555555",
    mdHr: "#555555",
    mdListBullet: "#8ab4f8",
    toolDiffAdded: "#64c987",
    toolDiffRemoved: "#f28b82",
    toolDiffContext: "#cccccc",
    syntaxComment: "#777777",
    syntaxKeyword: "#c4a7e7",
    syntaxFunction: "#8ab4f8",
    syntaxVariable: "#dddddd",
    syntaxString: "#a8c7a0",
    syntaxNumber: "#f6c177",
    syntaxType: "#9ccfd8",
    syntaxOperator: "#bbbbbb",
    syntaxPunctuation: "#bbbbbb",
    thinkingOff: "#777777",
    thinkingMinimal: "#777777",
    thinkingLow: "#8ab4f8",
    thinkingMedium: "#c4a7e7",
    thinkingHigh: "#f6c177",
    thinkingXhigh: "#f28b82",
    thinkingMax: "#f28b82",
    bashMode: "#64c987",
} satisfies Record<ThemeColor, string>;

const benchmarkTheme = new Theme(
    fgColors,
    {
        selectedBg: "#333333",
        userMessageBg: "#222222",
        customMessageBg: "#222222",
        toolPendingBg: "#222222",
        toolSuccessBg: "#16351e",
        toolErrorBg: "#3b1e1c",
    },
    "truecolor",
    { name: "benchmark-dark" },
);

const defaultAppearance = {
    diffBackgroundStyle: "two-tone",
    diffLineNumberStyle: "dual",
    narrowDiffLayout: "paired",
    sideBySideLayout: "content-aware",
    addedRowBackground: null,
    deletedRowBackground: null,
    addedContentBackground: null,
    deletedContentBackground: null,
    instructionPathColor: null,
    dimUnchangedDiffText: false,
} as const;

function parseOptions(args: readonly string[]): BenchmarkOptions {
    let quick = false;
    let outputPath: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--quick") {
            quick = true;
            continue;
        }
        if (argument === "--output") {
            const value = args[index + 1];
            if (value === undefined || value.length === 0) {
                throw new Error("--output requires a path");
            }
            outputPath = value;
            index += 1;
            continue;
        }
        throw new Error(`Unknown benchmark option: ${argument}`);
    }
    return { quick, outputPath };
}

function percentile(sorted: readonly number[], ratio: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
    return sorted[index] ?? 0;
}

function timingSummary(samples: readonly number[]): TimingSummary {
    const sorted = [...samples].sort((left, right) => left - right);
    return {
        unit: "ms",
        samples: sorted.length,
        median: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        minimum: sorted[0] ?? 0,
        maximum: sorted.at(-1) ?? 0,
    };
}

function measure(operation: () => void): number {
    const startedAt = performance.now();
    operation();
    return performance.now() - startedAt;
}

async function measureAsync(operation: () => Promise<void>): Promise<number> {
    const startedAt = performance.now();
    await operation();
    return performance.now() - startedAt;
}

function renderColdLargeDiff(samples: number): readonly number[] {
    const oldLines = Array.from(
        { length: 600 },
        (_value, index) => `export const value${index} = ${index};`,
    );
    const newLines = oldLines.map((line, index) =>
        index % 4 === 0 ? line.replace(/\d+;$/u, `${index + 1};`) : line,
    );
    const diffLines = oldLines.flatMap((oldLine, index) => {
        const newLine = newLines[index] ?? oldLine;
        return newLine === oldLine ? [` ${oldLine}`] : [`-${oldLine}`, `+${newLine}`];
    });
    const timings: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
        clearSyntaxHighlightCache();
        timings.push(
            measure(() => {
                renderGlowupDiff(
                    plainTheme,
                    [
                        {
                            path: "src/large-generated.ts",
                            lines: diffLines,
                            added: 150,
                            removed: 150,
                        },
                    ],
                    true,
                ).render(160);
            }),
        );
    }
    return timings;
}

function writeStreamTimings(updates: number, rounds: number): readonly number[] {
    const timings: number[] = [];
    for (let round = 0; round < rounds; round += 1) {
        let content = "";
        let lastComponent: Component | undefined;
        for (let index = 1; index <= updates; index += 1) {
            content += `export const generatedValue${index} = ${index};\n`;
            timings.push(
                measure(() => {
                    lastComponent = renderWriteCallPreview(
                        { path: "src/generated.ts", content },
                        plainTheme,
                        {
                            isError: false,
                            isPartial: true,
                            expanded: false,
                            labelMode: "lifecycle",
                            lastComponent,
                        },
                    );
                    lastComponent.render(120);
                }),
            );
        }
    }
    return timings;
}

function patchStreamTimings(updates: number, rounds: number): readonly number[] {
    const timings: number[] = [];
    for (let round = 0; round < rounds; round += 1) {
        const renderer = createThirdPartyToolRenderer(
            "apply_patch",
            { labelMode: "lifecycle" },
            applyPatchOwnerToolDefinition,
        );
        let patch = "*** Begin Patch\n*** Add File: src/generated.ts\n";
        let lastComponent: Component | undefined;
        for (let index = 1; index <= updates; index += 1) {
            patch += `+export const generatedValue${index} = ${index};\n`;
            timings.push(
                measure(() => {
                    lastComponent = renderer.renderCall({ patch }, plainTheme, {
                        args: {},
                        toolCallId: `benchmark-patch-${round}`,
                        executionStarted: true,
                        argsComplete: false,
                        isPartial: true,
                        expanded: false,
                        showImages: false,
                        isError: false,
                        lastComponent,
                    });
                    lastComponent.render(120);
                }),
            );
        }
    }
    return timings;
}

function resizeTimings(cycles: number): readonly number[] {
    const payload = buildPierreDiffPayload({
        path: "src/resized.ts",
        oldContent: Array.from(
            { length: 80 },
            (_value, index) => `export const previous${index} = ${index};`,
        ).join("\n"),
        newContent: Array.from(
            { length: 80 },
            (_value, index) => `export const current${index} = ${index + 1};`,
        ).join("\n"),
        oldSizeBytes: 2_400,
        newSizeBytes: 2_400,
        canBuildPierreDiff: true,
    });
    if (payload?.kind !== "renderable") throw new Error("expected benchmark Pierre payload");
    const component = renderPierreDiff(
        payload,
        benchmarkTheme,
        { expanded: true },
        { lastComponent: undefined, toolCallId: "benchmark-resize" },
    );
    const timings: number[] = [];
    for (let cycle = 0; cycle < cycles; cycle += 1) {
        timings.push(measure(() => component.render(cycle % 2 === 0 ? 180 : 70)));
    }
    clearQueuedDiffHighlights();
    return timings;
}

function restoredSessionTimings(samples: number): readonly number[] {
    const patch =
        "*** Begin Patch\n*** Add File: restored.ts\n+export const restored = true;\n*** End Patch";
    const resultDetails = {
        content: [],
        details: {
            patch,
            inputPatch: patch,
        },
    };
    const timings: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
        timings.push(
            measure(() => {
                const renderer = createThirdPartyToolRenderer(
                    "apply_patch",
                    { labelMode: "lifecycle" },
                    applyPatchOwnerToolDefinition,
                );
                const context = {
                    args: { patch },
                    toolCallId: "benchmark-restored",
                    executionStarted: false,
                    argsComplete: true,
                    isPartial: false,
                    expanded: false,
                    showImages: false,
                    isError: false,
                    result: resultDetails,
                };
                const callLines = renderer.renderCall({ patch }, plainTheme, context).render(120);
                const resultLines = renderer
                    .renderResult(
                        resultDetails,
                        { expanded: false, isPartial: false },
                        plainTheme,
                        context,
                    )
                    .render(120);
                if (
                    callLines.length !== 0 ||
                    !resultLines.join("\n").includes("Patched restored.ts")
                ) {
                    throw new Error("Restored patch benchmark must render one completed mutation");
                }
            }),
        );
    }
    return timings;
}

async function syntaxAdoptionTimings(): Promise<Readonly<Record<string, readonly number[]>>> {
    await disposeSyntaxHighlighting();
    clearSyntaxHighlightCache();
    const code = Array.from(
        { length: 120 },
        (_value, index) => `export const syntaxValue${index}: number = ${index};`,
    ).join("\n");
    const beforeInitialization = measure(() => highlightSyntaxCode(code, "typescript"));
    const initialization = await measureAsync(async () => {
        await initializeSyntaxHighlighting(process.env, {
            preloadLanguages: ["typescript"],
            projectLanguageDetection: { enabled: false },
        });
    });
    const firstHighlightedRender = measure(() => highlightSyntaxCode(code, "typescript"));
    const cachedHighlightedRender = measure(() => highlightSyntaxCode(code, "typescript"));
    return {
        "syntax-before-initialization": [beforeInitialization],
        "syntax-initialization": [initialization],
        "syntax-first-highlighted-render": [firstHighlightedRender],
        "syntax-cached-render": [cachedHighlightedRender],
    };
}

async function reviewFindingTimings(): Promise<Readonly<Record<string, readonly number[]>>> {
    const restoredPayload = buildPierreDiffPayload(
        {
            path: "src/restored-large.ts",
            oldContent: Array.from(
                { length: 600 },
                (_value, index) => `export const old${index} = ${index};`,
            ).join("\n"),
            newContent: Array.from(
                { length: 600 },
                (_value, index) => `export const next${index} = ${index + 1};`,
            ).join("\n"),
            oldSizeBytes: 16_000,
            newSizeBytes: 17_000,
            canBuildPierreDiff: true,
        },
        { maxBytes: null, maxLines: null },
    );
    if (restoredPayload?.kind !== "renderable") throw new Error("expected restored payload");
    let restoredComponent: Component | undefined;
    const restoredRenders: number[] = [];
    for (let sample = 0; sample < 200; sample += 1) {
        restoredRenders.push(
            measure(() => {
                const normalized = getPierreDiffPayloadFromDetails(
                    { pierreDiff: restoredPayload },
                    { maxBytes: null, maxLines: null },
                );
                if (normalized === undefined) throw new Error("expected normalized payload");
                restoredComponent = renderPierreDiff(
                    normalized,
                    benchmarkTheme,
                    { expanded: false },
                    {
                        lastComponent: restoredComponent,
                        toolCallId: "benchmark-restored-large",
                    },
                );
                restoredComponent.render(120);
            }),
        );
    }
    clearQueuedDiffHighlights();

    const basePayload = buildPierreDiffPayload({
        path: "src/huge-replacement.ts",
        oldContent: "old\n",
        newContent: "new\n",
        oldSizeBytes: 4,
        newSizeBytes: 4,
        canBuildPierreDiff: true,
    });
    if (basePayload?.kind !== "renderable") throw new Error("expected replacement payload");
    const baseHunk = basePayload.metadata.hunks[0];
    if (baseHunk === undefined) throw new Error("expected replacement hunk");
    const replacementMetadata = {
        ...basePayload.metadata,
        deletionLines: Array.from({ length: 20_000 }, (_value, index) => `old ${index}`),
        additionLines: Array.from({ length: 20_000 }, (_value, index) => `new ${index}`),
        splitLineCount: 20_000,
        unifiedLineCount: 40_000,
        hunks: [
            {
                ...baseHunk,
                additionCount: 20_000,
                additionLines: 20_000,
                deletionCount: 20_000,
                deletionLines: 20_000,
                splitLineCount: 20_000,
                unifiedLineCount: 40_000,
                hunkContent: [
                    {
                        type: "change" as const,
                        additions: 20_000,
                        deletions: 20_000,
                        additionLineIndex: 0,
                        deletionLineIndex: 0,
                    },
                ],
            },
        ],
    };
    const palette = getPierrePalette(benchmarkTheme);
    const emptyHighlight = emptyHighlightedDiffSet().dark;
    const replacementRows = Array.from({ length: 15 }, () =>
        measure(() => {
            buildUnifiedDiffRows(replacementMetadata, emptyHighlight, palette, {
                maxRows: 6,
                narrowLayout: "paired",
            });
        }),
    );

    const highlightedPayload = buildPierreDiffPayload(
        {
            path: "src/highlighted-preview.ts",
            oldContent: Array.from(
                { length: 600 },
                (_value, index) => `export const old${index}: number = ${index};`,
            ).join("\n"),
            newContent: Array.from(
                { length: 600 },
                (_value, index) => `export const next${index}: number = ${index + 1};`,
            ).join("\n"),
            oldSizeBytes: 24_000,
            newSizeBytes: 25_000,
            canBuildPierreDiff: true,
        },
        { maxBytes: null, maxLines: null },
    );
    if (highlightedPayload?.kind !== "renderable") throw new Error("expected highlight payload");
    const highlighted = (await loadHighlightedDiff(highlightedPayload.metadata)).dark;
    const highlightedRows = Array.from({ length: 100 }, () =>
        measure(() => {
            buildUnifiedDiffRows(highlightedPayload.metadata, highlighted, palette, {
                maxRows: 6,
                narrowLayout: "paired",
            });
        }),
    );

    const renderPayload = buildPierreDiffPayload(
        {
            path: "src/loaded-first-render.ts",
            oldContent: Array.from(
                { length: 1_200 },
                (_value, index) => `export const old${index}: number = ${index};`,
            ).join("\n"),
            newContent: Array.from(
                { length: 1_200 },
                (_value, index) => `export const next${index}: number = ${index + 1};`,
            ).join("\n"),
            oldSizeBytes: 40_000,
            newSizeBytes: 42_000,
            canBuildPierreDiff: true,
        },
        { maxBytes: null, maxLines: null },
    );
    if (renderPayload?.kind !== "renderable") throw new Error("expected render payload");
    const firstRenderComponent = renderPierreDiff(
        renderPayload,
        benchmarkTheme,
        { expanded: false },
        { lastComponent: undefined, toolCallId: "benchmark-loaded-first-render" },
    );
    const firstRender = measure(() => firstRenderComponent.render(120));
    clearQueuedDiffHighlights();

    return {
        "restored-normalize-same-width": restoredRenders,
        "replacement-20000-preview-6": replacementRows,
        "highlighted-hast-600-preview-6": highlightedRows,
        "loaded-grammar-first-diff-render": [firstRender],
    };
}

async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
    configureRenderingAppearance(defaultAppearance);
    globalThis.gc?.();
    const startingHeap = process.memoryUsage().heapUsed;
    const rounds = options.quick ? 1 : 3;
    const timings: Record<string, readonly number[]> = {};
    timings["cold-large-diff"] = renderColdLargeDiff(options.quick ? 3 : 9);
    timings["write-stream-300"] = writeStreamTimings(300, rounds);
    timings["write-stream-1000"] = writeStreamTimings(1_000, rounds);
    timings["apply-patch-stream-300"] = patchStreamTimings(300, rounds);
    timings["apply-patch-stream-1000"] = patchStreamTimings(1_000, rounds);
    timings["wide-narrow-resize"] = resizeTimings(options.quick ? 12 : 60);
    timings["restored-session-render"] = restoredSessionTimings(options.quick ? 12 : 80);
    for (const [name, samples] of Object.entries(await syntaxAdoptionTimings())) {
        timings[name] = samples;
    }
    globalThis.gc?.();
    const retainedHeapBytes = Math.max(0, process.memoryUsage().heapUsed - startingHeap);
    const cache = syntaxHighlightCacheStats();
    for (const [name, samples] of Object.entries(await reviewFindingTimings())) {
        timings[name] = samples;
    }
    const summaries: Record<string, TimingSummary> = {};
    for (const [name, samples] of Object.entries(timings)) {
        summaries[name] = timingSummary(samples);
    }
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        mode: options.quick ? "quick" : "full",
        runtime: {
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
        },
        comparisonPolicy: {
            status: "informational",
            futureGate: {
                operator: "and",
                requires: ["relative-regression", "absolute-regression"],
            },
        },
        timings: summaries,
        retained: {
            heapBytes: retainedHeapBytes,
            syntaxCacheEntries: cache.entries,
            syntaxCacheBytes: cache.bytes,
        },
    };
}

const options = parseOptions(process.argv.slice(2));
const report = await runBenchmark(options);
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (options.outputPath !== undefined) {
    const outputPath = resolve(options.outputPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized);
}
process.stdout.write(serialized);
await disposeSyntaxHighlighting();
