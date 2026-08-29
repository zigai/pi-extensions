import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { Text } from "@earendil-works/pi-tui";
import {
    defineTool,
    generateDiffString,
    generateUnifiedPatch,
    withFileMutationQueue,
    type ExtensionAPI,
    type Theme,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withGlowupRendering } from "@zigai/pi-glowup/protocol";
import { Type, type Static } from "typebox";

import { applyPatchGlowupRendering } from "./glowup-rendering.js";
import {
    ApplyPatchError,
    applyPatchHunks,
    formatApplyPatchError,
    parseApplyPatch,
    type ApplyPatchAffectedPaths,
    type AppliedPatchFileChange,
    type ApplyPatchHunk,
} from "./engine.ts";
import { compileSchema, NodeErrorCodeDecoder, StringDecoder } from "../../schema-parsing.ts";

export const APPLY_PATCH_TOOL_NAME = "apply_patch";

const APPLY_PATCH_PARAMETERS = Type.Object(
    {
        patch: Type.String({
            description:
                "Full Codex apply_patch document, from *** Begin Patch through *** End Patch.",
        }),
    },
    { additionalProperties: false },
);

const ApplyPatchParametersValidator = compileSchema(APPLY_PATCH_PARAMETERS);
const ApplyPatchArgumentObjectSchema = Type.Object(
    {
        patch: Type.Optional(Type.String()),
        input: Type.Optional(Type.String()),
        command: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);
const ApplyPatchArgumentsDecoder = compileSchema(
    Type.Union([Type.String(), ApplyPatchArgumentObjectSchema]),
);
const ApplyPatchArgumentObjectDecoder = compileSchema(ApplyPatchArgumentObjectSchema);

type ApplyPatchParams = Static<typeof APPLY_PATCH_PARAMETERS>;

export type ApplyPatchToolDetails = {
    readonly affectedPaths: ApplyPatchAffectedPaths;
    readonly changedFileCount: number;
    readonly lineSummary: ApplyPatchLineSummary;
    readonly diff: string;
    readonly patch: string;
    readonly firstChangedLine: number | undefined;
};

type ApplyPatchAction = "A" | "M" | "D";

type ApplyPatchFileLineSummary = {
    readonly action: ApplyPatchAction;
    readonly path: string;
    readonly originalPath?: string | undefined;
    readonly addedLines: number;
    readonly removedLines: number | undefined;
};

type ApplyPatchLineSummary = {
    readonly files: readonly ApplyPatchFileLineSummary[];
    readonly addedLines: number;
    readonly removedLines: number;
    readonly unknownRemovedFileCount: number;
};

type ApplyPatchDiffSummary = {
    readonly diff: string;
    readonly patch: string;
    readonly firstChangedLine: number | undefined;
};

type AppliedPatchChangeContents = {
    readonly oldContent: string;
    readonly newContent: string;
};

type ApplyPatchLineChangeCounts = {
    readonly addedLines: number;
    readonly removedLines: number;
};

const COMPACT_DIFF_LINE_LIMIT = 80;

export function registerApplyPatchTool(pi: ExtensionAPI): void {
    pi.registerTool(createApplyPatchTool());
}

export function createApplyPatchTool(): ToolDefinition<
    typeof APPLY_PATCH_PARAMETERS,
    ApplyPatchToolDetails
> {
    return withGlowupRendering(
        defineTool({
            name: APPLY_PATCH_TOOL_NAME,
            label: "Apply Patch",
            description:
                "The `apply_patch` tool can be used to edit files. Provide a complete patch body in the `patch` argument.",
            promptSnippet: "Edit files with apply_patch patches.",
            promptGuidelines: [
                "Use apply_patch to edit files.",
                "The patch must start with *** Begin Patch and end with *** End Patch.",
                "Use *** Add File, *** Delete File, and *** Update File sections. Relative paths resolve from the working directory; absolute paths are accepted. Added lines start with +.",
            ],
            parameters: APPLY_PATCH_PARAMETERS,
            prepareArguments: prepareApplyPatchArguments,
            async execute(_toolCallId, params, signal, _onUpdate, ctx) {
                const cwd = resolve(ctx.cwd);
                try {
                    const parsedResult = parseApplyPatch(params.patch);
                    if (parsedResult.isErr()) {
                        throw new Error(formatApplyPatchError(parsedResult.error));
                    }
                    const parsed = parsedResult.value;
                    const mutationPaths = await resolvePatchMutationQueuePaths(parsed.hunks, cwd);
                    return await withFileMutationQueues(mutationPaths, async () => {
                        const applied = await applyPatchHunks(parsed.hunks, cwd, {
                            signal,
                            environmentId: parsed.environmentId,
                        });
                        if (applied.isErr()) throw new Error(formatApplyPatchError(applied.error));
                        const result = applied.value;
                        const diffSummary = summarizeAppliedPatchDiff(result.changes, parsed.hunks);
                        return {
                            content: [{ type: "text", text: result.summary }],
                            details: {
                                affectedPaths: result.affectedPaths,
                                changedFileCount: result.changes.length,
                                lineSummary: summarizeAppliedPatchLines(
                                    result.changes,
                                    parsed.hunks,
                                ),
                                diff: diffSummary.diff,
                                patch: diffSummary.patch,
                                firstChangedLine: diffSummary.firstChangedLine,
                            },
                        };
                    });
                } catch (cause: unknown) {
                    if (cause instanceof ApplyPatchError) {
                        throw new Error(formatApplyPatchError(cause));
                    }
                    if (cause instanceof Error) throw cause;
                    throw new Error(String(cause));
                }
            },
            renderCall(args, theme, _context) {
                const summary = summarizeApplyPatchCall(args.patch);
                let text =
                    theme.fg("toolTitle", theme.bold("apply_patch ")) +
                    theme.fg(
                        summary.length > 0 ? "accent" : "dim",
                        summary.length > 0 ? summary : "...",
                    );
                const diff = summarizePlannedPatchDiffPreview(args.patch);
                if (diff.length > 0) {
                    text += `\n\n${renderApplyPatchDiff(truncateDiffLines(diff, COMPACT_DIFF_LINE_LIMIT), theme)}`;
                }
                return new Text(text, 0, 0);
            },
            renderResult(result, { expanded, isPartial }, theme, _context) {
                if (isPartial) return new Text(theme.fg("warning", "Applying patch..."), 0, 0);
                const output = result.content
                    .filter((item) => item.type === "text")
                    .map((item) => item.text)
                    .join("\n");
                if (expanded) {
                    return new Text(
                        expandedApplyPatchSummary(output, result.details.diff, theme),
                        0,
                        0,
                    );
                }
                return new Text(
                    compactApplyPatchResult(
                        output,
                        result.details.affectedPaths,
                        result.details.lineSummary,
                        result.details.diff,
                        theme,
                    ),
                    0,
                    0,
                );
            },
        }),
        applyPatchGlowupRendering,
    );
}

async function resolvePatchMutationQueuePaths(
    hunks: readonly ApplyPatchHunk[],
    cwd: string,
): Promise<string[]> {
    const paths = hunks.flatMap((hunk) => [
        resolve(cwd, hunk.path),
        ...(hunk.type === "update" && hunk.movePath !== undefined
            ? [resolve(cwd, hunk.movePath)]
            : []),
    ]);
    const canonicalPaths = await Promise.all(paths.map(canonicalMutationQueuePath));
    return [...new Set(canonicalPaths)].sort(comparePaths);
}

async function canonicalMutationQueuePath(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch (cause: unknown) {
        if (hasNodeErrorCode(cause, "ENOENT") || hasNodeErrorCode(cause, "ENOTDIR")) return path;
        throw cause;
    }
}

function withFileMutationQueues<T>(
    paths: readonly string[],
    operation: () => Promise<T>,
    index = 0,
): Promise<T> {
    const path = paths[index];
    if (path === undefined) return operation();
    return withFileMutationQueue(path, () => withFileMutationQueues(paths, operation, index + 1));
}

function comparePaths(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function hasNodeErrorCode(cause: unknown, code: string): boolean {
    return NodeErrorCodeDecoder.decode(cause)?.code === code;
}

function prepareApplyPatchArguments(args: unknown): ApplyPatchParams {
    const normalized = normalizeApplyPatchArguments(args);
    const params = ApplyPatchParametersValidator.decode(normalized);
    if (!params) throw new Error("Invalid apply_patch arguments.");
    return params;
}

function normalizeApplyPatchArguments(args: unknown): ApplyPatchParams | undefined {
    const parsed = ApplyPatchArgumentsDecoder.decode(args);
    if (parsed === undefined) return undefined;
    const directPatch = StringDecoder.decode(parsed);
    if (directPatch !== undefined) return { patch: directPatch };

    const parsedObject = ApplyPatchArgumentObjectDecoder.decode(parsed);
    if (!parsedObject) return undefined;
    const entries = Object.entries(parsedObject);
    if (entries.length !== 1) return undefined;
    const patch = entries[0]?.[1];
    return patch === undefined ? undefined : { patch };
}

function summarizeApplyPatchCall(patch: string): string {
    const parsed = parseApplyPatch(patch);
    return parsed.isErr()
        ? "patch"
        : formatPatchCallSummary(summarizePlannedPatchLines(parsed.value.hunks));
}

function summarizePlannedPatchDiffPreview(patch: string): string {
    const parsed = parseApplyPatch(patch);
    if (parsed.isErr()) return "";
    return parsed.value.hunks
        .map((hunk) => formatPlannedPatchHunkDiff(hunk))
        .filter((diff) => diff.length > 0)
        .join("\n\n");
}

function formatPlannedPatchHunkDiff(hunk: ApplyPatchHunk): string {
    if (hunk.type === "add") {
        const lines = splitContentLines(hunk.contents).map((line) => `+ ${line}`);
        return lines.length === 0 ? "" : `${hunk.path}\n${lines.join("\n")}`;
    }
    if (hunk.type === "delete") return "";

    const lines = hunk.chunks.flatMap((chunk) => [
        ...formatChangeContextLine(chunk.changeContext),
        ...formatDisplayLineDiff(chunk.oldLines, chunk.newLines),
    ]);
    const path = hunk.movePath === undefined ? hunk.path : `${hunk.path} → ${hunk.movePath}`;
    return lines.length === 0 ? "" : `${path}\n${lines.join("\n")}`;
}

function formatChangeContextLine(changeContext: string | undefined): readonly string[] {
    return changeContext === undefined || changeContext.length === 0 ? [] : [`@@ ${changeContext}`];
}

function compactApplyPatchSummary(
    output: string,
    affectedPaths: ApplyPatchAffectedPaths,
    lineSummary: ApplyPatchLineSummary | undefined,
): string {
    if (lineSummary !== undefined && lineSummary.files.length > 0) {
        const visible = lineSummary.files.slice(0, 4).map(formatPatchFileLineSummary);
        const remaining = lineSummary.files.length - visible.length;
        const remainingSummary = formatPatchLineTotals(lineSummary);
        const remainingSuffix = remainingSummary.length > 0 ? ` (${remainingSummary})` : "";
        return remaining > 0
            ? `${visible.join("\n")}\n… ${remaining} more${remainingSuffix}`
            : visible.join("\n");
    }

    const paths = [
        ...affectedPaths.added.map((path) => `A ${path}`),
        ...affectedPaths.modified.map((path) => `M ${path}`),
        ...affectedPaths.deleted.map((path) => `D ${path}`),
    ];
    if (paths.length === 0) return output.trimEnd();
    const visible = paths.slice(0, 4);
    const remaining = paths.length - visible.length;
    return remaining > 0 ? `${visible.join("\n")}\n… ${remaining} more` : visible.join("\n");
}

function compactApplyPatchResult(
    output: string,
    affectedPaths: ApplyPatchAffectedPaths,
    lineSummary: ApplyPatchLineSummary | undefined,
    diff: string,
    theme: Theme,
): string {
    const summary = theme.fg(
        "toolOutput",
        compactApplyPatchSummary(output, affectedPaths, lineSummary),
    );
    const compactDiff = truncateDiffLines(diff, COMPACT_DIFF_LINE_LIMIT);
    if (compactDiff.length === 0) return summary;
    return `${summary}\n\n${renderApplyPatchDiff(compactDiff, theme)}`;
}

function expandedApplyPatchSummary(output: string, diff: string, theme: Theme): string {
    const trimmedOutput = output.trimEnd();
    const renderedDiff = renderApplyPatchDiff(diff, theme);
    if (renderedDiff.length === 0) return theme.fg("toolOutput", trimmedOutput);
    if (trimmedOutput.length === 0) return renderedDiff;
    return `${theme.fg("toolOutput", trimmedOutput)}\n\n${renderedDiff}`;
}

function summarizeAppliedPatchDiff(
    changes: readonly AppliedPatchFileChange[],
    hunks: readonly ApplyPatchHunk[],
): ApplyPatchDiffSummary {
    const diffSections: string[] = [];
    const patchSections: string[] = [];
    let firstChangedLine: number | undefined;

    changes.forEach((change, index) => {
        const hunk = hunks[index];
        const displayPath = formatAppliedChangePath(change, hunk);
        const { oldContent, newContent } = getAppliedChangeContents(change);
        const normalizedOldContent = normalizeToLineFeed(oldContent);
        const normalizedNewContent = normalizeToLineFeed(newContent);
        const diffResult = generateDiffString(normalizedOldContent, normalizedNewContent);
        if (diffResult.diff.trim().length === 0) return;

        diffSections.push(`${displayPath}\n${diffResult.diff}`);
        patchSections.push(
            generateUnifiedPatch(displayPath, normalizedOldContent, normalizedNewContent),
        );
        firstChangedLine ??= diffResult.firstChangedLine;
    });

    return {
        diff: diffSections.join("\n\n"),
        patch: patchSections.join("\n"),
        firstChangedLine,
    };
}

function normalizeToLineFeed(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function formatAppliedChangePath(
    change: AppliedPatchFileChange,
    hunk: ApplyPatchHunk | undefined,
): string {
    if (hunk?.type === "add") return hunk.path;
    if (hunk?.type === "delete") return hunk.path;
    if (hunk?.type === "update") {
        return hunk.movePath === undefined ? hunk.path : `${hunk.path} → ${hunk.movePath}`;
    }
    if (change.type === "update") {
        return change.movePath === undefined ? change.path : `${change.path} → ${change.movePath}`;
    }
    return change.path;
}

function getAppliedChangeContents(change: AppliedPatchFileChange): AppliedPatchChangeContents {
    if (change.type === "add") return { oldContent: "", newContent: change.content };
    if (change.type === "delete") return { oldContent: change.content, newContent: "" };
    return { oldContent: change.oldContent, newContent: change.newContent };
}

function truncateDiffLines(diff: string, limit: number): string {
    const trimmed = diff.trimEnd();
    if (trimmed.length === 0) return "";
    const lines = trimmed.split("\n");
    if (lines.length <= limit) return trimmed;
    return `${lines.slice(0, limit).join("\n")}\n… ${lines.length - limit} more diff lines`;
}

function renderApplyPatchDiff(diff: string, theme: Theme): string {
    const trimmed = diff.trimEnd();
    if (trimmed.length === 0) return "";
    return trimmed
        .split("\n")
        .map((line) => renderApplyPatchDiffLine(line, theme))
        .join("\n");
}

function renderApplyPatchDiffLine(line: string, theme: Theme): string {
    if (/^-\s*\d*\s/.test(line)) return theme.fg("toolDiffRemoved", line);
    if (/^\+\s*\d*\s/.test(line)) return theme.fg("toolDiffAdded", line);
    if (/^\s+\d+\s/.test(line)) return theme.fg("toolDiffContext", line);
    return theme.fg("muted", line);
}

function summarizePlannedPatchLines(hunks: readonly ApplyPatchHunk[]): ApplyPatchLineSummary {
    return summarizePatchFiles(hunks.map((hunk) => summarizePlannedPatchFile(hunk)));
}

function summarizeAppliedPatchLines(
    changes: readonly AppliedPatchFileChange[],
    hunks: readonly ApplyPatchHunk[],
): ApplyPatchLineSummary {
    return summarizePatchFiles(
        changes.map((change, index) => summarizeAppliedPatchFile(change, hunks[index])),
    );
}

function summarizePatchFiles(files: readonly ApplyPatchFileLineSummary[]): ApplyPatchLineSummary {
    let addedLines = 0;
    let removedLines = 0;
    let unknownRemovedFileCount = 0;
    for (const file of files) {
        addedLines += file.addedLines;
        if (file.removedLines === undefined) {
            unknownRemovedFileCount += 1;
        } else {
            removedLines += file.removedLines;
        }
    }
    return { files, addedLines, removedLines, unknownRemovedFileCount };
}

function summarizePlannedPatchFile(hunk: ApplyPatchHunk): ApplyPatchFileLineSummary {
    if (hunk.type === "add") {
        return {
            action: "A",
            path: hunk.path,
            addedLines: countTextLines(hunk.contents),
            removedLines: 0,
        };
    }
    if (hunk.type === "delete") {
        return { action: "D", path: hunk.path, addedLines: 0, removedLines: undefined };
    }

    const stats = countUpdateLineChanges(hunk);
    return {
        action: "M",
        path: hunk.movePath ?? hunk.path,
        originalPath: hunk.movePath === undefined ? undefined : hunk.path,
        addedLines: stats.addedLines,
        removedLines: stats.removedLines,
    };
}

function summarizeAppliedPatchFile(
    change: AppliedPatchFileChange,
    hunk: ApplyPatchHunk | undefined,
): ApplyPatchFileLineSummary {
    if (hunk !== undefined && hunk.type !== change.type)
        return summarizeAppliedChangeFallback(change);

    if (change.type === "add") {
        const contents = hunk?.type === "add" ? hunk.contents : change.content;
        return {
            action: "A",
            path: hunk?.type === "add" ? hunk.path : change.path,
            addedLines: countTextLines(contents),
            removedLines: 0,
        };
    }
    if (change.type === "delete") {
        return {
            action: "D",
            path: hunk?.type === "delete" ? hunk.path : change.path,
            addedLines: 0,
            removedLines: countTextLines(change.content),
        };
    }

    const updateHunk = hunk?.type === "update" ? hunk : undefined;
    const stats = updateHunk
        ? countUpdateLineChanges(updateHunk)
        : countWholeFileLineChanges(change.oldContent, change.newContent);
    return {
        action: "M",
        path: updateHunk?.movePath ?? updateHunk?.path ?? change.movePath ?? change.path,
        originalPath: updateHunk?.movePath === undefined ? undefined : updateHunk.path,
        addedLines: stats.addedLines,
        removedLines: stats.removedLines,
    };
}

function summarizeAppliedChangeFallback(change: AppliedPatchFileChange): ApplyPatchFileLineSummary {
    if (change.type === "add") {
        return {
            action: "A",
            path: change.path,
            addedLines: countTextLines(change.content),
            removedLines: 0,
        };
    }
    if (change.type === "delete") {
        return {
            action: "D",
            path: change.path,
            addedLines: 0,
            removedLines: countTextLines(change.content),
        };
    }
    const stats = countWholeFileLineChanges(change.oldContent, change.newContent);
    return {
        action: "M",
        path: change.movePath ?? change.path,
        addedLines: stats.addedLines,
        removedLines: stats.removedLines,
    };
}

function formatPatchCallSummary(summary: ApplyPatchLineSummary): string {
    const visibleFiles = summary.files.slice(0, 3).map(formatPatchFileActionPath);
    const remainingFileCount = summary.files.length - visibleFiles.length;
    if (remainingFileCount > 0) visibleFiles.push(`+${remainingFileCount} more`);

    const parts = [visibleFiles.join(", ") || `${summary.files.length} files`];
    const totals = formatPatchLineTotals(summary);
    if (totals.length > 0) parts.push(totals);
    if (summary.unknownRemovedFileCount > 0) {
        parts.push(
            `${summary.unknownRemovedFileCount} ${
                summary.unknownRemovedFileCount === 1 ? "delete" : "deletes"
            }`,
        );
    }
    return parts.join(" • ");
}

function formatPatchLineTotals(summary: ApplyPatchLineSummary): string {
    return formatLineDelta(summary.addedLines, summary.removedLines);
}

function formatPatchFileActionPath(file: ApplyPatchFileLineSummary): string {
    const path =
        file.originalPath === undefined ? file.path : `${file.originalPath} → ${file.path}`;
    return `${file.action} ${path}`;
}

function formatPatchFileLineSummary(file: ApplyPatchFileLineSummary): string {
    const path = formatPatchFileActionPath(file).slice(2);
    const delta = formatLineDelta(file.addedLines, file.removedLines);
    return delta.length > 0 ? `${file.action} ${path} ${delta}` : `${file.action} ${path}`;
}

function formatLineDelta(addedLines: number, removedLines: number | undefined): string {
    const parts: string[] = [];
    if (addedLines > 0) parts.push(`+${addedLines}`);
    if (removedLines !== undefined && removedLines > 0) parts.push(`-${removedLines}`);
    return parts.join(" ");
}

function countUpdateLineChanges(
    hunk: Extract<ApplyPatchHunk, { readonly type: "update" }>,
): ApplyPatchLineChangeCounts {
    let addedLines = 0;
    let removedLines = 0;
    for (const chunk of hunk.chunks) {
        const unchangedLineCount = longestCommonSubsequenceLength(chunk.oldLines, chunk.newLines);
        addedLines += chunk.newLines.length - unchangedLineCount;
        removedLines += chunk.oldLines.length - unchangedLineCount;
    }
    return { addedLines, removedLines };
}

function countWholeFileLineChanges(
    oldContent: string,
    newContent: string,
): ApplyPatchLineChangeCounts {
    const oldLines = splitContentLines(oldContent);
    const newLines = splitContentLines(newContent);
    const unchangedLineCount = longestCommonSubsequenceLength(oldLines, newLines);
    return {
        addedLines: newLines.length - unchangedLineCount,
        removedLines: oldLines.length - unchangedLineCount,
    };
}

function countTextLines(text: string): number {
    return splitContentLines(text).length;
}

function formatDisplayLineDiff(
    oldLines: readonly string[],
    newLines: readonly string[],
): readonly string[] {
    const table = buildLongestCommonSubsequenceTable(oldLines, newLines);
    const lines: string[] = [];
    let oldIndex = 0;
    let newIndex = 0;

    while (oldIndex < oldLines.length && newIndex < newLines.length) {
        const oldLine = oldLines[oldIndex] ?? "";
        const newLine = newLines[newIndex] ?? "";
        if (oldLine === newLine) {
            lines.push(`  ${oldLine}`);
            oldIndex += 1;
            newIndex += 1;
        } else if (
            lcsTableValue(table, oldIndex + 1, newIndex) >=
            lcsTableValue(table, oldIndex, newIndex + 1)
        ) {
            lines.push(`- ${oldLine}`);
            oldIndex += 1;
        } else {
            lines.push(`+ ${newLine}`);
            newIndex += 1;
        }
    }

    while (oldIndex < oldLines.length) {
        lines.push(`- ${oldLines[oldIndex] ?? ""}`);
        oldIndex += 1;
    }
    while (newIndex < newLines.length) {
        lines.push(`+ ${newLines[newIndex] ?? ""}`);
        newIndex += 1;
    }

    return lines;
}

function splitContentLines(text: string): readonly string[] {
    if (text.length === 0) return [];
    const withoutTrailingLineBreak = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (withoutTrailingLineBreak.length === 0) return [];
    return withoutTrailingLineBreak.split("\n");
}

function longestCommonSubsequenceLength(
    oldLines: readonly string[],
    newLines: readonly string[],
): number {
    let previousRow = makeZeroRow(newLines.length + 1);
    for (const oldLine of oldLines) {
        const currentRow = makeZeroRow(newLines.length + 1);
        for (let newIndex = 0; newIndex < newLines.length; newIndex += 1) {
            currentRow[newIndex + 1] =
                oldLine === newLines[newIndex]
                    ? (previousRow[newIndex] ?? 0) + 1
                    : Math.max(previousRow[newIndex + 1] ?? 0, currentRow[newIndex] ?? 0);
        }
        previousRow = currentRow;
    }
    return previousRow[newLines.length] ?? 0;
}

function buildLongestCommonSubsequenceTable(
    oldLines: readonly string[],
    newLines: readonly string[],
): readonly (readonly number[])[] {
    const table = Array.from({ length: oldLines.length + 1 }, () =>
        makeZeroRow(newLines.length + 1),
    );

    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
        const row = table[oldIndex];
        if (row === undefined) continue;
        for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
            row[newIndex] =
                oldLines[oldIndex] === newLines[newIndex]
                    ? lcsTableValue(table, oldIndex + 1, newIndex + 1) + 1
                    : Math.max(
                          lcsTableValue(table, oldIndex + 1, newIndex),
                          lcsTableValue(table, oldIndex, newIndex + 1),
                      );
        }
    }

    return table;
}

function makeZeroRow(length: number): number[] {
    return Array.from<number>({ length }).fill(0);
}

function lcsTableValue(
    table: readonly (readonly number[])[],
    rowIndex: number,
    columnIndex: number,
): number {
    return table[rowIndex]?.[columnIndex] ?? 0;
}
