import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import {
    getFiletypeFromFileName,
    parsePatchFiles,
    parseDiffFromFile,
    setLanguageOverride,
    type FileContents,
    type FileDiffMetadata,
    type Hunk,
} from "@pierre/diffs";
import { cleanDiffLine, flattenHighlightedLine } from "./highlight.ts";
import { diffContentDigest, diffMetadataDigest } from "./identity.ts";
import { pairReplacementLines, type NarrowDiffLayout } from "./layout.ts";
import { diffTextStats as countDiffTextStats } from "./statistics.ts";
import type {
    HighlightedDiffCode,
    PierreDiffPayload,
    PierreDiffStats,
    PierreDiffSummary,
    SplitDiffCell,
    SplitDiffRow,
    UnifiedDiffRow,
} from "./types.ts";
import type { PierreTerminalPalette } from "./theme.ts";
import { syntaxLanguageFromFile } from "../syntax/language.ts";
import { countContentLines } from "../text-boundaries.ts";
import { replacementFocusColumns } from "./intraline.ts";

const MAX_DIFF_RENDER_BYTES = 512 * 1024;
const MAX_DIFF_RENDER_LINES = 5_000;

export type DiffRenderLimits = {
    readonly maxBytes: number | null;
    readonly maxLines: number | null;
};

const DEFAULT_DIFF_RENDER_LIMITS: DiffRenderLimits = {
    maxBytes: MAX_DIFF_RENDER_BYTES,
    maxLines: MAX_DIFF_RENDER_LINES,
};

const normalizedPayloads = new WeakMap<object, Map<string, PierreDiffPayload | undefined>>();

const nodeErrorCodeSchema = Type.Object({ code: Type.String() });
const nonNegativeNumberSchema = Type.Number({ minimum: 0 });
const pierreLineIndexSchema = Type.Number({ minimum: -1 });
const hunkContentSchema = Type.Union([
    Type.Object({
        type: Type.Literal("context"),
        lines: nonNegativeNumberSchema,
        additionLineIndex: pierreLineIndexSchema,
        deletionLineIndex: pierreLineIndexSchema,
    }),
    Type.Object({
        type: Type.Literal("change"),
        additions: nonNegativeNumberSchema,
        deletions: nonNegativeNumberSchema,
        additionLineIndex: pierreLineIndexSchema,
        deletionLineIndex: pierreLineIndexSchema,
    }),
]);
const hunkSchema = Type.Object({
    collapsedBefore: nonNegativeNumberSchema,
    additionStart: nonNegativeNumberSchema,
    additionCount: nonNegativeNumberSchema,
    additionLines: nonNegativeNumberSchema,
    additionLineIndex: pierreLineIndexSchema,
    deletionStart: nonNegativeNumberSchema,
    deletionCount: nonNegativeNumberSchema,
    deletionLines: nonNegativeNumberSchema,
    deletionLineIndex: pierreLineIndexSchema,
    splitLineStart: nonNegativeNumberSchema,
    splitLineCount: nonNegativeNumberSchema,
    unifiedLineStart: nonNegativeNumberSchema,
    unifiedLineCount: nonNegativeNumberSchema,
    noEOFCRDeletions: Type.Boolean(),
    noEOFCRAdditions: Type.Boolean(),
    hunkContent: Type.Array(hunkContentSchema),
    hunkContext: Type.Optional(Type.String()),
    hunkSpecs: Type.Optional(Type.String()),
});
const fileDiffMetadataSchema = Type.Object({
    name: Type.String(),
    prevName: Type.Optional(Type.String()),
    lang: Type.Optional(Type.String()),
    newObjectId: Type.Optional(Type.String()),
    prevObjectId: Type.Optional(Type.String()),
    mode: Type.Optional(Type.String()),
    prevMode: Type.Optional(Type.String()),
    cacheKey: Type.Optional(Type.String()),
    type: Type.Union([
        Type.Literal("change"),
        Type.Literal("rename-pure"),
        Type.Literal("rename-changed"),
        Type.Literal("new"),
        Type.Literal("deleted"),
    ]),
    hunks: Type.Array(hunkSchema),
    splitLineCount: nonNegativeNumberSchema,
    unifiedLineCount: nonNegativeNumberSchema,
    isPartial: Type.Boolean(),
    deletionLines: Type.Array(Type.String()),
    additionLines: Type.Array(Type.String()),
});
const restoredPayloadSchema = Type.Object({
    version: Type.Literal(1),
    path: Type.String(),
    kind: Type.Union([Type.Literal("summary"), Type.Literal("renderable")]),
    stats: Type.Object({
        added: nonNegativeNumberSchema,
        removed: nonNegativeNumberSchema,
        lineCount: nonNegativeNumberSchema,
        sizeBytes: nonNegativeNumberSchema,
    }),
    summary: Type.Optional(
        Type.Object({
            reason: Type.Union([
                Type.Literal("too-large"),
                Type.Literal("not-readable"),
                Type.Literal("metadata-invalid"),
                Type.Literal("metadata-too-large"),
            ]),
            maxLines: Type.Union([Type.Null(), nonNegativeNumberSchema]),
            maxBytes: Type.Union([Type.Null(), nonNegativeNumberSchema]),
        }),
    ),
    metadata: Type.Optional(fileDiffMetadataSchema),
});
type RestoredPayload = Static<typeof restoredPayloadSchema>;
type RestoredSummary = NonNullable<RestoredPayload["summary"]>;
type RestoredStats = RestoredPayload["stats"];
type RestoredMetadata = NonNullable<RestoredPayload["metadata"]>;
type RestoredHunk = RestoredMetadata["hunks"][number];

type FileSnapshot = {
    readonly content: string;
    readonly sizeBytes: number;
    readonly lineCount: number;
    readonly skippedReason?: "too-large" | "not-readable";
};

