import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import {
    getFiletypeFromFileName,
    parseDiffFromFile,
    setLanguageOverride,
    type FileContents,
    type FileDiffMetadata,
} from "@pierre/diffs";
import { cleanDiffLine, flattenHighlightedLine } from "./pierre-highlight.ts";
import type {
    HighlightedDiffCode,
    PierreDiffPayload,
    PierreDiffStats,
    PierreDiffSummary,
    SplitDiffCell,
    SplitDiffRow,
    UnifiedDiffRow,
} from "./pierre-diff-types.ts";
import type { PierreTerminalPalette } from "./pierre-theme.ts";

export const MAX_DIFF_RENDER_BYTES = 512 * 1024;
export const MAX_DIFF_RENDER_LINES = 5_000;

const MAX_CAPTURE_BYTES = MAX_DIFF_RENDER_BYTES;
const MAX_METADATA_BYTES = 750 * 1024;

type FileSnapshot = {
    readonly exists: boolean;
    readonly content: string;
    readonly sizeBytes: number;
    readonly lineCount: number;
    readonly skippedReason?: "too-large" | "not-readable";
};

/** In-flight snapshot for edit tool execution. */
export type EditSnapshotState = {
    readonly finish: () => Promise<DiffSnapshot>;
};

/** Captured before/after text used only during tool execution. */
type DiffSnapshot = {
    readonly path: string;
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
export function resolveToolPath(cwd: string, relativeOrAbsolutePath: string): string {
    return path.isAbsolute(relativeOrAbsolutePath)
        ? relativeOrAbsolutePath
        : path.resolve(cwd, relativeOrAbsolutePath);
}

/** Captures the pre-edit file state with strict size guardrails. */
export async function createEditSnapshot(
    cwd: string,
    relativePath: string,
): Promise<EditSnapshotState> {
    const absolutePath = resolveToolPath(cwd, relativePath);
    const before = await readTextSnapshot(absolutePath);

    return {
        async finish() {
            const after = await readTextSnapshot(absolutePath);
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

/** Captures a write tool diff snapshot without reading oversized existing files. */
export async function createWriteSnapshot(
    cwd: string,
    relativePath: string,
    newContent: string,
): Promise<DiffSnapshot> {
    const absolutePath = resolveToolPath(cwd, relativePath);
    const before = await readTextSnapshot(absolutePath);
    const newSizeBytes = Buffer.byteLength(newContent, "utf8");
    const newLineCount = countContentLines(newContent);
    const after: FileSnapshot =
        newSizeBytes <= MAX_CAPTURE_BYTES
            ? {
                  exists: true,
                  content: newContent,
                  sizeBytes: newSizeBytes,
                  lineCount: newLineCount,
              }
            : {
                  exists: true,
                  content: "",
                  sizeBytes: newSizeBytes,
                  lineCount: newLineCount,
                  skippedReason: "too-large",
              };

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
}

/** Builds compact, replayable Pierre diff details from bounded snapshots. */
export function buildPierreDiffPayload(snapshot: DiffSnapshot): PierreDiffPayload | undefined {
    if (snapshot.oldContent === snapshot.newContent && snapshot.summaryReason === undefined) {
        return undefined;
    }

    const estimatedStats = estimatedDiffStats(snapshot);
    if (snapshot.summaryReason !== undefined || !snapshot.canBuildPierreDiff) {
        return buildPierreSummaryPayload(
            snapshot.path,
            estimatedStats,
            snapshot.summaryReason ?? "too-large",
        );
    }
    if (exceedsDiffRenderLimits(estimatedStats)) {
        return buildPierreSummaryPayload(snapshot.path, estimatedStats, "too-large");
    }

    try {
        const metadata = buildDiffMetadata(snapshot);
        const stats = diffStats(metadata, snapshot);
        if (stats.lineCount > MAX_DIFF_RENDER_LINES) {
            return buildPierreSummaryPayload(snapshot.path, stats, "too-large");
        }
        if (metadataSizeBytes(metadata) > MAX_METADATA_BYTES) {
            return buildPierreSummaryPayload(snapshot.path, stats, "metadata-too-large");
        }

        return {
            version: 1,
            kind: "renderable",
            path: snapshot.path,
            metadata,
            stats,
        };
    } catch {
        return buildPierreSummaryPayload(snapshot.path, estimatedStats, "metadata-too-large");
    }
}

/** Normalizes untrusted result details into a renderable Pierre diff payload. */
export function normalizePierreDiffPayload(payload: unknown): PierreDiffPayload | undefined {
    if (!isRecord(payload) || payload.version !== 1 || typeof payload.path !== "string") {
        return undefined;
    }

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
                  path: payload.path,
                  stats,
                  summary,
              };
    }

    if (payload.kind !== "renderable" || !isRecord(payload.metadata)) {
        return undefined;
    }

    const metadata = parseFileDiffMetadata(payload.metadata);
    if (
        !metadata ||
        stats.lineCount > MAX_DIFF_RENDER_LINES ||
        metadataSizeBytes(metadata) > MAX_METADATA_BYTES
    ) {
        return buildPierreSummaryPayload(payload.path, stats, "metadata-too-large");
    }

    return {
        version: 1,
        kind: "renderable",
        path: payload.path,
        metadata: normalizeDiffMetadataLanguage(metadata, payload.path),
        stats,
    };
}

/** Builds unified Pierre rows from metadata and optional highlighted line trees. */
export function buildUnifiedDiffRows(
    metadata: FileDiffMetadata,
    highlighted: HighlightedDiffCode,
    palette: PierreTerminalPalette,
): ReadonlyArray<UnifiedDiffRow> {
    const rows: UnifiedDiffRow[] = [];

    for (const hunk of metadata.hunks) {
        if (hunk.collapsedBefore > 0) {
            rows.push({
                kind: "collapsed",
                text: "...",
                fg: palette.metadataFg,
                bg: palette.metadataBg,
            });
        }

        let deletionLineIndex = hunk.deletionLineIndex;
        let additionLineIndex = hunk.additionLineIndex;
        let deletionLineNumber = hunk.deletionStart;
        let additionLineNumber = hunk.additionStart;

        for (const content of hunk.hunkContent) {
            if (content.type === "context") {
                for (let offset = 0; offset < content.lines; offset += 1) {
                    rows.push(
                        makeUnifiedLine({
                            lineType: "context",
                            lineNumber: additionLineNumber + offset,
                            spans: flattenHighlightedLine(
                                highlighted.additionLines[additionLineIndex + offset],
                                palette.appearance,
                                palette.contextRowBg,
                                cleanDiffLine(metadata.additionLines[additionLineIndex + offset]),
                                metadata.lang,
                            ),
                            palette,
                        }),
                    );
                }
                deletionLineIndex += content.lines;
                additionLineIndex += content.lines;
                deletionLineNumber += content.lines;
                additionLineNumber += content.lines;
                continue;
            }

            for (let offset = 0; offset < content.deletions; offset += 1) {
                rows.push(
                    makeUnifiedLine({
                        lineType: "deletion",
                        lineNumber: deletionLineNumber + offset,
                        spans: flattenHighlightedLine(
                            highlighted.deletionLines[deletionLineIndex + offset],
                            palette.appearance,
                            palette.deletionRowBg,
                            cleanDiffLine(metadata.deletionLines[deletionLineIndex + offset]),
                            metadata.lang,
                        ),
                        palette,
                    }),
                );
            }

            for (let offset = 0; offset < content.additions; offset += 1) {
                rows.push(
                    makeUnifiedLine({
                        lineType: "addition",
                        lineNumber: additionLineNumber + offset,
                        spans: flattenHighlightedLine(
                            highlighted.additionLines[additionLineIndex + offset],
                            palette.appearance,
                            palette.additionRowBg,
                            cleanDiffLine(metadata.additionLines[additionLineIndex + offset]),
                            metadata.lang,
                        ),
                        palette,
                    }),
                );
            }

            deletionLineIndex += content.deletions;
            additionLineIndex += content.additions;
            deletionLineNumber += content.deletions;
            additionLineNumber += content.additions;
        }

        if (hunk.noEOFCRDeletions || hunk.noEOFCRAdditions) {
            rows.push({
                kind: "metadata",
                text: "\\ No newline at end of file",
                fg: palette.metadataFg,
                bg: palette.metadataBg,
            });
        }
    }

    if (hasTrailingCollapsedLines(metadata)) {
        rows.push({
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
): ReadonlyArray<SplitDiffRow> {
    const rows: SplitDiffRow[] = [];

    for (const hunk of metadata.hunks) {
        if (hunk.collapsedBefore > 0) {
            rows.push({
                kind: "collapsed",
                text: "...",
                fg: palette.metadataFg,
                bg: palette.metadataBg,
            });
        }

        let deletionLineIndex = hunk.deletionLineIndex;
        let additionLineIndex = hunk.additionLineIndex;
        let deletionLineNumber = hunk.deletionStart;
        let additionLineNumber = hunk.additionStart;

        for (const content of hunk.hunkContent) {
            if (content.type === "context") {
                for (let offset = 0; offset < content.lines; offset += 1) {
                    const spans = flattenHighlightedLine(
                        highlighted.additionLines[additionLineIndex + offset],
                        palette.appearance,
                        palette.contextRowBg,
                        cleanDiffLine(metadata.additionLines[additionLineIndex + offset]),
                        metadata.lang,
                    );
                    rows.push({
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
                    });
                }
                deletionLineIndex += content.lines;
                additionLineIndex += content.lines;
                deletionLineNumber += content.lines;
                additionLineNumber += content.lines;
                continue;
            }

            const rowCount = Math.max(content.deletions, content.additions);
            for (let offset = 0; offset < rowCount; offset += 1) {
                rows.push({
                    kind: "line",
                    deletion:
                        offset < content.deletions
                            ? makeSplitCell({
                                  lineType: "deletion",
                                  lineNumber: deletionLineNumber + offset,
                                  spans: flattenHighlightedLine(
                                      highlighted.deletionLines[deletionLineIndex + offset],
                                      palette.appearance,
                                      palette.deletionRowBg,
                                      cleanDiffLine(
                                          metadata.deletionLines[deletionLineIndex + offset],
                                      ),
                                      metadata.lang,
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
                                      palette.additionRowBg,
                                      cleanDiffLine(
                                          metadata.additionLines[additionLineIndex + offset],
                                      ),
                                      metadata.lang,
                                  ),
                                  palette,
                              })
                            : makeEmptySplitCell(palette),
                });
            }

            deletionLineIndex += content.deletions;
            additionLineIndex += content.additions;
            deletionLineNumber += content.deletions;
            additionLineNumber += content.additions;
        }

        if (hunk.noEOFCRDeletions || hunk.noEOFCRAdditions) {
            rows.push({
                kind: "metadata",
                text: "\\ No newline at end of file",
                fg: palette.metadataFg,
                bg: palette.metadataBg,
            });
        }
    }

    if (hasTrailingCollapsedLines(metadata)) {
        rows.push({
            kind: "collapsed",
            text: "...",
            fg: palette.metadataFg,
            bg: palette.metadataBg,
        });
    }

    return trimEdgeCollapsedRows(rows);
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

async function readTextSnapshot(absolutePath: string): Promise<FileSnapshot> {
    try {
        const info = await stat(absolutePath);
        if (!info.isFile()) {
            return {
                exists: false,
                content: "",
                sizeBytes: 0,
                lineCount: 0,
                skippedReason: "not-readable",
            };
        }
        if (info.size > MAX_CAPTURE_BYTES) {
            return {
                exists: true,
                content: "",
                sizeBytes: info.size,
                lineCount: 0,
                skippedReason: "too-large",
            };
        }

        const content = await readFile(absolutePath, "utf8");
        return {
            exists: true,
            content,
            sizeBytes: info.size,
            lineCount: countContentLines(content),
        };
    } catch {
        return { exists: false, content: "", sizeBytes: 0, lineCount: 0 };
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

function countContentLines(content: string): number {
    if (content.length === 0) {
        return 0;
    }
    const lines = content.split("\n");
    return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

export function buildLargeDiffSummaryPayload(options: {
    readonly path: string;
    readonly diffText: string;
}): PierreDiffPayload | undefined {
    const stats = diffTextStats(options.diffText);
    return exceedsDiffRenderLimits(stats)
        ? buildPierreSummaryPayload(options.path, stats, "too-large")
        : undefined;
}

export function buildPierreSummaryPayload(
    pathValue: string,
    stats: PierreDiffStats,
    reason: PierreDiffSummary["reason"],
): PierreDiffPayload {
    return {
        version: 1,
        kind: "summary",
        path: pathValue,
        stats,
        summary: {
            reason,
            maxLines: MAX_DIFF_RENDER_LINES,
            maxBytes: MAX_DIFF_RENDER_BYTES,
        },
    };
}

function buildDiffMetadata(snapshot: DiffSnapshot): FileDiffMetadata {
    const oldFile: FileContents = {
        name: snapshot.path,
        contents: snapshot.oldContent,
    };
    const newFile: FileContents = {
        name: snapshot.path,
        contents: snapshot.newContent,
    };

    return normalizeDiffMetadataLanguage(
        parseDiffFromFile(oldFile, newFile, undefined, true),
        snapshot.path,
    );
}

function normalizeDiffMetadataLanguage(
    metadata: FileDiffMetadata,
    pathValue: string,
): FileDiffMetadata {
    const language = metadata.lang ?? getFiletypeFromFileName(pathValue);
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

function diffTextStats(diffText: string): PierreDiffStats {
    const lines = diffText.length === 0 ? [] : diffText.split("\n");
    return {
        added: lines.filter((line) => /^\+\s*\d+\s/u.test(line)).length,
        removed: lines.filter((line) => /^-\s*\d+\s/u.test(line)).length,
        lineCount: lines.length,
        sizeBytes: Buffer.byteLength(diffText, "utf8"),
    };
}

function exceedsDiffRenderLimits(stats: PierreDiffStats): boolean {
    return stats.lineCount > MAX_DIFF_RENDER_LINES || stats.sizeBytes > MAX_DIFF_RENDER_BYTES;
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

function metadataSizeBytes(metadata: FileDiffMetadata): number {
    try {
        return Buffer.byteLength(JSON.stringify(metadata), "utf8");
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function parseFileDiffMetadata(value: unknown): FileDiffMetadata | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (
        typeof value.name !== "string" ||
        !Array.isArray(value.hunks) ||
        !Array.isArray(value.deletionLines) ||
        !Array.isArray(value.additionLines) ||
        typeof value.unifiedLineCount !== "number" ||
        typeof value.splitLineCount !== "number" ||
        typeof value.isPartial !== "boolean"
    ) {
        return undefined;
    }

    // SAFETY: The renderer only consumes Pierre-created metadata stored by this extension.
    // The runtime shape checks above cover the arrays and counters used before handing it
    // back to Pierre's own helper functions.
    return value as unknown as FileDiffMetadata;
}

function normalizeSummary(summary: Record<string, unknown>): PierreDiffSummary | undefined {
    const reason = summary.reason;
    const maxLines = finiteNonNegativeInteger(summary.maxLines);
    const maxBytes = finiteNonNegativeInteger(summary.maxBytes);
    if (
        (reason !== "too-large" && reason !== "not-readable" && reason !== "metadata-too-large") ||
        maxLines === undefined ||
        maxBytes === undefined
    ) {
        return undefined;
    }
    return { reason, maxLines, maxBytes };
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

function makeUnifiedLine(options: {
    readonly lineType: "context" | "addition" | "deletion";
    readonly lineNumber: number;
    readonly spans: ReadonlyArray<{
        readonly text: string;
        readonly fg?: string;
        readonly bg?: string;
    }>;
    readonly palette: PierreTerminalPalette;
}): UnifiedDiffRow {
    const colors = colorsForLineType(options.lineType, options.palette);
    return {
        kind: "line",
        lineType: options.lineType,
        lineNumber: options.lineNumber,
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
