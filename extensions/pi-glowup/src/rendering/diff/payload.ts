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
import { diffContentDigest, diffMetadataDigest } from "./identity.ts";
import { diffTextStats as countDiffTextStats } from "./statistics.ts";
import type { PierreDiffPayload, PierreDiffStats, PierreDiffSummary } from "./types.ts";
import { syntaxLanguageFromFile } from "../syntax/language.ts";
import { countContentLines } from "../../text-boundaries.ts";

const MAX_DIFF_RENDER_BYTES = 512 * 1024;
const MAX_DIFF_RENDER_LINES = 5_000;

export type DiffRenderLimits = {
    readonly maxBytes: number | null;
    readonly maxLines: number | null;
};

export const DEFAULT_DIFF_RENDER_LIMITS: DiffRenderLimits = {
    maxBytes: MAX_DIFF_RENDER_BYTES,
    maxLines: MAX_DIFF_RENDER_LINES,
};

const normalizedPayloads = new WeakMap<object, Map<string, PierreDiffPayload | undefined>>();
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

/** Captured before/after text used only during tool execution. */
export type DiffSnapshot = {
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
    return language.length === 0 ? metadata : setLanguageOverride(metadata, language);
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