type DiffRowBuildOptions = {
    readonly maxRows?: number;
    readonly narrowLayout?: NarrowDiffLayout;
    readonly includedRowIndices?: ReadonlySet<number>;
    readonly onRowBuilt?: () => void;
};

type UnifiedLineRow = Extract<UnifiedDiffRow, { readonly kind: "line" }>;

/** In-flight snapshot for edit tool execution. */
export type EditSnapshotState = {
    readonly finish: () => Promise<DiffSnapshot>;
};

/** Captured before/after text used only during tool execution. */
type DiffSnapshot = {
    readonly path: string;
    readonly oldPath?: string;
    readonly newPath?: string;
    readonly oldContent: string;
    readonly newContent: string;
    readonly oldSizeBytes: number;
    readonly newSizeBytes: number;
    readonly oldLineCount?: number;
    readonly newLineCount?: number;
    readonly canBuildPierreDiff: boolean;
    readonly summaryReason?: PierreDiffSummary["reason"];
};

/** Resolves a tool path against a tool execution working directory. */
function resolveToolPath(cwd: string, relativeOrAbsolutePath: string): string {
    return path.isAbsolute(relativeOrAbsolutePath)
        ? relativeOrAbsolutePath
        : path.resolve(cwd, relativeOrAbsolutePath);
}

/** Captures the pre-edit file state with strict size guardrails. */
export async function createEditSnapshot(
    cwd: string,
    relativePath: string,
    limits: DiffRenderLimits = DEFAULT_DIFF_RENDER_LIMITS,
): Promise<EditSnapshotState> {
    const absolutePath = resolveToolPath(cwd, relativePath);
    const before = await readTextSnapshot(absolutePath, limits.maxBytes);

    return {
        async finish() {
            const after = await readTextSnapshot(absolutePath, limits.maxBytes);
            const summaryReason = summaryReasonForSnapshots(before, after);
            const snapshot: DiffSnapshot = {
                path: relativePath,
                oldContent: before.content,
                newContent: after.content,
                oldSizeBytes: before.sizeBytes,
                newSizeBytes: after.sizeBytes,
                oldLineCount: before.lineCount,
                newLineCount: after.lineCount,
                canBuildPierreDiff: canDiffSnapshots(before, after),
            };
            return summaryReason === undefined ? snapshot : { ...snapshot, summaryReason };
        },
    };
}

/** Builds compact, replayable Pierre diff details from bounded snapshots. */
export function buildPierreDiffPayload(
    snapshot: DiffSnapshot,
    limits: DiffRenderLimits = DEFAULT_DIFF_RENDER_LIMITS,
): PierreDiffPayload | undefined {
    if (snapshot.oldContent === snapshot.newContent && snapshot.summaryReason === undefined) {
        return undefined;
    }

    const estimatedStats = estimatedDiffStats(snapshot);
    if (snapshot.summaryReason !== undefined || !snapshot.canBuildPierreDiff) {
        return buildPierreSummaryPayload(
            snapshot.path,
            estimatedStats,
            snapshot.summaryReason ?? "too-large",
            limits,
        );
    }
    if (exceedsDiffRenderLimits(estimatedStats, limits)) {
        return buildPierreSummaryPayload(snapshot.path, estimatedStats, "too-large", limits);
    }

    try {
        const metadata = buildDiffMetadata(snapshot);
        const stats = diffStats(metadata, snapshot);
        if (exceedsDiffRenderLimits(stats, limits)) {
            return buildPierreSummaryPayload(snapshot.path, stats, "too-large", limits);
        }
        if (exceedsMetadataRenderLimit(metadata, limits)) {
            return buildPierreSummaryPayload(snapshot.path, stats, "metadata-too-large", limits);
        }

        return {
            version: 1,
            kind: "renderable",
            path: snapshot.path,
            modelKey: metadata.cacheKey ?? `metadata:${diffMetadataDigest(metadata) ?? "invalid"}`,
            metadata,
            stats,
        };
    } catch {
        return buildPierreSummaryPayload(snapshot.path, estimatedStats, "metadata-invalid", limits);
    }
}

/** Builds one replayable Pierre payload per file from a completed unified patch. */
export function buildPierreDiffPayloadsFromPatch(
    patch: string,
    limits: DiffRenderLimits = DEFAULT_DIFF_RENDER_LIMITS,
): readonly PierreDiffPayload[] {
    try {
        const patchKey = `patch:${diffContentDigest(patch)}`;
        return parsePatchFiles(patch, patchKey, true).flatMap((parsedPatch) =>
            parsedPatch.files.map((rawMetadata) => {
                const pathValue =
                    rawMetadata.prevName === undefined
                        ? rawMetadata.name
                        : `${rawMetadata.prevName} → ${rawMetadata.name}`;
                const metadata = normalizeDiffMetadataLanguage(rawMetadata, rawMetadata.name);
                const stats = partialMetadataStats(metadata);
                if (exceedsDiffRenderLimits(stats, limits)) {
                    return buildPierreSummaryPayload(pathValue, stats, "too-large", limits);
                }
                if (exceedsMetadataRenderLimit(metadata, limits)) {
                    return buildPierreSummaryPayload(
                        pathValue,
                        stats,
                        "metadata-too-large",
                        limits,
                    );
                }
                return {
                    version: 1,
                    kind: "renderable",
                    path: pathValue,
                    modelKey:
                        metadata.cacheKey ??
                        `${patchKey}:${diffMetadataDigest(metadata) ?? metadata.name}`,
                    metadata,
                    stats,
                } satisfies PierreDiffPayload;
            }),
        );
    } catch {
        return [];
    }
}

