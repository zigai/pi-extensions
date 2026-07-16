import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { buildPierreDiffPayload } from "../src/diffs/diff.ts";
import { clearQueuedDiffHighlights, renderPierreDiff } from "../src/diffs/renderer.ts";
import {
    clearApplyPatchRenderingState,
    restoreApplyPatchResultSummaries,
} from "../src/rendering/apply-patch-rendering.ts";
import { renderStreamingEditCallPreview } from "../src/rendering/edit-call-rendering.ts";
import {
    configureRenderingAppearance,
    renderCodexDiff,
    type CodexRenderTheme,
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

const fgColors: Record<ThemeColor, string> = {
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
    bashMode: "#64c987",
};

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
                renderCodexDiff(
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

function editStreamTimings(updates: number, rounds: number): readonly number[] {
    const timings: number[] = [];
    for (let round = 0; round < rounds; round += 1) {
        let newText = "";
        for (let index = 1; index <= updates; index += 1) {
            newText += `export const generatedValue${index} = ${index};\n`;
            timings.push(
                measure(() => {
                    renderStreamingEditCallPreview(
                        {
                            path: "src/generated.ts",
                            edits: [
                                {
                                    oldText: "export const previous = true;",
                                    newText,
                                },
                            ],
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
                    )?.render(120);
                }),
            );
        }
    }
    return timings;
}

function patchStreamTimings(updates: number, rounds: number): readonly number[] {
    const timings: number[] = [];
    for (let round = 0; round < rounds; round += 1) {
        clearApplyPatchRenderingState();
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
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
    const branch = [
        {
            type: "message",
            message: {
                role: "toolResult",
                toolCallId: "benchmark-restored",
                toolName: "apply_patch",
                details: {
                    diff: "restored.ts\n+1 export const restored = true;\n",
                    lineSummary: {
                        files: [
                            {
                                action: "A",
                                path: "restored.ts",
                                addedLines: 1,
                                removedLines: 0,
                            },
                        ],
                    },
                },
            },
        },
    ];
    const patch =
        "*** Begin Patch\n*** Add File: restored.ts\n+export const restored = true;\n*** End Patch";
    const timings: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
        clearApplyPatchRenderingState();
        timings.push(
            measure(() => {
                restoreApplyPatchResultSummaries(branch);
                createThirdPartyToolRenderer("apply_patch", { labelMode: "lifecycle" })
                    .renderCall({ patch }, plainTheme, {
                        args: { patch },
                        toolCallId: "benchmark-restored",
                        executionStarted: true,
                        argsComplete: false,
                        isPartial: true,
                        expanded: false,
                        showImages: false,
                        isError: false,
                    })
                    .render(120);
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

async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
    configureRenderingAppearance(defaultAppearance);
    globalThis.gc?.();
    const startingHeap = process.memoryUsage().heapUsed;
    const rounds = options.quick ? 1 : 3;
    const timings: Record<string, readonly number[]> = {
        "cold-large-diff": renderColdLargeDiff(options.quick ? 3 : 9),
        "write-stream-300": writeStreamTimings(300, rounds),
        "write-stream-1000": writeStreamTimings(1_000, rounds),
        "edit-stream-300": editStreamTimings(300, rounds),
        "edit-stream-1000": editStreamTimings(1_000, rounds),
        "apply-patch-stream-300": patchStreamTimings(300, rounds),
        "apply-patch-stream-1000": patchStreamTimings(1_000, rounds),
        "wide-narrow-resize": resizeTimings(options.quick ? 12 : 60),
        "restored-session-render": restoredSessionTimings(options.quick ? 12 : 80),
        ...(await syntaxAdoptionTimings()),
    };
    globalThis.gc?.();
    const cache = syntaxHighlightCacheStats();
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
            heapBytes: Math.max(0, process.memoryUsage().heapUsed - startingHeap),
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
