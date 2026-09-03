import { stat, readFile } from "node:fs/promises";
import path from "node:path";
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
import { isRecord } from "../unknown-values.ts";
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

type FileSnapshot = {
    readonly exists: boolean;
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
            return {
                path: relativePath,
                oldContent: before.content,
                newContent: after.content,
                oldSizeBytes: before.sizeBytes,
                newSizeBytes: after.sizeBytes,
                oldLineCount: before.lineCount,
                newLineCount: after.lineCount,
                canBuildPierreDiff: canDiffSnapshots(before, after),
                ...(summaryReason === undefined ? {} : { summaryReason }),
            };
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
    if (!isRecord(payload) || payload.version !== 1 || typeof payload.path !== "string") {
        return undefined;
    }

    const limitsKey = `${limits.maxLines ?? "none"}:${limits.maxBytes ?? "none"}`;
    const cachedByLimits = normalizedPayloads.get(payload);
    if (cachedByLimits?.has(limitsKey) === true) {
        return cachedByLimits.get(limitsKey);
    }

    const normalized = normalizePierreDiffPayloadUncached(payload, payload.path, limits);
    const nextCache = cachedByLimits ?? new Map<string, PierreDiffPayload | undefined>();
    nextCache.set(limitsKey, normalized);
    normalizedPayloads.set(payload, nextCache);
    return normalized;
}