/** Normalizes untrusted result details into a renderable Pierre diff payload. */
export function normalizePierreDiffPayload(
    payload: unknown,
    limits: DiffRenderLimits = DEFAULT_DIFF_RENDER_LIMITS,
): PierreDiffPayload | undefined {
    const restored = parseRestoredPayload(payload);
    if (restored === undefined) {
        return undefined;
    }

    const limitsKey = `${limits.maxLines ?? "none"}:${limits.maxBytes ?? "none"}`;
    const cachedByLimits = normalizedPayloads.get(restored);
    if (cachedByLimits?.has(limitsKey) === true) {
        return cachedByLimits.get(limitsKey);
    }

    const normalized = normalizePierreDiffPayloadUncached(restored, limits);
    const nextCache = cachedByLimits ?? new Map<string, PierreDiffPayload | undefined>();
    nextCache.set(limitsKey, normalized);
    normalizedPayloads.set(restored, nextCache);
    return normalized;
}

function parseRestoredPayload(payload: unknown): RestoredPayload | undefined {
    try {
        return Value.Parse(restoredPayloadSchema, payload);
    } catch {
        return undefined;
    }
}

function normalizePierreDiffPayloadUncached(
    payload: RestoredPayload,
    limits: DiffRenderLimits,
): PierreDiffPayload | undefined {
    const stats = normalizeStats(payload.stats);

    if (payload.kind === "summary") {
        return payload.summary === undefined
            ? undefined
            : {
                  version: 1,
                  kind: "summary",
                  path: payload.path,
                  stats,
                  summary: normalizeSummary(payload.summary),
              };
    }

    if (payload.metadata === undefined) {
        return undefined;
    }

    const metadata = parseFileDiffMetadata(payload.metadata);
    if (!metadata) {
        return buildPierreSummaryPayload(payload.path, stats, "metadata-invalid", limits);
    }
    const validatedStats = partialMetadataStats(metadata);
    if (exceedsDiffRenderLimits(validatedStats, limits)) {
        return buildPierreSummaryPayload(payload.path, validatedStats, "too-large", limits);
    }
    if (exceedsMetadataRenderLimit(metadata, limits)) {
        return buildPierreSummaryPayload(
            payload.path,
            validatedStats,
            "metadata-too-large",
            limits,
        );
    }

    const languageMetadata = normalizeDiffMetadataLanguage(metadata, payload.path);
    const metadataIdentity = diffMetadataDigest({ ...languageMetadata, cacheKey: undefined });
    if (metadataIdentity === undefined) {
        return buildPierreSummaryPayload(payload.path, validatedStats, "metadata-invalid", limits);
    }
    const normalizedMetadata = {
        ...languageMetadata,
        cacheKey: `restored:${metadataIdentity}`,
    };

    return {
        version: 1,
        kind: "renderable",
        path: payload.path,
        modelKey: normalizedMetadata.cacheKey,
        metadata: normalizedMetadata,
        stats: validatedStats,
    };
}

