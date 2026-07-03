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
    SplitDiffCell,
    SplitDiffRow,
    UnifiedDiffRow,
} from "./pierre-diff-types.ts";
import type { PierreTerminalPalette } from "./pierre-theme.ts";

const MAX_CAPTURE_BYTES = 500 * 1024;
const MAX_METADATA_BYTES = 750 * 1024;
const MAX_RENDER_ROWS = 4_000;

type FileSnapshot = {
    readonly exists: boolean;
    readonly content: string;
    readonly sizeBytes: number;
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
    readonly canBuildPierreDiff: boolean;
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
            return {
                path: relativePath,
                oldContent: before.content,
                newContent: after.content,
                oldSizeBytes: before.sizeBytes,
                newSizeBytes: after.sizeBytes,
                canBuildPierreDiff: canDiffSnapshots(before, after),
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
    const after: FileSnapshot =
        newSizeBytes <= MAX_CAPTURE_BYTES
            ? { exists: true, content: newContent, sizeBytes: newSizeBytes }
            : { exists: true, content: "", sizeBytes: newSizeBytes, skippedReason: "too-large" };

    return {
        path: relativePath,
        oldContent: before.content,
        newContent: after.content,
        oldSizeBytes: before.sizeBytes,
        newSizeBytes: after.sizeBytes,
        canBuildPierreDiff: canDiffSnapshots(before, after),
    };
}

/** Builds compact, replayable Pierre diff details from bounded snapshots. */
export function buildPierreDiffPayload(snapshot: DiffSnapshot): PierreDiffPayload | undefined {
    if (!snapshot.canBuildPierreDiff || snapshot.oldContent === snapshot.newContent) {
        return undefined;
    }

    try {
        const metadata = buildDiffMetadata(snapshot);
        const stats = diffStats(metadata, snapshot);
        if (stats.lineCount > MAX_RENDER_ROWS || metadataSizeBytes(metadata) > MAX_METADATA_BYTES) {
            return undefined;
        }

        return {
            version: 1,
            path: snapshot.path,
            metadata,
            stats,
        };
    } catch {
        return undefined;
    }
}

/** Normalizes untrusted result details into a renderable Pierre diff payload. */
export function normalizePierreDiffPayload(payload: unknown): PierreDiffPayload | undefined {
    if (!isRecord(payload) || payload.version !== 1) {
        return undefined;
    }
    if (
        typeof payload.path !== "string" ||
        !isRecord(payload.metadata) ||
        !isRecord(payload.stats)
    ) {
        return undefined;
    }

    const metadata = parseFileDiffMetadata(payload.metadata);
    const stats = normalizeStats(payload.stats);
    if (
        !metadata ||
        !stats ||
        stats.lineCount > MAX_RENDER_ROWS ||
        metadataSizeBytes(metadata) > MAX_METADATA_BYTES
    ) {
        return undefined;
    }

    return {
        version: 1,
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
            return { exists: false, content: "", sizeBytes: 0, skippedReason: "not-readable" };
        }
        if (info.size > MAX_CAPTURE_BYTES) {
            return { exists: true, content: "", sizeBytes: info.size, skippedReason: "too-large" };
        }

        return {
            exists: true,
            content: await readFile(absolutePath, "utf8"),
            sizeBytes: info.size,
        };
    } catch {
        return { exists: false, content: "", sizeBytes: 0 };
    }
}

function canDiffSnapshots(before: FileSnapshot, after: FileSnapshot): boolean {
    return before.skippedReason === undefined && after.skippedReason === undefined;
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