function normalizePierreDiffPayloadUncached(
    payload: Record<string, unknown>,
    pathValue: string,
    limits: DiffRenderLimits,
): PierreDiffPayload | undefined {
    const stats = isRecord(payload.stats) ? normalizeStats(payload.stats) : undefined;
    if (!stats) {
        return undefined;
    }

    if (payload.kind === "summary") {
        const summary = isRecord(payload.summary) ? normalizeSummary(payload.summary) : undefined;
        return summary === undefined
            ? undefined
            : {
                  version: 1,
                  kind: "summary",
                  path: pathValue,
                  stats,
                  summary,
              };
    }

    if (payload.kind !== "renderable" || !isRecord(payload.metadata)) {
        return undefined;
    }

    const metadata = parseFileDiffMetadata(payload.metadata);
    if (!metadata) {
        return buildPierreSummaryPayload(pathValue, stats, "metadata-invalid", limits);
    }
    const validatedStats = partialMetadataStats(metadata);
    if (exceedsDiffRenderLimits(validatedStats, limits)) {
        return buildPierreSummaryPayload(pathValue, validatedStats, "too-large", limits);
    }
    if (exceedsMetadataRenderLimit(metadata, limits)) {
        return buildPierreSummaryPayload(pathValue, validatedStats, "metadata-too-large", limits);
    }

    const languageMetadata = normalizeDiffMetadataLanguage(metadata, pathValue);
    const metadataIdentity = diffMetadataDigest({ ...languageMetadata, cacheKey: undefined });
    if (metadataIdentity === undefined) {
        return buildPierreSummaryPayload(pathValue, validatedStats, "metadata-invalid", limits);
    }
    const normalizedMetadata = {
        ...languageMetadata,
        cacheKey: `restored:${metadataIdentity}`,
    };

    return {
        version: 1,
        kind: "renderable",
        path: pathValue,
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
    const pushRow = (row: UnifiedDiffRow | (() => UnifiedDiffRow)): boolean => {
        const currentIndex = sourceRowIndex;
        sourceRowIndex += 1;
        const included =
            options.includedRowIndices === undefined ||
            options.includedRowIndices.has(currentIndex);
        let budgetReached = false;
        if (included) {
            const resolvedRow = typeof row === "function" ? row() : row;
            options.onRowBuilt?.();
            budgetReached = pushBudgetedRow(rows, resolvedRow, options.maxRows);
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
                        pushRow(() =>
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
                    if (pushRow(() => makeDeletionRow(offset))) {
                        return trimEdgeCollapsedRows(rows);
                    }
                }
                for (let offset = 0; offset < content.additions; offset += 1) {
                    if (pushRow(() => makeAdditionRow(offset))) {
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
    const pushRow = (row: SplitDiffRow | (() => SplitDiffRow)): boolean => {
        const currentIndex = sourceRowIndex;
        sourceRowIndex += 1;
        const included =
            options.includedRowIndices === undefined ||
            options.includedRowIndices.has(currentIndex);
        let budgetReached = false;
        if (included) {
            const resolvedRow = typeof row === "function" ? row() : row;
            options.onRowBuilt?.();
            budgetReached = pushBudgetedRow(rows, resolvedRow, options.maxRows);
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
                        pushRow(() => {
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
                    pushRow(() => ({
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
        {
            ...deletion,
            ...(focus.before === undefined ? {} : { focusColumn: focus.before }),
        },
        {
            ...addition,
            ...(focus.after === undefined ? {} : { focusColumn: focus.after }),
        },
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
            return { exists: false, content: "", sizeBytes: 0, lineCount: 0 };
        }
        return {
            exists: true,
            content: "",
            sizeBytes: 0,
            lineCount: 0,
            skippedReason: "not-readable",
        };
    }

    if (!info.isFile()) {
        return {
            exists: true,
            content: "",
            sizeBytes: info.size,
            lineCount: 0,
            skippedReason: "not-readable",
        };
    }
    if (maxBytes !== null && info.size > maxBytes) {
        return {
            exists: true,
            content: "",
            sizeBytes: info.size,
            lineCount: 0,
            skippedReason: "too-large",
        };
    }

    try {
        const content = await readFile(absolutePath, "utf8");
        return {
            exists: true,
            content,
            sizeBytes: info.size,
            lineCount: countContentLines(content),
        };
    } catch {
        return {
            exists: true,
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
    return typeof cause === "object" && cause !== null && Reflect.get(cause, "code") === code;
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

function parseFileDiffMetadata(value: unknown): FileDiffMetadata | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const deletionLines = stringArray(value.deletionLines);
    const additionLines = stringArray(value.additionLines);
    const splitLineCount = finiteNonNegativeInteger(value.splitLineCount);
    const unifiedLineCount = finiteNonNegativeInteger(value.unifiedLineCount);
    const type = parseChangeType(value.type);
    if (
        typeof value.name !== "string" ||
        !Array.isArray(value.hunks) ||
        deletionLines === undefined ||
        additionLines === undefined ||
        splitLineCount === undefined ||
        unifiedLineCount === undefined ||
        type === undefined ||
        typeof value.isPartial !== "boolean"
    ) {
        return undefined;
    }

    const hunks: Hunk[] = [];
    for (const rawHunk of value.hunks) {
        const hunk = parseHunk(rawHunk, deletionLines.length, additionLines.length);
        if (hunk === undefined) {
            return undefined;
        }
        hunks.push(hunk);
    }

    const prevName = optionalString(value.prevName);
    const lang = optionalString(value.lang);
    const newObjectId = optionalString(value.newObjectId);
    const prevObjectId = optionalString(value.prevObjectId);
    const mode = optionalString(value.mode);
    const prevMode = optionalString(value.prevMode);
    const cacheKey = optionalString(value.cacheKey);

    return {
        name: value.name,
        ...(prevName === undefined ? {} : { prevName }),
        ...(lang === undefined ? {} : { lang }),
        ...(newObjectId === undefined ? {} : { newObjectId }),
        ...(prevObjectId === undefined ? {} : { prevObjectId }),
        ...(mode === undefined ? {} : { mode }),
        ...(prevMode === undefined ? {} : { prevMode }),
        type,
        hunks,
        splitLineCount,
        unifiedLineCount,
        isPartial: value.isPartial,
        deletionLines,
        additionLines,
        ...(cacheKey === undefined ? {} : { cacheKey }),
    };
}

function parseHunk(
    value: unknown,
    deletionLineCount: number,
    additionLineCount: number,
): Hunk | undefined {
    if (!isRecord(value) || !Array.isArray(value.hunkContent)) {
        return undefined;
    }
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
        const parsed = finiteNonNegativeInteger(value[key]);
        if (parsed === undefined) return undefined;
        integers.set(key, parsed);
    }
    const additionLineIndex = finitePierreLineIndex(value.additionLineIndex);
    const deletionLineIndex = finitePierreLineIndex(value.deletionLineIndex);
    if (additionLineIndex === undefined || deletionLineIndex === undefined) return undefined;
    if (
        typeof value.noEOFCRDeletions !== "boolean" ||
        typeof value.noEOFCRAdditions !== "boolean"
    ) {
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
        if (!isRecord(rawContent)) return undefined;
        const contentAdditionIndex = finitePierreLineIndex(rawContent.additionLineIndex);
        const contentDeletionIndex = finitePierreLineIndex(rawContent.deletionLineIndex);
        if (contentAdditionIndex === undefined || contentDeletionIndex === undefined) {
            return undefined;
        }
        if (rawContent.type === "context") {
            const lines = finiteNonNegativeInteger(rawContent.lines);
            if (
                lines === undefined ||
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
        if (rawContent.type !== "change") return undefined;
        const additions = finiteNonNegativeInteger(rawContent.additions);
        const deletions = finiteNonNegativeInteger(rawContent.deletions);
        if (
            additions === undefined ||
            deletions === undefined ||
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

    const hunkContext = optionalString(value.hunkContext);
    const hunkSpecs = optionalString(value.hunkSpecs);

    return {
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
        ...(hunkContext === undefined ? {} : { hunkContext }),
        ...(hunkSpecs === undefined ? {} : { hunkSpecs }),
        splitLineStart: integers.get("splitLineStart") ?? 0,
        splitLineCount: integers.get("splitLineCount") ?? 0,
        unifiedLineStart: integers.get("unifiedLineStart") ?? 0,
        unifiedLineCount: integers.get("unifiedLineCount") ?? 0,
        noEOFCRDeletions: value.noEOFCRDeletions,
        noEOFCRAdditions: value.noEOFCRAdditions,
    };
}

function stringArray(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every((line) => typeof line === "string")
        ? [...value]
        : undefined;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function parseChangeType(value: unknown): FileDiffMetadata["type"] | undefined {
    return value === "change" ||
        value === "rename-pure" ||
        value === "rename-changed" ||
        value === "new" ||
        value === "deleted"
        ? value
        : undefined;
}

function normalizeSummary(summary: Record<string, unknown>): PierreDiffSummary | undefined {
    const reason = summary.reason;
    const maxLines = nullableFiniteNonNegativeInteger(summary.maxLines);
    const maxBytes = nullableFiniteNonNegativeInteger(summary.maxBytes);
    if (
        (reason !== "too-large" &&
            reason !== "not-readable" &&
            reason !== "metadata-invalid" &&
            reason !== "metadata-too-large") ||
        maxLines === undefined ||
        maxBytes === undefined
    ) {
        return undefined;
    }
    return { reason, maxLines, maxBytes };
}

function nullableFiniteNonNegativeInteger(value: unknown): number | null | undefined {
    return value === null ? null : finiteNonNegativeInteger(value);
}

function normalizeStats(stats: Record<string, unknown>): PierreDiffStats | undefined {
    const added = finiteNonNegativeInteger(stats.added);
    const removed = finiteNonNegativeInteger(stats.removed);
    const lineCount = finiteNonNegativeInteger(stats.lineCount);
    const sizeBytes = finiteNonNegativeInteger(stats.sizeBytes);
    if (
        added === undefined ||
        removed === undefined ||
        lineCount === undefined ||
        sizeBytes === undefined
    ) {
        return undefined;
    }
    return { added, removed, lineCount, sizeBytes };
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : undefined;
}

function finitePierreLineIndex(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= -1
        ? value
        : undefined;
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
    return {
        kind: "line",
        lineType: options.lineType,
        ...(options.oldLineNumber === undefined ? {} : { oldLineNumber: options.oldLineNumber }),
        ...(options.newLineNumber === undefined ? {} : { newLineNumber: options.newLineNumber }),
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

function colorsForLineType(
    lineType: "context" | "addition" | "deletion",
    palette: PierreTerminalPalette,
): { readonly fg: string; readonly bg: string } {
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