/** Builds unified Pierre rows from metadata and optional highlighted line trees. */
export function buildUnifiedDiffRows(
    metadata: FileDiffMetadata,
    highlighted: HighlightedDiffCode,
    palette: PierreTerminalPalette,
    options: DiffRowBuildOptions = {},
): ReadonlyArray<UnifiedDiffRow> {
    const rows: UnifiedDiffRow[] = [];
    let sourceRowIndex = 0;
    const lastIncludedRow = maximumSetValue(options.includedRowIndices);
    const pushRow = (row: UnifiedDiffRow): boolean => {
        const currentIndex = sourceRowIndex;
        sourceRowIndex += 1;
        let budgetReached = false;
        if (
            options.includedRowIndices === undefined ||
            options.includedRowIndices.has(currentIndex)
        ) {
            options.onRowBuilt?.();
            budgetReached = pushBudgetedRow(rows, row, options.maxRows);
        }
        return budgetReached || (lastIncludedRow !== undefined && currentIndex >= lastIncludedRow);
    };
    const pushLazyRow = (createRow: () => UnifiedDiffRow): boolean => {
        const currentIndex = sourceRowIndex;
        sourceRowIndex += 1;
        let budgetReached = false;
        if (
            options.includedRowIndices === undefined ||
            options.includedRowIndices.has(currentIndex)
        ) {
            options.onRowBuilt?.();
            budgetReached = pushBudgetedRow(rows, createRow(), options.maxRows);
        }
        return budgetReached || (lastIncludedRow !== undefined && currentIndex >= lastIncludedRow);
    };

    for (const hunk of metadata.hunks) {
        if (hunk.collapsedBefore > 0) {
            if (
                pushRow({
                    kind: "collapsed",
                    text: "...",
                    fg: palette.metadataFg,
                    bg: palette.metadataBg,
                })
            ) {
                return trimEdgeCollapsedRows(rows);
            }
        }

        let deletionLineIndex = hunk.deletionLineIndex;
        let additionLineIndex = hunk.additionLineIndex;
        let deletionLineNumber = hunk.deletionStart;
        let additionLineNumber = hunk.additionStart;

        for (const content of hunk.hunkContent) {
            if (content.type === "context") {
                for (let offset = 0; offset < content.lines; offset += 1) {
                    if (
                        pushLazyRow(() =>
                            makeUnifiedLine({
                                lineType: "context",
                                oldLineNumber: deletionLineNumber + offset,
                                newLineNumber: additionLineNumber + offset,
                                spans: flattenHighlightedLine(
                                    highlighted.additionLines[additionLineIndex + offset],
                                    palette.appearance,
                                    palette.contextRowBg,
                                    () =>
                                        cleanDiffLine(
                                            metadata.additionLines[additionLineIndex + offset],
                                        ),
                                    metadata.lang,
                                ),
                                palette,
                            }),
                        )
                    ) {
                        return trimEdgeCollapsedRows(rows);
                    }
                }
                deletionLineIndex += content.lines;
                additionLineIndex += content.lines;
                deletionLineNumber += content.lines;
                additionLineNumber += content.lines;
                continue;
            }

            const makeDeletionRow = (offset: number): UnifiedLineRow =>
                makeUnifiedLine({
                    lineType: "deletion",
                    oldLineNumber: deletionLineNumber + offset,
                    spans: flattenHighlightedLine(
                        highlighted.deletionLines[deletionLineIndex + offset],
                        palette.appearance,
                        palette.deletionSpanBg,
                        () => cleanDiffLine(metadata.deletionLines[deletionLineIndex + offset]),
                        metadata.lang,
                        {
                            boldEmphasized: palette.deletionRowBg.length === 0,
                            dimUnchanged: palette.dimUnchangedText,
                        },
                    ),
                    palette,
                });
            const makeAdditionRow = (offset: number): UnifiedLineRow =>
                makeUnifiedLine({
                    lineType: "addition",
                    newLineNumber: additionLineNumber + offset,
                    spans: flattenHighlightedLine(
                        highlighted.additionLines[additionLineIndex + offset],
                        palette.appearance,
                        palette.additionSpanBg,
                        () => cleanDiffLine(metadata.additionLines[additionLineIndex + offset]),
                        metadata.lang,
                        {
                            boldEmphasized: palette.additionRowBg.length === 0,
                            dimUnchanged: palette.dimUnchangedText,
                        },
                    ),
                    palette,
                });
            const narrowLayout = options.narrowLayout ?? "traditional";
            if (narrowLayout === "traditional" || content.deletions * content.additions > 256) {
                for (let offset = 0; offset < content.deletions; offset += 1) {
                    if (pushLazyRow(() => makeDeletionRow(offset))) {
                        return trimEdgeCollapsedRows(rows);
                    }
                }
                for (let offset = 0; offset < content.additions; offset += 1) {
                    if (pushLazyRow(() => makeAdditionRow(offset))) {
                        return trimEdgeCollapsedRows(rows);
                    }
                }

                deletionLineIndex += content.deletions;
                additionLineIndex += content.additions;
                deletionLineNumber += content.deletions;
                additionLineNumber += content.additions;
                continue;
            }

            const deletionRows = Array.from({ length: content.deletions }, (_value, offset) =>
                makeDeletionRow(offset),
            );
            const additionRows = Array.from({ length: content.additions }, (_value, offset) =>
                makeAdditionRow(offset),
            );
            const replacementRows = orderUnifiedReplacementRows(
                deletionRows,
                additionRows,
                narrowLayout,
            );
            for (const row of replacementRows) {
                if (pushRow(row)) {
                    return trimEdgeCollapsedRows(rows);
                }
            }

            deletionLineIndex += content.deletions;
            additionLineIndex += content.additions;
            deletionLineNumber += content.deletions;
            additionLineNumber += content.additions;
        }

        if (hunk.noEOFCRDeletions || hunk.noEOFCRAdditions) {
            if (
                pushRow({
                    kind: "metadata",
                    text: "\\ No newline at end of file",
                    fg: palette.metadataFg,
                    bg: palette.metadataBg,
                })
            ) {
                return trimEdgeCollapsedRows(rows);
            }
        }
    }

    if (hasTrailingCollapsedLines(metadata)) {
        pushRow({
            kind: "collapsed",
            text: "...",
            fg: palette.metadataFg,
            bg: palette.metadataBg,
        });
    }

    return trimEdgeCollapsedRows(rows);
}

/** Builds side-by-side Pierre rows from metadata and optional highlighted line trees. */
export function buildSplitDiffRows(
    metadata: FileDiffMetadata,
    highlighted: HighlightedDiffCode,
    palette: PierreTerminalPalette,
    options: DiffRowBuildOptions = {},
): ReadonlyArray<SplitDiffRow> {
    const rows: SplitDiffRow[] = [];
    let sourceRowIndex = 0;
    const lastIncludedRow = maximumSetValue(options.includedRowIndices);
    const pushRow = (row: SplitDiffRow): boolean => {
        const currentIndex = sourceRowIndex;
        sourceRowIndex += 1;
        let budgetReached = false;
        if (
            options.includedRowIndices === undefined ||
            options.includedRowIndices.has(currentIndex)
        ) {
            options.onRowBuilt?.();
            budgetReached = pushBudgetedRow(rows, row, options.maxRows);
        }
        return budgetReached || (lastIncludedRow !== undefined && currentIndex >= lastIncludedRow);
    };
    const pushLazyRow = (createRow: () => SplitDiffRow): boolean => {
        const currentIndex = sourceRowIndex;
        sourceRowIndex += 1;
        let budgetReached = false;
        if (
            options.includedRowIndices === undefined ||
            options.includedRowIndices.has(currentIndex)
        ) {
            options.onRowBuilt?.();
            budgetReached = pushBudgetedRow(rows, createRow(), options.maxRows);
        }
        return budgetReached || (lastIncludedRow !== undefined && currentIndex >= lastIncludedRow);
    };

    for (const hunk of metadata.hunks) {
        if (hunk.collapsedBefore > 0) {
            if (
                pushRow({
                    kind: "collapsed",
                    text: "...",
                    fg: palette.metadataFg,
                    bg: palette.metadataBg,
                })
            ) {
                return trimEdgeCollapsedRows(rows);
            }
        }

        let deletionLineIndex = hunk.deletionLineIndex;
        let additionLineIndex = hunk.additionLineIndex;
        let deletionLineNumber = hunk.deletionStart;
        let additionLineNumber = hunk.additionStart;

        for (const content of hunk.hunkContent) {
            if (content.type === "context") {
                for (let offset = 0; offset < content.lines; offset += 1) {
                    if (
                        pushLazyRow(() => {
                            const spans = flattenHighlightedLine(
                                highlighted.additionLines[additionLineIndex + offset],
                                palette.appearance,
                                palette.contextRowBg,
                                () =>
                                    cleanDiffLine(
                                        metadata.additionLines[additionLineIndex + offset],
                                    ),
                                metadata.lang,
                            );
                            return {
                                kind: "line",
                                deletion: makeSplitCell({
                                    lineType: "context",
                                    lineNumber: deletionLineNumber + offset,
                                    spans,
                                    palette,
                                }),
                                addition: makeSplitCell({
                                    lineType: "context",
                                    lineNumber: additionLineNumber + offset,
                                    spans,
                                    palette,
                                }),
                            };
                        })
                    ) {
                        return trimEdgeCollapsedRows(rows);
                    }
                }
                deletionLineIndex += content.lines;
                additionLineIndex += content.lines;
                deletionLineNumber += content.lines;
                additionLineNumber += content.lines;
                continue;
            }

            const rowCount = Math.max(content.deletions, content.additions);
            for (let offset = 0; offset < rowCount; offset += 1) {
                if (
                    pushLazyRow(() => ({
                        kind: "line",
                        deletion:
                            offset < content.deletions
                                ? makeSplitCell({
                                      lineType: "deletion",
                                      lineNumber: deletionLineNumber + offset,
                                      spans: flattenHighlightedLine(
                                          highlighted.deletionLines[deletionLineIndex + offset],
                                          palette.appearance,
                                          palette.deletionSpanBg,
                                          () =>
                                              cleanDiffLine(
                                                  metadata.deletionLines[
                                                      deletionLineIndex + offset
                                                  ],
                                              ),
                                          metadata.lang,
                                          {
                                              boldEmphasized: palette.deletionRowBg.length === 0,
                                              dimUnchanged: palette.dimUnchangedText,
                                          },
                                      ),
                                      palette,
                                  })
                                : makeEmptySplitCell(palette),
                        addition:
                            offset < content.additions
                                ? makeSplitCell({
                                      lineType: "addition",
                                      lineNumber: additionLineNumber + offset,
                                      spans: flattenHighlightedLine(
                                          highlighted.additionLines[additionLineIndex + offset],
                                          palette.appearance,
                                          palette.additionSpanBg,
                                          () =>
                                              cleanDiffLine(
                                                  metadata.additionLines[
                                                      additionLineIndex + offset
                                                  ],
                                              ),
                                          metadata.lang,
                                          {
                                              boldEmphasized: palette.additionRowBg.length === 0,
                                              dimUnchanged: palette.dimUnchangedText,
                                          },
                                      ),
                                      palette,
                                  })
                                : makeEmptySplitCell(palette),
                    }))
                ) {
                    return trimEdgeCollapsedRows(rows);
                }
            }

            deletionLineIndex += content.deletions;
            additionLineIndex += content.additions;
            deletionLineNumber += content.deletions;
            additionLineNumber += content.additions;
        }

        if (hunk.noEOFCRDeletions || hunk.noEOFCRAdditions) {
            if (
                pushRow({
                    kind: "metadata",
                    text: "\\ No newline at end of file",
                    fg: palette.metadataFg,
                    bg: palette.metadataBg,
                })
            ) {
                return trimEdgeCollapsedRows(rows);
            }
        }
    }

    if (hasTrailingCollapsedLines(metadata)) {
        pushRow({
            kind: "collapsed",
            text: "...",
            fg: palette.metadataFg,
            bg: palette.metadataBg,
        });
    }

    return trimEdgeCollapsedRows(rows);
}

function orderUnifiedReplacementRows(
    deletions: readonly UnifiedLineRow[],
    additions: readonly UnifiedLineRow[],
    layout: NarrowDiffLayout,
): readonly UnifiedLineRow[] {
    if (layout === "traditional") {
        return [...deletions, ...additions];
    }

    const pairs = pairReplacementLines(
        deletions.map(unifiedRowText),
        additions.map(unifiedRowText),
    );
    if (pairs === undefined) {
        const deletion = deletions[0];
        const addition = additions[0];
        if (
            deletions.length === 1 &&
            additions.length === 1 &&
            deletion !== undefined &&
            addition !== undefined
        ) {
            return focusedReplacementRows(deletion, addition);
        }
        return [...deletions, ...additions];
    }

    const rows: UnifiedLineRow[] = [];
    let deletionIndex = 0;
    let additionIndex = 0;
    for (const pair of pairs) {
        rows.push(...deletions.slice(deletionIndex, pair.deletionIndex));
        rows.push(...additions.slice(additionIndex, pair.additionIndex));
        const deletion = deletions[pair.deletionIndex];
        const addition = additions[pair.additionIndex];
        if (deletion !== undefined && addition !== undefined) {
            rows.push(...focusedReplacementRows(deletion, addition));
        } else {
            if (deletion !== undefined) rows.push(deletion);
            if (addition !== undefined) rows.push(addition);
        }
        deletionIndex = pair.deletionIndex + 1;
        additionIndex = pair.additionIndex + 1;
    }
    rows.push(...deletions.slice(deletionIndex));
    rows.push(...additions.slice(additionIndex));
    return rows;
}

function focusedReplacementRows(
    deletion: UnifiedLineRow,
    addition: UnifiedLineRow,
): readonly [UnifiedLineRow, UnifiedLineRow] {
    const focus = replacementFocusColumns(unifiedRowText(deletion), unifiedRowText(addition));
    return [
        focus.before === undefined ? deletion : { ...deletion, focusColumn: focus.before },
        focus.after === undefined ? addition : { ...addition, focusColumn: focus.after },
    ];
}

function unifiedRowText(row: UnifiedLineRow): string {
    return row.spans.map((span) => span.text).join("");
}

function pushBudgetedRow<TRow>(rows: TRow[], row: TRow, maxRows: number | undefined): boolean {
    if (maxRows !== undefined && rows.length >= Math.max(1, Math.floor(maxRows))) {
        return true;
    }
    rows.push(row);
    return maxRows !== undefined && rows.length >= Math.max(1, Math.floor(maxRows));
}

function maximumSetValue(values: ReadonlySet<number> | undefined): number | undefined {
    let maximum: number | undefined;
    if (values === undefined) return maximum;
    for (const value of values) {
        maximum = maximum === undefined ? value : Math.max(maximum, value);
    }
    return maximum;
}

function trimEdgeCollapsedRows<TRow extends { readonly kind: string }>(
    rows: ReadonlyArray<TRow>,
): ReadonlyArray<TRow> {
    let start = 0;
    let end = rows.length;
    while (rows[start]?.kind === "collapsed") {
        start += 1;
    }
    while (end > start && rows[end - 1]?.kind === "collapsed") {
        end -= 1;
    }
    return rows.slice(start, end);
}

async function readTextSnapshot(
    absolutePath: string,
    maxBytes: number | null,
): Promise<FileSnapshot> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
        info = await stat(absolutePath);
    } catch (cause: unknown) {
        if (hasNodeErrorCode(cause, "ENOENT")) {
            return { content: "", sizeBytes: 0, lineCount: 0 };
        }
        return {
            content: "",
            sizeBytes: 0,
            lineCount: 0,
            skippedReason: "not-readable",
        };
    }

    if (!info.isFile()) {
        return {
            content: "",
            sizeBytes: info.size,
            lineCount: 0,
            skippedReason: "not-readable",
        };
    }
    if (maxBytes !== null && info.size > maxBytes) {
        return {
            content: "",
            sizeBytes: info.size,
            lineCount: 0,
            skippedReason: "too-large",
        };
    }

    try {
        const content = await readFile(absolutePath, "utf8");
        return {
            content,
            sizeBytes: info.size,
            lineCount: countContentLines(content),
        };
    } catch {
        return {
            content: "",
            sizeBytes: info.size,
            lineCount: 0,
            skippedReason: "not-readable",
        };
    }
}

function canDiffSnapshots(before: FileSnapshot, after: FileSnapshot): boolean {
    return before.skippedReason === undefined && after.skippedReason === undefined;
}

function summaryReasonForSnapshots(
    before: FileSnapshot,
    after: FileSnapshot,
): PierreDiffSummary["reason"] | undefined {
    const reason = before.skippedReason ?? after.skippedReason;
    if (reason === "not-readable") {
        return "not-readable";
    }
    if (reason === "too-large") {
        return "too-large";
    }
    return undefined;
}

function hasNodeErrorCode(cause: unknown, code: string): boolean {
    try {
        return Value.Parse(nodeErrorCodeSchema, cause).code === code;
    } catch {
        return false;
    }
}

export function buildLargeDiffSummaryPayload(
    options: {
        readonly path: string;
        readonly diffText: string;
    },
    limits: DiffRenderLimits = DEFAULT_DIFF_RENDER_LIMITS,
): PierreDiffPayload | undefined {
    const stats: PierreDiffStats = {
        ...countDiffTextStats(options.diffText),
        sizeBytes: Buffer.byteLength(options.diffText, "utf8"),
    };
    return exceedsDiffRenderLimits(stats, limits)
        ? buildPierreSummaryPayload(options.path, stats, "too-large", limits)
        : undefined;
}

export function buildPierreSummaryPayload(
    pathValue: string,
    stats: PierreDiffStats,
    reason: PierreDiffSummary["reason"],
    limits: DiffRenderLimits = DEFAULT_DIFF_RENDER_LIMITS,
): PierreDiffPayload {
    return {
        version: 1,
        kind: "summary",
        path: pathValue,
        stats,
        summary: {
            reason,
            maxLines: limits.maxLines,
            maxBytes: limits.maxBytes,
        },
    };
}

function buildDiffMetadata(snapshot: DiffSnapshot): FileDiffMetadata {
    const oldKey = `old:${diffContentDigest(snapshot.oldContent)}`;
    const newKey = `new:${diffContentDigest(snapshot.newContent)}`;
    const oldFile: FileContents = {
        name: snapshot.oldPath ?? snapshot.path,
        contents: snapshot.oldContent,
        cacheKey: oldKey,
    };
    const newFile: FileContents = {
        name: snapshot.newPath ?? snapshot.path,
        contents: snapshot.newContent,
        cacheKey: newKey,
    };

    const metadata = normalizeDiffMetadataLanguage(
        parseDiffFromFile(oldFile, newFile, undefined, true),
        snapshot.newPath ?? snapshot.path,
        snapshot.newContent,
        snapshot.oldContent,
    );
    return metadata.cacheKey === undefined
        ? { ...metadata, cacheKey: `diff:${oldKey}:${newKey}` }
        : metadata;
}

function normalizeDiffMetadataLanguage(
    metadata: FileDiffMetadata,
    pathValue: string,
    newContent?: string,
    oldContent?: string,
): FileDiffMetadata {
    const language =
        syntaxLanguageFromFile(pathValue, newContent) ??
        syntaxLanguageFromFile(pathValue, oldContent) ??
        metadata.lang ??
        getFiletypeFromFileName(pathValue);
    return language === undefined || language.length === 0
        ? metadata
        : setLanguageOverride(metadata, language);
}

function estimatedDiffStats(snapshot: DiffSnapshot): PierreDiffStats {
    const oldLineCount = snapshot.oldLineCount ?? countContentLines(snapshot.oldContent);
    const newLineCount = snapshot.newLineCount ?? countContentLines(snapshot.newContent);
    return {
        added: newLineCount,
        removed: oldLineCount,
        lineCount: oldLineCount + newLineCount,
        sizeBytes: snapshot.oldSizeBytes + snapshot.newSizeBytes,
    };
}

function exceedsDiffRenderLimits(stats: PierreDiffStats, limits: DiffRenderLimits): boolean {
    return (
        (limits.maxLines !== null && stats.lineCount > limits.maxLines) ||
        (limits.maxBytes !== null && stats.sizeBytes > limits.maxBytes)
    );
}

function diffStats(metadata: FileDiffMetadata, snapshot: DiffSnapshot): PierreDiffStats {
    const added = metadata.hunks.reduce((count, hunk) => count + hunk.additionLines, 0);
    const removed = metadata.hunks.reduce((count, hunk) => count + hunk.deletionLines, 0);
    return {
        added,
        removed,
        lineCount: metadata.unifiedLineCount,
        sizeBytes: snapshot.oldSizeBytes + snapshot.newSizeBytes,
    };
}

function partialMetadataStats(metadata: FileDiffMetadata): PierreDiffStats {
    return {
        added: metadata.hunks.reduce((count, hunk) => count + hunk.additionLines, 0),
        removed: metadata.hunks.reduce((count, hunk) => count + hunk.deletionLines, 0),
        lineCount: metadata.unifiedLineCount,
        sizeBytes:
            metadata.additionLines.reduce(
                (bytes, line) => bytes + Buffer.byteLength(line, "utf8"),
                0,
            ) +
            metadata.deletionLines.reduce(
                (bytes, line) => bytes + Buffer.byteLength(line, "utf8"),
                0,
            ),
    };
}

function metadataSizeBytes(metadata: FileDiffMetadata): number {
    try {
        return Buffer.byteLength(JSON.stringify(metadata), "utf8");
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function exceedsMetadataRenderLimit(metadata: FileDiffMetadata, limits: DiffRenderLimits): boolean {
    return limits.maxBytes !== null && metadataSizeBytes(metadata) > limits.maxBytes;
}

function parseFileDiffMetadata(value: RestoredMetadata): FileDiffMetadata | undefined {
    const deletionLines = [...value.deletionLines];
    const additionLines = [...value.additionLines];
    const splitLineCount = Math.floor(value.splitLineCount);
    const unifiedLineCount = Math.floor(value.unifiedLineCount);

    const hunks: Hunk[] = [];
    for (const rawHunk of value.hunks) {
        const hunk = parseHunk(rawHunk, deletionLines.length, additionLines.length);
        if (hunk === undefined) {
            return undefined;
        }
        hunks.push(hunk);
    }

    const { prevName, lang, newObjectId, prevObjectId, mode, prevMode, cacheKey } = value;

    const withPrevName =
        prevName === undefined ? { name: value.name } : { name: value.name, prevName };
    const withLanguage = lang === undefined ? withPrevName : { ...withPrevName, lang };
    const withNewObjectId =
        newObjectId === undefined ? withLanguage : { ...withLanguage, newObjectId };
    const withPreviousObjectId =
        prevObjectId === undefined ? withNewObjectId : { ...withNewObjectId, prevObjectId };
    const withMode = mode === undefined ? withPreviousObjectId : { ...withPreviousObjectId, mode };
    const withPreviousMode = prevMode === undefined ? withMode : { ...withMode, prevMode };
    const metadata: FileDiffMetadata = {
        ...withPreviousMode,
        type: value.type,
        hunks,
        splitLineCount,
        unifiedLineCount,
        isPartial: value.isPartial,
        deletionLines,
        additionLines,
    };
    return cacheKey === undefined ? metadata : { ...metadata, cacheKey };
}

function parseHunk(
    value: RestoredHunk,
    deletionLineCount: number,
    additionLineCount: number,
): Hunk | undefined {
    const nonNegativeIntegerKeys = [
        "collapsedBefore",
        "additionStart",
        "additionCount",
        "additionLines",
        "deletionStart",
        "deletionCount",
        "deletionLines",
        "splitLineStart",
        "splitLineCount",
        "unifiedLineStart",
        "unifiedLineCount",
    ] as const;
    const integers = new Map<string, number>();
    for (const key of nonNegativeIntegerKeys) {
        integers.set(key, Math.floor(value[key]));
    }
    const additionLineIndex = value.additionLineIndex;
    const deletionLineIndex = value.deletionLineIndex;
    if (!Number.isSafeInteger(additionLineIndex) || !Number.isSafeInteger(deletionLineIndex)) {
        return undefined;
    }

    const additionCount = integers.get("additionCount") ?? 0;
    const deletionCount = integers.get("deletionCount") ?? 0;
    if (
        !isValidPierreLineRange(additionLineIndex, additionCount, additionLineCount) ||
        !isValidPierreLineRange(deletionLineIndex, deletionCount, deletionLineCount)
    ) {
        return undefined;
    }

    const hunkContent: Hunk["hunkContent"] = [];
    let contentAdditionCount = 0;
    let contentDeletionCount = 0;
    let addedLines = 0;
    let deletedLines = 0;
    for (const rawContent of value.hunkContent) {
        const contentAdditionIndex = rawContent.additionLineIndex;
        const contentDeletionIndex = rawContent.deletionLineIndex;
        if (
            !Number.isSafeInteger(contentAdditionIndex) ||
            !Number.isSafeInteger(contentDeletionIndex)
        ) {
            return undefined;
        }
        if (rawContent.type === "context") {
            const lines = Math.floor(rawContent.lines);
            if (
                !isValidPierreLineRange(contentAdditionIndex, lines, additionLineCount) ||
                !isValidPierreLineRange(contentDeletionIndex, lines, deletionLineCount)
            ) {
                return undefined;
            }
            contentAdditionCount += lines;
            contentDeletionCount += lines;
            hunkContent.push({
                type: "context",
                lines,
                additionLineIndex: contentAdditionIndex,
                deletionLineIndex: contentDeletionIndex,
            });
            continue;
        }
        const additions = Math.floor(rawContent.additions);
        const deletions = Math.floor(rawContent.deletions);
        if (
            !isValidPierreLineRange(contentAdditionIndex, additions, additionLineCount) ||
            !isValidPierreLineRange(contentDeletionIndex, deletions, deletionLineCount)
        ) {
            return undefined;
        }
        contentAdditionCount += additions;
        contentDeletionCount += deletions;
        addedLines += additions;
        deletedLines += deletions;
        hunkContent.push({
            type: "change",
            additions,
            deletions,
            additionLineIndex: contentAdditionIndex,
            deletionLineIndex: contentDeletionIndex,
        });
    }
    if (
        contentAdditionCount !== additionCount ||
        contentDeletionCount !== deletionCount ||
        addedLines !== integers.get("additionLines") ||
        deletedLines !== integers.get("deletionLines")
    ) {
        return undefined;
    }

    const { hunkContext, hunkSpecs } = value;

    const hunkPrefix = {
        collapsedBefore: integers.get("collapsedBefore") ?? 0,
        additionStart: integers.get("additionStart") ?? 0,
        additionCount,
        additionLines: addedLines,
        additionLineIndex,
        deletionStart: integers.get("deletionStart") ?? 0,
        deletionCount,
        deletionLines: deletedLines,
        deletionLineIndex,
        hunkContent,
    };
    const contextualizedHunk =
        hunkContext === undefined ? hunkPrefix : { ...hunkPrefix, hunkContext };
    const specifiedHunk =
        hunkSpecs === undefined ? contextualizedHunk : { ...contextualizedHunk, hunkSpecs };
    return {
        ...specifiedHunk,
        splitLineStart: integers.get("splitLineStart") ?? 0,
        splitLineCount: integers.get("splitLineCount") ?? 0,
        unifiedLineStart: integers.get("unifiedLineStart") ?? 0,
        unifiedLineCount: integers.get("unifiedLineCount") ?? 0,
        noEOFCRDeletions: value.noEOFCRDeletions,
        noEOFCRAdditions: value.noEOFCRAdditions,
    };
}

function normalizeSummary(summary: RestoredSummary): PierreDiffSummary {
    return {
        reason: summary.reason,
        maxLines: summary.maxLines === null ? null : Math.floor(summary.maxLines),
        maxBytes: summary.maxBytes === null ? null : Math.floor(summary.maxBytes),
    };
}

function normalizeStats(stats: RestoredStats): PierreDiffStats {
    return {
        added: Math.floor(stats.added),
        removed: Math.floor(stats.removed),
        lineCount: Math.floor(stats.lineCount),
        sizeBytes: Math.floor(stats.sizeBytes),
    };
}

function isValidPierreLineRange(index: number, count: number, lineCount: number): boolean {
    return count === 0
        ? index === -1 || index <= lineCount
        : index >= 0 && index + count <= lineCount;
}

function makeUnifiedLine(options: {
    readonly lineType: "context" | "addition" | "deletion";
    readonly oldLineNumber?: number;
    readonly newLineNumber?: number;
    readonly spans: ReadonlyArray<{
        readonly text: string;
        readonly fg?: string;
        readonly bg?: string;
    }>;
    readonly palette: PierreTerminalPalette;
}): UnifiedLineRow {
    const colors = colorsForLineType(options.lineType, options.palette);
    const lineType = { kind: "line" as const, lineType: options.lineType };
    const withOldLineNumber =
        options.oldLineNumber === undefined
            ? lineType
            : { ...lineType, oldLineNumber: options.oldLineNumber };
    const withNewLineNumber =
        options.newLineNumber === undefined
            ? withOldLineNumber
            : { ...withOldLineNumber, newLineNumber: options.newLineNumber };
    return {
        ...withNewLineNumber,
        spans: options.spans,
        rowFg: colors.fg,
        rowBg: colors.bg,
        lineNumberFg: options.palette.lineNumberFg,
    };
}

function makeSplitCell(options: {
    readonly lineType: "context" | "addition" | "deletion";
    readonly lineNumber: number;
    readonly spans: ReadonlyArray<{
        readonly text: string;
        readonly fg?: string;
        readonly bg?: string;
    }>;
    readonly palette: PierreTerminalPalette;
}): SplitDiffCell {
    const colors = colorsForLineType(options.lineType, options.palette);
    return {
        lineType: options.lineType,
        lineNumber: options.lineNumber,
        spans: options.spans,
        rowFg: colors.fg,
        rowBg: colors.bg,
        lineNumberFg: options.palette.lineNumberFg,
    };
}

function makeEmptySplitCell(palette: PierreTerminalPalette): SplitDiffCell {
    return {
        lineType: "empty",
        spans: [],
        rowFg: palette.emptyFg,
        rowBg: palette.emptyRowBg,
        lineNumberFg: palette.lineNumberFg,
    };
}

type DiffLineColors = {
    readonly fg: string;
    readonly bg: string;
};

function colorsForLineType(
    lineType: "context" | "addition" | "deletion",
    palette: PierreTerminalPalette,
): DiffLineColors {
    if (lineType === "addition") {
        return { fg: palette.additionFg, bg: palette.additionRowBg };
    }
    if (lineType === "deletion") {
        return { fg: palette.deletionFg, bg: palette.deletionRowBg };
    }
    return { fg: palette.contextFg, bg: palette.contextRowBg };
}

function hasTrailingCollapsedLines(metadata: FileDiffMetadata): boolean {
    const lastHunk = metadata.hunks.at(-1);
    if (!lastHunk || metadata.isPartial) {
        return false;
    }

    const additionRemaining =
        metadata.additionLines.length - (lastHunk.additionLineIndex + lastHunk.additionCount);
    const deletionRemaining =
        metadata.deletionLines.length - (lastHunk.deletionLineIndex + lastHunk.deletionCount);

    return additionRemaining === deletionRemaining && Math.max(additionRemaining, 0) > 0;
}
