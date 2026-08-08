import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { appendGraphemeEllipsis, takeGraphemePrefix } from "../text-boundaries.ts";
import { isRecord, stringField } from "../unknown-values.ts";
import {
    changedOnlyDiffSections,
    emptyComponent,
    formatPathTarget,
    makeComponent,
    parseDiffSections,
    renderGlowupBody,
    renderGlowupCall,
    renderGlowupDiff,
    renderGlowupOutput,
    renderMutationCall,
    MUTATION_DIFF_PREVIEW_ROWS,
    type GlowupRenderTheme,
    type DiffLineCoordinates,
    type DiffSection,
} from "./core.ts";
import type {
    ThirdPartyToolRenderer,
    ThirdPartyToolRenderContext,
    ThirdPartyToolResult,
} from "../third-party-tools/types.ts";
import {
    isActiveToolCall,
    toolStatusLabel,
    type ToolLabelMode,
    type ToolLifecycleContext,
} from "./status-labels.ts";
import {
    captureDeletedTextPreview,
    captureTextFilePreimage,
    type DeletedTextPreview,
    type TextFilePreimage,
} from "./delete-preview.ts";
import { scheduleCodeOutputSyntaxLoad } from "../syntax/code-component.ts";
import {
    buildPierreDiffPayload,
    buildPierreDiffPayloadsFromPatch,
    buildPierreSummaryPayload,
    normalizePierreDiffPayload,
} from "../diffs/diff.ts";
import { renderPierreDiff } from "../diffs/renderer.ts";
import type { PierreDiffPayload } from "../diffs/types.ts";
import { diffContentDigest } from "../diffs/identity.ts";
import {
    PREVIEW_MUTATION_SETTINGS,
    showsFullMutation,
    type MutationSettings,
} from "../mutations/settings.ts";

type ApplyPatchKind = "add" | "delete" | "update";

type ApplyPatchSection = DiffSection & {
    readonly kind: ApplyPatchKind;
    readonly countsKnown: boolean;
    readonly pierreDiff?: PierreDiffPayload;
};

type ApplyPatchSummary = {
    readonly sections: readonly ApplyPatchSection[];
};

const MAX_COMPLETED_PATCH_PARSE_CHARS = 64 * 1024;
const MAX_PARTIAL_PATCH_REPLAY_CHARS = 64 * 1024;
const MAX_PARTIAL_PATCH_PREVIEW_LINES = MUTATION_DIFF_PREVIEW_ROWS;
const MAX_PARTIAL_PATCH_LINE_CHARS = 2_000;
const PARTIAL_PATCH_SUFFIX_CHARS = 32;
const MAX_DELETE_PREIMAGE_CALLS = 100;
const MAX_UPDATE_PREIMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PATCH_PREIMAGE_CONCURRENCY = 4;

type MutableApplyPatchSection = {
    kind: ApplyPatchKind;
    path: string;
    movePath: string | undefined;
    lines: string[];
    lineCoordinates: Array<DiffLineCoordinates | undefined>;
    added: number;
    removed: number;
    oldLine: number;
    newLine: number;
    lineNumbersKnown: boolean;
};

const deletePreimages = new Map<string, Map<string, DeletedTextPreview>>();
const updatePreimages = new Map<string, Map<string, TextFilePreimage>>();
const unavailableUpdatePreimages = new Map<string, Map<string, true>>();
const pendingUpdatePreimages = new Map<string, Map<string, Promise<void>>>();
const applyPatchCaptures = new Map<
    string,
    {
        readonly cwd: string;
        readonly files: readonly {
            readonly kind: ApplyPatchKind;
            readonly path: string;
            readonly outputPath: string;
        }[];
    }
>();
const persistedSummaries = new Map<string, ApplyPatchSummary>();
const persistedSummaryDiffs = new Map<string, string>();
const persistedUnifiedPatches = new Map<string, string>();
const persistedSummaryLimitKeys = new Map<string, string>();
const persistedInputPatches = new Map<string, string>();
const completedPatchSummaries = new Map<
    string,
    { readonly patch: string; readonly summary: ApplyPatchSummary | undefined }
>();

/** Drops session-scoped mutation snapshots and pending preimage references. */
export function clearApplyPatchRenderingState(): void {
    deletePreimages.clear();
    updatePreimages.clear();
    unavailableUpdatePreimages.clear();
    pendingUpdatePreimages.clear();
    applyPatchCaptures.clear();
    persistedSummaries.clear();
    persistedSummaryDiffs.clear();
    persistedUnifiedPatches.clear();
    persistedSummaryLimitKeys.clear();
    persistedInputPatches.clear();
    completedPatchSummaries.clear();
}

function rememberBounded<T>(store: Map<string, T>, key: string, value: T): void {
    store.delete(key);
    store.set(key, value);
    while (store.size > MAX_DELETE_PREIMAGE_CALLS) {
        const oldest = store.keys().next().value;
        if (typeof oldest !== "string") break;
        store.delete(oldest);
    }
}

function patchTextFromArgs(args: unknown): string | undefined {
    return (
        stringField(args, "patch") ??
        stringField(args, "input") ??
        stringField(args, "command") ??
        (typeof args === "string" ? args : undefined)
    );
}

function boundedPreimageMap<T>(
    store: Map<string, Map<string, T>>,
    toolCallId: string,
): Map<string, T> {
    let previews = store.get(toolCallId);
    if (previews !== undefined) {
        return previews;
    }
    previews = new Map();
    store.set(toolCallId, previews);
    while (store.size > MAX_DELETE_PREIMAGE_CALLS) {
        const oldest = store.keys().next().value;
        if (typeof oldest !== "string") {
            break;
        }
        store.delete(oldest);
    }
    return previews;
}

export async function captureApplyPatchPreimages(
    toolCallId: string,
    cwd: string,
    args: unknown,
    options: { readonly maxDeletePreimageBytes?: number | null } = {},
): Promise<void> {
    const patch = patchTextFromArgs(args);
    if (patch === undefined) {
        return;
    }
    const deletePreviews = boundedPreimageMap(deletePreimages, toolCallId);
    const updatePreviews = boundedPreimageMap(updatePreimages, toolCallId);
    const unavailableUpdates = boundedPreimageMap(unavailableUpdatePreimages, toolCallId);
    const pendingUpdates = boundedPreimageMap(pendingUpdatePreimages, toolCallId);
    const deletePaths = new Set<string>();
    const updatePaths = new Set<string>();
    const addPaths = new Set<string>();
    const movedUpdatePaths = new Map<string, string>();
    let currentUpdatePath: string | undefined;
    for (const line of patch.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n")) {
        if (line.startsWith("*** Add File: ")) {
            const filePath = line.slice("*** Add File: ".length);
            if (filePath.length > 0) addPaths.add(filePath);
            currentUpdatePath = undefined;
        }
        if (line.startsWith("*** Delete File: ")) {
            const filePath = line.slice("*** Delete File: ".length);
            if (filePath.length > 0) deletePaths.add(filePath);
            currentUpdatePath = undefined;
        }
        if (line.startsWith("*** Update File: ")) {
            const filePath = line.slice("*** Update File: ".length);
            if (filePath.length > 0) {
                updatePaths.add(filePath);
                currentUpdatePath = filePath;
            }
        }
        if (line.startsWith("*** Move to: ") && currentUpdatePath !== undefined) {
            const outputPath = line.slice("*** Move to: ".length);
            if (outputPath.length > 0) movedUpdatePaths.set(currentUpdatePath, outputPath);
        }
    }
    rememberBounded(applyPatchCaptures, toolCallId, {
        cwd,
        files: [
            ...Array.from(addPaths, (filePath) => ({
                kind: "add" as const,
                path: filePath,
                outputPath: filePath,
            })),
            ...Array.from(deletePaths, (filePath) => ({
                kind: "delete" as const,
                path: filePath,
                outputPath: filePath,
            })),
            ...Array.from(updatePaths, (filePath) => ({
                kind: "update" as const,
                path: filePath,
                outputPath: movedUpdatePaths.get(filePath) ?? filePath,
            })),
        ],
    });

    const tasks: Array<() => Promise<void>> = [];
    for (const filePath of deletePaths) {
        if (deletePreviews.has(filePath)) continue;
        tasks.push(async () => {
            const preview = await captureDeletedTextPreview(
                cwd,
                filePath,
                options.maxDeletePreimageBytes,
            );
            if (preview !== undefined) deletePreviews.set(filePath, preview);
        });
    }
    for (const filePath of updatePaths) {
        if (updatePreviews.has(filePath) || unavailableUpdates.has(filePath)) continue;
        tasks.push(async () => {
            const pending = pendingUpdates.get(filePath);
            if (pending !== undefined) await pending;
            if (updatePreviews.has(filePath) || unavailableUpdates.has(filePath)) return;
            const request = captureTextFilePreimage(cwd, filePath, MAX_UPDATE_PREIMAGE_BYTES, {
                allowOutsideCwd: true,
            })
                .then((preview) => {
                    if (preview === undefined) unavailableUpdates.set(filePath, true);
                    else updatePreviews.set(filePath, preview);
                })
                .finally(() => {
                    pendingUpdates.delete(filePath);
                });
            pendingUpdates.set(filePath, request);
            await request;
        });
    }

    let nextTask = 0;
    const workers = Array.from(
        { length: Math.min(MAX_PATCH_PREIMAGE_CONCURRENCY, tasks.length) },
        async () => {
            while (nextTask < tasks.length) {
                const task = tasks[nextTask];
                nextTask += 1;
                await task?.();
            }
        },
    );
    await Promise.all(workers);
}

/** Builds source-backed immutable Pierre payloads after an apply_patch call completes. */
export async function finishApplyPatchPierrePayloads(
    toolCallId: string,
    isError: boolean,
    mutationSettings: MutationSettings,
): Promise<readonly PierreDiffPayload[]> {
    const capture = applyPatchCaptures.get(toolCallId);
    applyPatchCaptures.delete(toolCallId);
    if (capture === undefined || isError) return [];

    const pending = pendingUpdatePreimages.get(toolCallId);
    if (pending !== undefined) await Promise.all(pending.values());
    const updates = updatePreimages.get(toolCallId);
    const deletes = deletePreimages.get(toolCallId);
    const snapshotLimit = mutationSettings.limits.maxDiffBytes ?? MAX_UPDATE_PREIMAGE_BYTES;
    const payloads: PierreDiffPayload[] = [];
    for (const file of capture.files) {
        const oldSnapshot =
            file.kind === "update"
                ? updates?.get(file.path)
                : file.kind === "delete"
                  ? deletes?.get(file.path)?.preimage
                  : { lines: [], endsWithNewline: false };
        if (oldSnapshot === undefined) continue;
        const newSnapshot =
            file.kind === "delete"
                ? { lines: [] as readonly string[], endsWithNewline: false }
                : await captureTextFilePreimage(capture.cwd, file.outputPath, snapshotLimit, {
                      allowOutsideCwd: true,
                  });
        if (newSnapshot === undefined) continue;
        const oldContent = textFilePreimageContent(oldSnapshot);
        const newContent = textFilePreimageContent(newSnapshot);
        const payload = buildPierreDiffPayload(
            {
                path:
                    file.path === file.outputPath ? file.path : `${file.path} → ${file.outputPath}`,
                oldPath: file.path,
                newPath: file.outputPath,
                oldContent,
                newContent,
                oldSizeBytes: Buffer.byteLength(oldContent, "utf8"),
                newSizeBytes: Buffer.byteLength(newContent, "utf8"),
                oldLineCount: oldSnapshot.lines.length,
                newLineCount: newSnapshot.lines.length,
                canBuildPierreDiff: true,
            },
            {
                maxBytes: mutationSettings.limits.maxDiffBytes,
                maxLines: mutationSettings.limits.maxDiffLines,
            },
        );
        if (payload !== undefined) payloads.push(payload);
    }
    return payloads;
}

function textFilePreimageContent(preimage: TextFilePreimage): string {
    const content = preimage.lines.join("\n");
    return preimage.endsWithNewline ? `${content}\n` : content;
}

function scheduleApplyPatchSyntaxLoads(patch: string, invalidate: (() => void) | undefined): void {
    if (invalidate === undefined) return;
    const paths = new Set<string>();
    for (const line of patch.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n")) {
        const section = partialPatchSectionHeader(line);
        if (section !== undefined && section.path.length > 0) {
            paths.add(section.path);
        }
    }
    for (const path of paths) {
        scheduleCodeOutputSyntaxLoad({ path }, invalidate);
    }
}

function hydrateDeletePreimages(summary: ApplyPatchSummary, toolCallId: string): ApplyPatchSummary {
    const previews = deletePreimages.get(toolCallId);
    if (previews === undefined) {
        return summary;
    }
    return {
        sections: summary.sections.map((section) => {
            if (section.kind !== "delete" || section.path === undefined) {
                return section;
            }
            const preview = previews.get(section.path);
            return preview === undefined
                ? section
                : {
                      ...section,
                      lines: preview.section.lines,
                      removed: preview.removed,
                      countsKnown: true,
                  };
        }),
    };
}

function persistedApplyPatchSummary(
    result: ThirdPartyToolResult | undefined,
    mutationSettings: MutationSettings = PREVIEW_MUTATION_SETTINGS,
): ApplyPatchSummary | undefined {
    if (!isRecord(result?.details)) return undefined;
    const diff = stringField(result.details, "diff");
    if (diff === undefined || diff.trim().length === 0) return undefined;
    const sections = diff
        .trimEnd()
        .split(/\n{2,}/u)
        .flatMap((block) => {
            const normalizedBlock = block.trimStart();
            const separator = normalizedBlock.indexOf("\n");
            if (separator < 0) return [];
            const path = normalizedBlock.slice(0, separator).trim();
            const body = normalizedBlock.slice(separator + 1);
            return path.length === 0 ? [] : parseDiffSections(body, path);
        });
    if (sections.length === 0) return undefined;
    const lineSummary = isRecord(result.details.lineSummary)
        ? result.details.lineSummary
        : undefined;
    const files = Array.isArray(lineSummary?.files) ? lineSummary.files : [];
    const unifiedPatch = stringField(result.details, "patch");
    const limits = {
        maxBytes: mutationSettings.limits.maxDiffBytes,
        maxLines: mutationSettings.limits.maxDiffLines,
    };
    const restoredPierreDiffs = Array.isArray(result.details.pierreDiffs)
        ? result.details.pierreDiffs.flatMap((payload) => {
              const normalized = normalizePierreDiffPayload(payload, limits);
              return normalized === undefined ? [] : [normalized];
          })
        : [];
    const pierreDiffs =
        restoredPierreDiffs.length > 0
            ? restoredPierreDiffs
            : unifiedPatch === undefined
              ? []
              : buildPierreDiffPayloadsFromPatch(unifiedPatch, limits);
    const singleSection = sections.length === 1 ? sections[0] : undefined;
    const singleKeys = singleSection === undefined ? [] : sectionPathKeys(singleSection);
    const singlePierre =
        singleSection === undefined
            ? undefined
            : pierreDiffs.find((payload) =>
                  pathsIntersect(pierrePayloadPaths(payload), singleKeys),
              );
    const singleFile =
        singleSection === undefined
            ? undefined
            : files.find(
                  (file): file is Record<string, unknown> =>
                      isRecord(file) && pathsIntersect(fileSummaryPaths(file), singleKeys),
              );
    const pierreByPath = singleSection === undefined ? pierrePayloadQueues(pierreDiffs) : undefined;
    const filesByPath = singleSection === undefined ? fileSummaryQueues(files) : undefined;
    return applyMutationLimits(
        {
            sections: sections.map((section): ApplyPatchSection => {
                const file =
                    filesByPath === undefined
                        ? singleFile
                        : consumePathMatch(filesByPath, sectionPathKeys(section));
                const action = file === undefined ? undefined : stringField(file, "action");
                const kind: ApplyPatchKind =
                    action === "A" ? "add" : action === "D" ? "delete" : "update";
                const pierreDiff =
                    pierreByPath === undefined
                        ? singlePierre
                        : consumePathMatch(pierreByPath, sectionPathKeys(section));
                const path = completedSectionPath(section, file, pierreDiff);
                return {
                    ...section,
                    ...(path === undefined ? {} : { path }),
                    kind,
                    countsKnown: true,
                    ...(pierreDiff === undefined ? {} : { pierreDiff }),
                };
            }),
        },
        mutationSettings,
    );
}

function attachPersistedPierreDiffs(
    summary: ApplyPatchSummary,
    unifiedPatch: string | undefined,
    mutationSettings: MutationSettings,
): ApplyPatchSummary {
    if (unifiedPatch === undefined) return applyMutationLimits(summary, mutationSettings);
    const pierreDiffs = buildPierreDiffPayloadsFromPatch(unifiedPatch, {
        maxBytes: mutationSettings.limits.maxDiffBytes,
        maxLines: mutationSettings.limits.maxDiffLines,
    });
    const pierreByPath = pierrePayloadQueues(pierreDiffs);
    return applyMutationLimits(
        {
            sections: summary.sections.map((section) => {
                const pierreDiff = consumePathMatch(pierreByPath, sectionPathKeys(section));
                return pierreDiff === undefined ? section : { ...section, pierreDiff };
            }),
        },
        mutationSettings,
    );
}

function normalizedPatchPath(pathValue: string): string {
    return pathValue
        .replaceAll("\\", "/")
        .replace(/^\.\//u, "")
        .replace(/^(?:a|b)\//u, "")
        .replace(/\/{2,}/gu, "/");
}

function sectionPathKeys(section: Pick<ApplyPatchSection, "path">): readonly string[] {
    return section.path === undefined ? [] : section.path.split(" → ").map(normalizedPatchPath);
}

function completedSectionPath(
    section: Pick<DiffSection, "path">,
    file: Record<string, unknown> | undefined,
    pierreDiff: PierreDiffPayload | undefined,
): string | undefined {
    const currentPath = file === undefined ? undefined : stringField(file, "path");
    const previousPath = file === undefined ? undefined : stringField(file, "previousPath");
    if (
        currentPath !== undefined &&
        previousPath !== undefined &&
        normalizedPatchPath(currentPath) !== normalizedPatchPath(previousPath)
    ) {
        return `${previousPath} → ${currentPath}`;
    }
    if (pierreDiff?.path.includes(" → ") === true) {
        return pierreDiff.path;
    }
    return section.path;
}

type PathQueues<T extends object> = {
    readonly queues: Map<string, T[]>;
    readonly consumed: Set<T>;
};

function pierrePayloadQueues(
    payloads: readonly PierreDiffPayload[],
): PathQueues<PierreDiffPayload> {
    const queues = new Map<string, PierreDiffPayload[]>();
    for (const payload of payloads) {
        for (const pathValue of new Set(pierrePayloadPaths(payload))) {
            const queue = queues.get(pathValue) ?? [];
            queue.push(payload);
            queues.set(pathValue, queue);
        }
    }
    return { queues, consumed: new Set() };
}

function fileSummaryQueues(files: readonly unknown[]): PathQueues<Record<string, unknown>> {
    const queues = new Map<string, Record<string, unknown>[]>();
    for (const file of files) {
        if (!isRecord(file)) continue;
        for (const pathValue of new Set(fileSummaryPaths(file))) {
            const queue = queues.get(pathValue) ?? [];
            queue.push(file);
            queues.set(pathValue, queue);
        }
    }
    return { queues, consumed: new Set() };
}

function pierrePayloadPaths(payload: PierreDiffPayload): readonly string[] {
    const paths =
        payload.kind === "renderable"
            ? [payload.metadata.name, payload.metadata.prevName].filter(
                  (value): value is string => value !== undefined,
              )
            : payload.path.split(" → ");
    return paths.map(normalizedPatchPath);
}

function fileSummaryPaths(file: Record<string, unknown>): readonly string[] {
    return [stringField(file, "path"), stringField(file, "previousPath")]
        .filter((value): value is string => value !== undefined)
        .map(normalizedPatchPath);
}

function pathsIntersect(left: readonly string[], right: readonly string[]): boolean {
    return left.some((pathValue) => right.includes(pathValue));
}

function consumePathMatch<T extends object>(
    index: PathQueues<T>,
    keys: readonly string[],
): T | undefined {
    for (const key of keys) {
        const queue = index.queues.get(key);
        while (queue !== undefined && queue.length > 0) {
            const match = queue.shift();
            if (match !== undefined && !index.consumed.has(match)) {
                index.consumed.add(match);
                return match;
            }
        }
    }
    return undefined;
}

function mutationLimitKey(mutationSettings: MutationSettings): string {
    const { maxDiffBytes, maxDiffLines } = mutationSettings.limits;
    return `${maxDiffBytes ?? "none"}:${maxDiffLines ?? "none"}`;
}

function rememberPersistedSummary(options: {
    readonly toolCallId: string;
    readonly summary: ApplyPatchSummary;
    readonly diff: string;
    readonly unifiedPatch: string | undefined;
    readonly inputPatch: string | undefined;
    readonly mutationSettings: MutationSettings;
}): void {
    rememberBounded(persistedSummaries, options.toolCallId, options.summary);
    rememberBounded(persistedSummaryDiffs, options.toolCallId, options.diff);
    rememberBounded(
        persistedSummaryLimitKeys,
        options.toolCallId,
        mutationLimitKey(options.mutationSettings),
    );
    if (options.unifiedPatch === undefined) {
        persistedUnifiedPatches.delete(options.toolCallId);
    } else {
        rememberBounded(persistedUnifiedPatches, options.toolCallId, options.unifiedPatch);
    }
    if (options.inputPatch === undefined) {
        persistedInputPatches.delete(options.toolCallId);
    } else {
        rememberBounded(persistedInputPatches, options.toolCallId, options.inputPatch);
    }
}

function persistedSummaryForRender(
    toolCallId: string,
    result: ThirdPartyToolResult | undefined,
    inputPatch: string | undefined,
    mutationSettings: MutationSettings,
): ApplyPatchSummary | undefined {
    const details = isRecord(result?.details) ? result.details : undefined;
    const diff = details === undefined ? undefined : stringField(details, "diff");
    const unifiedPatch = details === undefined ? undefined : stringField(details, "patch");
    const limitKey = mutationLimitKey(mutationSettings);
    const storedSummary = persistedSummaries.get(toolCallId);
    const storedInputPatch = persistedInputPatches.get(toolCallId);
    const inputMatches = storedInputPatch === undefined || storedInputPatch === inputPatch;
    if (!inputMatches && diff === undefined) {
        return undefined;
    }
    if (
        diff === undefined &&
        storedSummary !== undefined &&
        inputMatches &&
        persistedSummaryLimitKeys.get(toolCallId) === limitKey
    ) {
        return storedSummary;
    }
    if (
        storedSummary !== undefined &&
        inputMatches &&
        persistedSummaryDiffs.get(toolCallId) === diff &&
        persistedUnifiedPatches.get(toolCallId) === unifiedPatch &&
        persistedSummaryLimitKeys.get(toolCallId) === limitKey
    ) {
        return storedSummary;
    }
    if (diff !== undefined) {
        const summary = persistedApplyPatchSummary(result, mutationSettings);
        if (summary !== undefined) {
            rememberPersistedSummary({
                toolCallId,
                summary,
                diff,
                unifiedPatch,
                inputPatch,
                mutationSettings,
            });
        }
        return summary;
    }
    if (storedSummary === undefined) return undefined;
    const refreshed = attachPersistedPierreDiffs(
        storedSummary,
        persistedUnifiedPatches.get(toolCallId),
        mutationSettings,
    );
    rememberBounded(persistedSummaries, toolCallId, refreshed);
    rememberBounded(persistedSummaryLimitKeys, toolCallId, limitKey);
    return refreshed;
}

function applyMutationLimits(
    summary: ApplyPatchSummary,
    mutationSettings: MutationSettings,
): ApplyPatchSummary {
    const { maxDiffBytes, maxDiffLines } = mutationSettings.limits;
    return {
        sections: summary.sections.map((section) => {
            if (section.pierreDiff !== undefined) return section;
            const sizeBytes = Buffer.byteLength(section.lines.join("\n"), "utf8");
            const exceedsLines = maxDiffLines !== null && section.lines.length > maxDiffLines;
            const exceedsBytes = maxDiffBytes !== null && sizeBytes > maxDiffBytes;
            if (!exceedsLines && !exceedsBytes) return section;
            return {
                ...section,
                pierreDiff: buildPierreSummaryPayload(
                    section.path ?? "file",
                    {
                        added: section.added,
                        removed: section.removed,
                        lineCount: section.lines.length,
                        sizeBytes,
                    },
                    "too-large",
                    { maxBytes: maxDiffBytes, maxLines: maxDiffLines },
                ),
            };
        }),
    };
}

function changedOnlyApplyPatchSummary(summary: ApplyPatchSummary): ApplyPatchSummary {
    return {
        sections: summary.sections.flatMap((section) =>
            changedOnlyDiffSections([section]).map((changedSection) => ({
                ...section,
                ...changedSection,
            })),
        ),
    };
}

/** Rehydrates immutable apply_patch history from persisted session tool results. */
export function restoreApplyPatchResultSummaries(
    entries: readonly unknown[],
    mutationSettings: MutationSettings = PREVIEW_MUTATION_SETTINGS,
): void {
    for (const entry of entries) {
        if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
        const message = entry.message;
        if (message.role !== "toolResult") continue;
        const toolName = stringField(message, "toolName");
        const toolCallId = stringField(message, "toolCallId");
        if (
            toolCallId === undefined ||
            toolName === undefined ||
            (toolName !== "apply_patch" && !toolName.endsWith("__apply_patch"))
        ) {
            continue;
        }
        const result = { details: message.details };
        const summary = persistedApplyPatchSummary(result, mutationSettings);
        const diff = isRecord(message.details) ? stringField(message.details, "diff") : undefined;
        if (summary === undefined || diff === undefined) continue;
        const unifiedPatch = isRecord(message.details)
            ? stringField(message.details, "patch")
            : undefined;
        rememberPersistedSummary({
            toolCallId,
            summary,
            diff,
            unifiedPatch,
            inputPatch: undefined,
            mutationSettings,
        });
    }
}

function displayPath(section: MutableApplyPatchSection): string {
    return section.movePath === undefined ? section.path : `${section.path} → ${section.movePath}`;
}

function hasUnnumberedDiffRows(section: ApplyPatchSection): boolean {
    return section.lines.some((line) => {
        const sign = line.charAt(0);
        return (
            (sign === "+" || sign === "-" || sign === " ") &&
            !line.trimStart().startsWith("…") &&
            !/^[+\- ]\d+ /u.test(line)
        );
    });
}

function lineCount(text: string): number {
    if (text.length === 0) {
        return 0;
    }

    let lines = text.endsWith("\n") ? 0 : 1;
    for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) {
            lines += 1;
        }
    }
    return lines;
}

function hasCompletePatchEnvelope(patchText: string): boolean {
    return patchText.trimEnd().endsWith("*** End Patch") && patchText.includes("*** Begin Patch");
}

function canParseCompletedPatchCall(patchText: string): boolean {
    return (
        patchText.length <= MAX_COMPLETED_PATCH_PARSE_CHARS && hasCompletePatchEnvelope(patchText)
    );
}

function parseCompletedPatchCall(patchText: string): ApplyPatchSummary | undefined {
    if (!canParseCompletedPatchCall(patchText)) return undefined;
    const key = diffContentDigest(patchText);
    const cached = completedPatchSummaries.get(key);
    if (cached?.patch === patchText) return cached.summary;
    const summary = parseApplyPatchSummary(patchText);
    completedPatchSummaries.delete(key);
    completedPatchSummaries.set(key, { patch: patchText, summary });
    while (completedPatchSummaries.size > MAX_DELETE_PREIMAGE_CALLS) {
        const oldest = completedPatchSummaries.keys().next().value;
        if (typeof oldest !== "string") break;
        completedPatchSummaries.delete(oldest);
    }
    return summary;
}

function makeSection(kind: ApplyPatchKind, path: string): MutableApplyPatchSection {
    return {
        kind,
        path,
        movePath: undefined,
        lines: [],
        lineCoordinates: [],
        added: 0,
        removed: 0,
        oldLine: 1,
        newLine: 1,
        lineNumbersKnown: kind === "add",
    };
}

function numberedDiffLine(
    sign: "+" | "-" | " ",
    lineNumber: number,
    content: string,
    known: boolean,
): string {
    return known ? `${sign}${lineNumber} ${content}` : `${sign} ${content}`;
}

function appendNumberedDiffLine(
    section: MutableApplyPatchSection,
    sign: "+" | "-" | " ",
    content: string,
    known: boolean,
    oldLine: number | undefined,
    newLine: number | undefined,
): void {
    const lineNumber = sign === "-" ? oldLine : newLine;
    section.lines.push(numberedDiffLine(sign, lineNumber ?? 0, content, known));
    section.lineCoordinates.push(
        known
            ? {
                  ...(oldLine === undefined ? {} : { oldLine }),
                  ...(newLine === undefined ? {} : { newLine }),
              }
            : undefined,
    );
}

function applyHunkCoordinates(section: MutableApplyPatchSection, line: string): void {
    const match = /^@@ -(?<oldLine>\d+)(?:,\d+)? \+(?<newLine>\d+)(?:,\d+)?(?: @@|$)/u.exec(line);
    const oldLine = Number(match?.groups?.oldLine);
    const newLine = Number(match?.groups?.newLine);
    if (!Number.isSafeInteger(oldLine) || !Number.isSafeInteger(newLine)) {
        return;
    }
    section.oldLine = oldLine;
    section.newLine = newLine;
    section.lineNumbersKnown = true;
}

function finalizedSection(section: MutableApplyPatchSection): ApplyPatchSection {
    return {
        kind: section.kind,
        path: displayPath(section),
        lines: [...section.lines],
        lineCoordinates: [...section.lineCoordinates],
        added: section.added,
        removed: section.removed,
        countsKnown: section.kind !== "delete",
    };
}

function parseApplyPatchSummary(patchText: string): ApplyPatchSummary | undefined {
    const normalized = patchText.trim().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.startsWith("*** Begin Patch") || !normalized.includes("*** End Patch")) {
        return undefined;
    }

    const sections: ApplyPatchSection[] = [];
    let current: MutableApplyPatchSection | undefined;

    function flush(): void {
        if (current === undefined) {
            return;
        }
        sections.push(finalizedSection(current));
        current = undefined;
    }

    for (const line of normalized.split("\n")) {
        const addPath = line.startsWith("*** Add File: ")
            ? line.slice("*** Add File: ".length)
            : undefined;
        if (addPath !== undefined) {
            flush();
            current = makeSection("add", addPath);
            continue;
        }

        const deletePath = line.startsWith("*** Delete File: ")
            ? line.slice("*** Delete File: ".length)
            : undefined;
        if (deletePath !== undefined) {
            flush();
            current = makeSection("delete", deletePath);
            continue;
        }

        const updatePath = line.startsWith("*** Update File: ")
            ? line.slice("*** Update File: ".length)
            : undefined;
        if (updatePath !== undefined) {
            flush();
            current = makeSection("update", updatePath);
            continue;
        }

        if (current === undefined) {
            continue;
        }

        if (current.kind === "update" && line.startsWith("*** Move to: ")) {
            current.movePath = line.slice("*** Move to: ".length);
            continue;
        }

        if (line === "*** End Patch") {
            flush();
            break;
        }

        if (line === "*** End of File") {
            continue;
        }

        if (current.kind === "add") {
            if (line.startsWith("+")) {
                current.added += 1;
                appendNumberedDiffLine(current, "+", line.slice(1), true, undefined, current.added);
            }
            continue;
        }

        if (current.kind === "delete") {
            continue;
        }

        if (line === "@@" || line.startsWith("@@ ")) {
            applyHunkCoordinates(current, line);
            continue;
        }

        if (line.startsWith("+")) {
            current.added += 1;
            appendNumberedDiffLine(
                current,
                "+",
                line.slice(1),
                current.lineNumbersKnown,
                undefined,
                current.newLine,
            );
            current.newLine += 1;
            continue;
        }

        if (line.startsWith("-")) {
            current.removed += 1;
            appendNumberedDiffLine(
                current,
                "-",
                line.slice(1),
                current.lineNumbersKnown,
                current.oldLine,
                undefined,
            );
            current.oldLine += 1;
            continue;
        }

        if (line.startsWith(" ")) {
            appendNumberedDiffLine(
                current,
                " ",
                line.slice(1),
                current.lineNumbersKnown,
                current.oldLine,
                current.newLine,
            );
            current.oldLine += 1;
            current.newLine += 1;
            continue;
        }

        if (line.length === 0) {
            appendNumberedDiffLine(
                current,
                " ",
                "",
                current.lineNumbersKnown,
                current.oldLine,
                current.newLine,
            );
            current.oldLine += 1;
            current.newLine += 1;
        }
    }

    flush();

    if (sections.length === 0) {
        return undefined;
    }

    return { sections };
}

type UpdateHunkRow = {
    readonly sign: "+" | "-" | " ";
    readonly content: string;
};

type UpdateHunk = {
    readonly oldStart: number | undefined;
    readonly newStart: number | undefined;
    readonly rows: readonly UpdateHunkRow[];
};

type UpdatePatchSection = {
    readonly path: string;
    readonly hunks: readonly UpdateHunk[];
};

function completedUpdateSections(patchText: string): readonly UpdatePatchSection[] {
    const sections: UpdatePatchSection[] = [];
    let path: string | undefined;
    let hunks: UpdateHunk[] = [];
    let rows: UpdateHunkRow[] | undefined;
    let oldStart: number | undefined;
    let newStart: number | undefined;

    function flushHunk(): void {
        if (rows !== undefined) {
            hunks.push({ oldStart, newStart, rows });
        }
        rows = undefined;
        oldStart = undefined;
        newStart = undefined;
    }

    function flushSection(): void {
        flushHunk();
        if (path !== undefined) {
            sections.push({ path, hunks });
        }
        path = undefined;
        hunks = [];
    }

    const normalized = patchText.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
    for (const line of normalized.split("\n")) {
        if (line.startsWith("*** Update File: ")) {
            flushSection();
            path = line.slice("*** Update File: ".length);
            continue;
        }
        if (
            line.startsWith("*** Add File: ") ||
            line.startsWith("*** Delete File: ") ||
            line === "*** End Patch"
        ) {
            flushSection();
            continue;
        }
        if (path === undefined || line === "*** End of File" || line.startsWith("*** Move to: ")) {
            continue;
        }
        if (line === "@@" || line.startsWith("@@ ")) {
            flushHunk();
            rows = [];
            const match = /^@@ -(?<oldLine>\d+)(?:,\d+)? \+(?<newLine>\d+)(?:,\d+)?(?: @@|$)/u.exec(
                line,
            );
            const parsedOldStart = Number(match?.groups?.oldLine);
            const parsedNewStart = Number(match?.groups?.newLine);
            oldStart = Number.isSafeInteger(parsedOldStart) ? parsedOldStart : undefined;
            newStart = Number.isSafeInteger(parsedNewStart) ? parsedNewStart : undefined;
            continue;
        }
        const sign = line.charAt(0);
        if (sign === "+" || sign === "-" || sign === " ") {
            rows ??= [];
            rows.push({ sign, content: line.slice(1) });
            continue;
        }
        if (line.length === 0 && rows !== undefined) {
            rows.push({ sign: " ", content: "" });
        }
    }
    flushSection();
    return sections;
}

function matchingLineSequence(
    source: readonly string[],
    needle: readonly string[],
    fromIndex: number,
): number | undefined {
    if (needle.length === 0) {
        return undefined;
    }
    let matchedIndex: number | undefined;
    for (let index = fromIndex; index + needle.length <= source.length; index += 1) {
        if (!needle.every((line, offset) => source[index + offset] === line)) {
            continue;
        }
        if (matchedIndex !== undefined) {
            return undefined;
        }
        matchedIndex = index;
    }
    return matchedIndex;
}

function numberedUpdateHunks(
    hunks: readonly UpdateHunk[],
    preimage: TextFilePreimage | undefined,
):
    | {
          readonly lines: readonly string[];
          readonly lineCoordinates: ReadonlyArray<DiffLineCoordinates>;
      }
    | undefined {
    const lines: string[] = [];
    const lineCoordinates: DiffLineCoordinates[] = [];
    let oldCursor = 0;
    let lineDelta = 0;

    for (const hunk of hunks) {
        const oldNeedle = hunk.rows.filter((row) => row.sign !== "+").map((row) => row.content);
        const matchedIndex =
            hunk.oldStart === undefined && preimage !== undefined
                ? matchingLineSequence(preimage.lines, oldNeedle, oldCursor)
                : undefined;
        const oldStart =
            hunk.oldStart ?? (matchedIndex === undefined ? undefined : matchedIndex + 1);
        if (oldStart === undefined) {
            return undefined;
        }
        const newStart = hunk.newStart ?? oldStart + lineDelta;
        let oldLine = oldStart;
        let newLine = newStart;
        for (const row of hunk.rows) {
            lines.push(
                numberedDiffLine(row.sign, row.sign === "-" ? oldLine : newLine, row.content, true),
            );
            lineCoordinates.push({
                ...(row.sign === "+" ? {} : { oldLine }),
                ...(row.sign === "-" ? {} : { newLine }),
            });
            if (row.sign !== "+") oldLine += 1;
            if (row.sign !== "-") newLine += 1;
        }
        oldCursor = oldLine - 1;
        lineDelta = newLine - oldLine;
    }
    return { lines, lineCoordinates };
}

function hydrateUpdateLineNumbers(
    summary: ApplyPatchSummary,
    patchText: string,
    toolCallId: string,
): ApplyPatchSummary {
    const updates = completedUpdateSections(patchText);
    const preimages = updatePreimages.get(toolCallId);
    let updateIndex = 0;
    return {
        sections: summary.sections.map((section) => {
            if (section.kind !== "update") {
                return section;
            }
            const update = updates[updateIndex];
            updateIndex += 1;
            if (update === undefined) {
                return section;
            }
            const numbered = numberedUpdateHunks(update.hunks, preimages?.get(update.path));
            return numbered === undefined ? section : { ...section, ...numbered };
        }),
    };
}

type PartialApplyPatchSection = MutableApplyPatchSection & {
    diffLineCount: number;
};

function makePartialSection(kind: ApplyPatchKind, path: string): PartialApplyPatchSection {
    return {
        ...makeSection(kind, path),
        diffLineCount: 0,
    };
}

function copyPartialSection(section: PartialApplyPatchSection): PartialApplyPatchSection {
    return {
        ...section,
        lines: [...section.lines],
        lineCoordinates: [...section.lineCoordinates],
    };
}

function partialPatchSectionHeader(
    line: string,
): { readonly kind: ApplyPatchKind; readonly path: string } | undefined {
    for (const candidate of [
        { prefix: "*** Add File: ", kind: "add" },
        { prefix: "*** Delete File: ", kind: "delete" },
        { prefix: "*** Update File: ", kind: "update" },
    ] as const) {
        if (line.startsWith(candidate.prefix)) {
            return { kind: candidate.kind, path: line.slice(candidate.prefix.length) };
        }
    }
    return undefined;
}

function appendPartialPatchDiffLine(
    section: PartialApplyPatchSection,
    sign: "+" | "-" | " ",
    content: string,
    oldLine: number | undefined,
    newLine: number | undefined,
): void {
    section.diffLineCount += 1;
    appendNumberedDiffLine(section, sign, content, section.lineNumbersKnown, oldLine, newLine);
    if (section.lines.length > MAX_PARTIAL_PATCH_PREVIEW_LINES) {
        section.lines.shift();
        section.lineCoordinates.shift();
    }
}

function applyPartialPatchBodyLine(section: PartialApplyPatchSection, line: string): void {
    if (line === "*** End Patch" || line === "*** End of File") {
        return;
    }

    if (section.kind === "add") {
        if (line.startsWith("+")) {
            section.added += 1;
            appendPartialPatchDiffLine(section, "+", line.slice(1), undefined, section.added);
        }
        return;
    }

    if (section.kind === "delete") {
        return;
    }
    if (line === "@@" || line.startsWith("@@ ")) {
        applyHunkCoordinates(section, line);
        return;
    }

    if (line.startsWith("+")) {
        section.added += 1;
        appendPartialPatchDiffLine(section, "+", line.slice(1), undefined, section.newLine);
        section.newLine += 1;
        return;
    }

    if (line.startsWith("-")) {
        section.removed += 1;
        appendPartialPatchDiffLine(section, "-", line.slice(1), section.oldLine, undefined);
        section.oldLine += 1;
        return;
    }

    if (line.startsWith(" ") || line.length === 0) {
        const content = line.startsWith(" ") ? line.slice(1) : "";
        appendPartialPatchDiffLine(section, " ", content, section.oldLine, section.newLine);
        section.oldLine += 1;
        section.newLine += 1;
    }
}

function finalizedPartialSection(section: PartialApplyPatchSection): ApplyPatchSection {
    return {
        kind: section.kind,
        path: displayPath(section),
        lines: section.lines.slice(-MAX_PARTIAL_PATCH_PREVIEW_LINES),
        lineCoordinates: section.lineCoordinates.slice(-MAX_PARTIAL_PATCH_PREVIEW_LINES),
        added: section.added,
        removed: section.removed,
        countsKnown: section.kind !== "delete",
    };
}

function latestPartialPatchReplayStart(patch: string): number {
    const minimumStart = Math.max(0, patch.length - MAX_PARTIAL_PATCH_REPLAY_CHARS);
    const replayWindow = patch.slice(minimumStart);
    const relativeStart = Math.max(
        replayWindow.lastIndexOf("*** Add File: "),
        replayWindow.lastIndexOf("*** Delete File: "),
        replayWindow.lastIndexOf("*** Update File: "),
    );
    return relativeStart < 0 ? minimumStart : minimumStart + relativeStart;
}

class PartialApplyPatchPreview {
    private scannedLength = 0;
    private suffix = "";
    private currentLine = "";
    private currentLineTruncated = false;
    private skipLineFeed = false;
    private section: PartialApplyPatchSection | undefined;
    private lastRenderableSection: PartialApplyPatchSection | undefined;

    update(patch: string): void {
        const appendLength = patch.length - this.scannedLength;
        let consumeStart = this.scannedLength;
        if (!this.canAppend(patch) || appendLength > MAX_PARTIAL_PATCH_REPLAY_CHARS) {
            this.reset();
            consumeStart = latestPartialPatchReplayStart(patch);
        }

        this.consume(patch, consumeStart);
        this.scannedLength = patch.length;
        this.suffix = patch.slice(Math.max(0, patch.length - PARTIAL_PATCH_SUFFIX_CHARS));
    }

    snapshot(): ApplyPatchSection | undefined {
        const currentLine = this.displayCurrentLine();
        if (partialPatchSectionHeader(currentLine) !== undefined) {
            return this.lastRenderableSnapshot();
        }

        if (this.section === undefined) {
            return this.lastRenderableSnapshot();
        }

        const section = copyPartialSection(this.section);
        if (section.kind === "update" && currentLine.startsWith("*** Move to: ")) {
            section.movePath = currentLine.slice("*** Move to: ".length);
        } else if (currentLine.length > 0) {
            applyPartialPatchBodyLine(section, currentLine);
        }
        if (section.lines.length === 0) {
            return this.lastRenderableSnapshot();
        }
        const stable = this.stableSnapshot();
        if (stable !== undefined && stable.path !== displayPath(section)) {
            return stable;
        }
        return finalizedPartialSection(section);
    }

    stableSnapshot(): ApplyPatchSection | undefined {
        return this.lastRenderableSection === undefined
            ? undefined
            : finalizedPartialSection(this.lastRenderableSection);
    }

    private lastRenderableSnapshot(): ApplyPatchSection | undefined {
        return this.stableSnapshot();
    }

    private canAppend(patch: string): boolean {
        if (patch.length < this.scannedLength) {
            return false;
        }
        if (this.suffix.length === 0) {
            return true;
        }
        const suffixStart = this.scannedLength - this.suffix.length;
        return suffixStart >= 0 && patch.slice(suffixStart, this.scannedLength) === this.suffix;
    }

    private reset(): void {
        this.scannedLength = 0;
        this.suffix = "";
        this.currentLine = "";
        this.currentLineTruncated = false;
        this.skipLineFeed = false;
        this.section = undefined;
        this.lastRenderableSection = undefined;
    }

    private consume(patch: string, start: number): void {
        for (let index = start; index < patch.length; index += 1) {
            const charCode = patch.charCodeAt(index);
            if (this.skipLineFeed) {
                this.skipLineFeed = false;
                if (charCode === 10) {
                    continue;
                }
            }

            if (charCode === 10 || charCode === 13) {
                this.commitLine(this.displayCurrentLine());
                this.currentLine = "";
                this.currentLineTruncated = false;
                this.skipLineFeed = charCode === 13;
                continue;
            }

            if (this.currentLine.length < MAX_PARTIAL_PATCH_LINE_CHARS) {
                this.currentLine += patch.charAt(index);
            } else {
                this.currentLineTruncated = true;
            }
        }
    }

    private displayCurrentLine(): string {
        if (!this.currentLineTruncated) {
            return takeGraphemePrefix(this.currentLine, this.currentLine.length);
        }
        return appendGraphemeEllipsis(this.currentLine, MAX_PARTIAL_PATCH_LINE_CHARS);
    }

    private commitLine(line: string): void {
        const header = partialPatchSectionHeader(line);
        if (header !== undefined) {
            if (this.section !== undefined && this.section.lines.length > 0) {
                this.lastRenderableSection = copyPartialSection(this.section);
            }
            this.section = makePartialSection(header.kind, header.path);
            return;
        }

        if (this.section === undefined) {
            return;
        }

        if (this.section.kind === "update" && line.startsWith("*** Move to: ")) {
            this.section.movePath = line.slice("*** Move to: ".length);
            return;
        }

        applyPartialPatchBodyLine(this.section, line);
        const stablePath =
            this.lastRenderableSection === undefined
                ? undefined
                : displayPath(this.lastRenderableSection);
        if (
            this.section.lines.length > 0 &&
            (stablePath === undefined || stablePath === displayPath(this.section))
        ) {
            this.lastRenderableSection = copyPartialSection(this.section);
        }
    }
}

type PartialApplyPatchPreviewUpdate = {
    readonly patch: string;
    readonly theme: GlowupRenderTheme;
    readonly expanded: boolean;
    readonly labelMode: ToolLabelMode;
    readonly toolCallId: string;
};

class PartialApplyPatchCallPreviewComponent implements Component {
    private readonly preview = new PartialApplyPatchPreview();
    private readonly toolCallId: string;
    private theme: GlowupRenderTheme;
    private expanded = false;
    private labelMode: ToolLabelMode = "static";
    private patch = "";
    private cachedWidth: number | undefined;
    private cachedLines: string[] | undefined;

    constructor(update: PartialApplyPatchPreviewUpdate) {
        this.toolCallId = update.toolCallId;
        this.theme = update.theme;
        this.update(update);
    }

    belongsTo(toolCallId: string): boolean {
        return this.toolCallId === toolCallId;
    }

    update(update: PartialApplyPatchPreviewUpdate): void {
        this.theme = update.theme;
        this.expanded = update.expanded;
        this.labelMode = update.labelMode;
        this.patch = update.patch;
        this.preview.update(update.patch);
        this.invalidate();
    }

    render(width: number): string[] {
        if (this.cachedWidth === width && this.cachedLines !== undefined) {
            return this.cachedLines;
        }

        const hydratedSection = this.hydrate(this.preview.snapshot());
        const section =
            hydratedSection?.kind === "update" && hasUnnumberedDiffRows(hydratedSection)
                ? this.coherentStableSection()
                : hydratedSection;
        const component =
            section === undefined
                ? renderGlowupCall(this.theme, {
                      state: "running",
                      statusText: toolStatusLabel(
                          this.labelMode,
                          { isPartial: true, argsComplete: false },
                          {
                              static: "Patch",
                              active: "Patching",
                              completed: "Patched",
                          },
                      ),
                  })
                : renderApplyPatchSummary(
                      { sections: [section] },
                      this.theme,
                      this.expanded,
                      { isPartial: true, argsComplete: false },
                      this.labelMode,
                  );
        const lines = component.render(width);
        this.cachedWidth = width;
        this.cachedLines = lines;
        return lines;
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }

    private hydrate(section: ApplyPatchSection | undefined): ApplyPatchSection | undefined {
        return section === undefined
            ? undefined
            : hydrateUpdateLineNumbers({ sections: [section] }, this.patch, this.toolCallId)
                  .sections[0];
    }

    private coherentStableSection(): ApplyPatchSection | undefined {
        const stable = this.hydrate(this.preview.stableSnapshot());
        return stable?.kind === "update" && hasUnnumberedDiffRows(stable) ? undefined : stable;
    }
}

function renderPartialPatchViewport(header: Component, body: Component): Component {
    return makeComponent((width) => {
        const headerLines = header.render(width);
        const firstHeaderLine = headerLines[0] ?? "";
        const boundedHeader =
            headerLines.length <= 1
                ? firstHeaderLine
                : truncateToWidth(`${firstHeaderLine}…`, width, "…");
        const bodyLines = body.render(width).slice(0, MAX_PARTIAL_PATCH_PREVIEW_LINES);
        return [boundedHeader, ...bodyLines];
    });
}

function firstBoundedComponentLine(component: Component, width: number): string {
    const lines = component.render(width);
    const firstLine = lines[0] ?? "";
    return lines.length <= 1 ? firstLine : truncateToWidth(`${firstLine}…`, width, "…");
}

type CompletedDiffContext = {
    readonly toolCallId?: string;
    readonly invalidate?: () => void;
    readonly pierreComponents?: Map<string, Component>;
};

function completedSectionDiff(
    section: ApplyPatchSection,
    theme: GlowupRenderTheme,
    expanded: boolean,
    mutationSettings: MutationSettings,
    context: CompletedDiffContext,
): Component | undefined {
    if (section.lines.length === 0) {
        return undefined;
    }
    if (section.pierreDiff !== undefined) {
        const componentKey =
            section.pierreDiff.kind === "renderable"
                ? section.pierreDiff.modelKey
                : `summary:${section.path ?? section.pierreDiff.path}`;
        const component = renderPierreDiff(
            section.pierreDiff,
            theme,
            {
                expanded,
                expandedRows: "full",
                mutationSettings,
            },
            {
                lastComponent: context.pierreComponents?.get(componentKey),
                ...(context.toolCallId === undefined ? {} : { toolCallId: context.toolCallId }),
                ...(context.invalidate === undefined ? {} : { invalidate: context.invalidate }),
            },
        );
        context.pierreComponents?.set(componentKey, component);
        return component;
    }
    const showAllRows = showsFullMutation(mutationSettings, expanded);
    return renderGlowupDiff(theme, [section], showAllRows, {
        collapsedLineBudget: mutationSettings.previewLines,
        ...(showAllRows ? {} : { maxWrappedRows: 1 }),
    });
}

type PatchCallLifecycleContext = ToolLifecycleContext & {
    readonly isError?: boolean;
};

function patchCallLabel(labelMode: ToolLabelMode, context: PatchCallLifecycleContext): string {
    if (context.isError === true) {
        return "Patch";
    }
    return toolStatusLabel(labelMode, context, {
        static: "Patch",
        active: "Patching",
        completed: "Patched",
    });
}

function renderCompletedPatchViewport(
    summary: ApplyPatchSummary,
    theme: GlowupRenderTheme,
    context: PatchCallLifecycleContext,
    labelMode: ToolLabelMode,
    mutationSettings: MutationSettings,
    diffContext: CompletedDiffContext,
): Component {
    const firstSection = summary.sections[0];
    if (firstSection === undefined) {
        return renderGlowupBody("");
    }

    return renderStandalonePatchSections(
        summary.sections,
        theme,
        false,
        context,
        labelMode,
        mutationSettings,
        diffContext,
    );
}

function deleteStats(theme: GlowupRenderTheme, section: ApplyPatchSection): string {
    return section.countsKnown && section.removed > 0
        ? ` (${theme.fg("toolDiffRemoved", `-${section.removed}`)})`
        : "";
}

function completedPatchSection(
    section: ApplyPatchSection,
    theme: GlowupRenderTheme,
    expanded: boolean,
    context: PatchCallLifecycleContext,
    labelMode: ToolLabelMode,
    mutationSettings: MutationSettings,
    diffContext: CompletedDiffContext,
): Component {
    const label = patchCallLabel(labelMode, context);
    const diff = completedSectionDiff(section, theme, expanded, mutationSettings, diffContext);
    const header =
        section.kind === "delete" && !section.countsKnown
            ? renderGlowupCall(theme, {
                  state: context.isError === true ? "muted" : "success",
                  statusText: label,
                  body: `${formatPathTarget(theme, section.path ?? "file")}${deleteStats(theme, section)}`,
              })
            : renderMutationCall(
                  theme,
                  {
                      label,
                      path: section.path ?? "file",
                      added: section.added,
                      removed: section.removed,
                  },
                  { state: context.isError === true ? "muted" : "success" },
              );
    if (diff === undefined) {
        return header;
    }
    return makeComponent((width) => [
        firstBoundedComponentLine(header, width),
        ...diff.render(width),
    ]);
}

function renderStandalonePatchSections(
    sections: readonly ApplyPatchSection[],
    theme: GlowupRenderTheme,
    expanded: boolean,
    context: PatchCallLifecycleContext,
    labelMode: ToolLabelMode,
    mutationSettings: MutationSettings,
    diffContext: CompletedDiffContext,
): Component {
    const components = sections.map((section) =>
        completedPatchSection(
            section,
            theme,
            expanded,
            context,
            labelMode,
            mutationSettings,
            diffContext,
        ),
    );
    return makeComponent((width) =>
        components.flatMap((component, index) => [
            ...(index === 0 ? [] : [""]),
            ...component.render(width),
        ]),
    );
}

function renderSinglePatchSection(
    section: ApplyPatchSection,
    theme: GlowupRenderTheme,
    expanded: boolean,
    context: PatchCallLifecycleContext,
    labelMode: ToolLabelMode,
    mutationSettings: MutationSettings,
    diffContext: { readonly toolCallId?: string; readonly invalidate?: () => void },
): Component {
    const label = patchCallLabel(labelMode, context);
    if (isActiveToolCall(context)) {
        const header =
            section.kind === "delete"
                ? renderGlowupCall(theme, {
                      state: "running",
                      statusText: label,
                      body: formatPathTarget(theme, section.path ?? "file"),
                  })
                : renderMutationCall(
                      theme,
                      {
                          label,
                          path: section.path ?? "file",
                          added: 0,
                          removed: 0,
                      },
                      { state: "running" },
                  );
        const body =
            section.lines.length === 0
                ? renderGlowupBody(theme.fg("dim", "    …"))
                : renderGlowupDiff(theme, [section], false, {
                      collapsedLineBudget: MAX_PARTIAL_PATCH_PREVIEW_LINES,
                      maxWrappedRows: 1,
                  });
        return renderPartialPatchViewport(header, body);
    }
    return completedPatchSection(
        section,
        theme,
        expanded,
        context,
        labelMode,
        mutationSettings,
        diffContext,
    );
}

function renderApplyPatchSummary(
    summary: ApplyPatchSummary,
    theme: GlowupRenderTheme,
    expanded: boolean,
    context: PatchCallLifecycleContext,
    labelMode: ToolLabelMode,
    mutationSettings: MutationSettings = PREVIEW_MUTATION_SETTINGS,
    diffContext: CompletedDiffContext = {},
): Component {
    if (!expanded && !isActiveToolCall(context)) {
        return renderCompletedPatchViewport(
            summary,
            theme,
            context,
            labelMode,
            mutationSettings,
            diffContext,
        );
    }

    if (summary.sections.length === 1) {
        const section = summary.sections[0];
        return section === undefined
            ? renderGlowupBody("")
            : renderSinglePatchSection(
                  section,
                  theme,
                  expanded,
                  context,
                  labelMode,
                  mutationSettings,
                  diffContext,
              );
    }

    return renderStandalonePatchSections(
        summary.sections,
        theme,
        expanded,
        context,
        labelMode,
        mutationSettings,
        diffContext,
    );
}

type CompletedApplyPatchUpdate = {
    readonly summary: ApplyPatchSummary;
    readonly changedOnly: boolean;
    readonly theme: GlowupRenderTheme;
    readonly expanded: boolean;
    readonly context: PatchCallLifecycleContext;
    readonly labelMode: ToolLabelMode;
    readonly mutationSettings: MutationSettings;
    readonly invalidate: (() => void) | undefined;
};

class CompletedApplyPatchCallComponent implements Component {
    private readonly pierreComponents = new Map<string, Component>();
    private summary: ApplyPatchSummary;
    private changedOnly: boolean;
    private theme: GlowupRenderTheme;
    private expanded: boolean;
    private lifecycleKey: number;
    private labelMode: ToolLabelMode;
    private mutationSettings: MutationSettings;
    private requestRender: (() => void) | undefined;
    private renderGeneration = 0;
    private rendered: Component;
    private cachedWidth: number | undefined;
    private cachedLines: string[] | undefined;

    constructor(
        private readonly toolCallId: string,
        update: CompletedApplyPatchUpdate,
    ) {
        this.summary = update.summary;
        this.changedOnly = update.changedOnly;
        this.theme = update.theme;
        this.expanded = update.expanded;
        this.lifecycleKey = patchLifecycleRenderKey(update.context);
        this.labelMode = update.labelMode;
        this.mutationSettings = update.mutationSettings;
        this.requestRender = update.invalidate;
        this.rendered = this.buildRenderedComponent(update.context);
    }

    belongsTo(toolCallId: string): boolean {
        return this.toolCallId === toolCallId;
    }

    update(update: CompletedApplyPatchUpdate): void {
        const nextLifecycleKey = patchLifecycleRenderKey(update.context);
        const canReuseRenderedComponent =
            this.summary === update.summary &&
            this.changedOnly === update.changedOnly &&
            this.theme === update.theme &&
            this.expanded === update.expanded &&
            this.lifecycleKey === nextLifecycleKey &&
            this.labelMode === update.labelMode &&
            this.mutationSettings === update.mutationSettings;

        this.requestRender = update.invalidate;
        if (canReuseRenderedComponent) {
            return;
        }

        this.summary = update.summary;
        this.changedOnly = update.changedOnly;
        this.theme = update.theme;
        this.expanded = update.expanded;
        this.lifecycleKey = nextLifecycleKey;
        this.labelMode = update.labelMode;
        this.mutationSettings = update.mutationSettings;
        this.rendered = this.buildRenderedComponent(update.context);
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }

    render(width: number): string[] {
        if (this.cachedWidth === width && this.cachedLines !== undefined) {
            return this.cachedLines;
        }
        this.cachedWidth = width;
        this.cachedLines = this.rendered.render(width);
        return this.cachedLines;
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
        this.rendered.invalidate();
    }

    private buildRenderedComponent(context: PatchCallLifecycleContext): Component {
        this.renderGeneration += 1;
        const renderGeneration = this.renderGeneration;
        const summary = this.changedOnly
            ? changedOnlyApplyPatchSummary(this.summary)
            : this.summary;
        return renderApplyPatchSummary(
            summary,
            this.theme,
            this.expanded,
            context,
            this.labelMode,
            this.mutationSettings,
            {
                toolCallId: this.toolCallId,
                pierreComponents: this.pierreComponents,
                invalidate: () => {
                    if (this.renderGeneration === renderGeneration) {
                        this.requestRender?.();
                    }
                },
            },
        );
    }
}

function patchLifecycleRenderKey(context: PatchCallLifecycleContext): number {
    return (
        (context.isPartial ? 1 : 0) |
        (context.argsComplete === false ? 2 : 0) |
        (context.executionStarted === true ? 4 : 0) |
        (context.result === undefined ? 0 : 8) |
        (context.isError === true ? 16 : 0)
    );
}

function renderCompletedApplyPatchCall(
    summary: ApplyPatchSummary,
    changedOnly: boolean,
    theme: GlowupRenderTheme,
    context: ThirdPartyToolRenderContext,
    summaryContext: PatchCallLifecycleContext,
    labelMode: ToolLabelMode,
    mutationSettings: MutationSettings,
): Component {
    const update: CompletedApplyPatchUpdate = {
        summary,
        changedOnly,
        theme,
        expanded: context.expanded,
        context: summaryContext,
        labelMode,
        mutationSettings,
        invalidate: context.invalidate,
    };
    if (
        context.lastComponent instanceof CompletedApplyPatchCallComponent &&
        context.lastComponent.belongsTo(context.toolCallId)
    ) {
        context.lastComponent.update(update);
        return context.lastComponent;
    }
    return new CompletedApplyPatchCallComponent(context.toolCallId, update);
}

function renderApplyPatchFallbackCall(
    args: unknown,
    theme: GlowupRenderTheme,
    context: ThirdPartyToolRenderContext,
    labelMode: ToolLabelMode,
): Component {
    const patch = patchTextFromArgs(args);
    const active = context.isPartial || !context.argsComplete;
    const lines = patch === undefined || active ? 0 : lineCount(patch);
    const state = isActiveToolCall(context) ? "running" : "muted";
    const statusText = patchCallLabel(labelMode, context);
    if (active) {
        return renderGlowupCall(theme, { state, statusText });
    }
    return renderGlowupCall(theme, {
        state,
        statusText,
        body: lines > 0 ? `${lines} patch lines` : "patch",
    });
}

function renderPartialApplyPatchCall(
    patch: string,
    theme: GlowupRenderTheme,
    context: ThirdPartyToolRenderContext,
    labelMode: ToolLabelMode,
): Component {
    const update = {
        patch,
        theme,
        expanded: context.expanded,
        labelMode,
        toolCallId: context.toolCallId,
    };
    if (
        context.lastComponent instanceof PartialApplyPatchCallPreviewComponent &&
        context.lastComponent.belongsTo(context.toolCallId)
    ) {
        context.lastComponent.update(update);
        return context.lastComponent;
    }
    return new PartialApplyPatchCallPreviewComponent(update);
}

function textOutput(result: ThirdPartyToolResult): string | undefined {
    const content = result.content;
    if (!Array.isArray(content)) {
        return undefined;
    }
    const text = content.find(
        (item) => isRecord(item) && item.type === "text" && typeof item.text === "string",
    );
    return isRecord(text) && typeof text.text === "string" ? text.text : undefined;
}

function renderApplyPatchFailure(
    result: ThirdPartyToolResult,
    options: { readonly expanded: boolean },
    theme: GlowupRenderTheme,
    labelMode: ToolLabelMode,
): Component {
    return makeComponent((width) => [
        ...renderGlowupCall(theme, {
            state: "error",
            statusText: labelMode === "lifecycle" ? "Failed to patch" : "Patch",
        }).render(width),
        ...renderGlowupOutput(theme, textOutput(result), {
            expanded: options.expanded,
            mode: "head",
            maxPreviewLines: 5,
            prefixFirst: theme.fg("dim", "  │ "),
            prefixRest: theme.fg("dim", "  │ "),
            noOutputLabel: null,
        }).render(width),
    ]);
}

export function createApplyPatchRenderer(
    _toolName?: string,
    labelMode: ToolLabelMode = "static",
    mutationSettings: MutationSettings = PREVIEW_MUTATION_SETTINGS,
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const patch = patchTextFromArgs(args);
            if (patch !== undefined) {
                scheduleApplyPatchSyntaxLoads(patch, context.invalidate);
            }
            const persistedSummary = persistedSummaryForRender(
                context.toolCallId,
                context.result,
                patch,
                mutationSettings,
            );
            if (
                patch !== undefined &&
                persistedSummary === undefined &&
                isActiveToolCall(context)
            ) {
                return renderPartialApplyPatchCall(patch, theme, context, labelMode);
            }
            const parsedSummary =
                persistedSummary !== undefined || patch === undefined
                    ? undefined
                    : parseCompletedPatchCall(patch);
            const summary =
                persistedSummary ??
                (parsedSummary === undefined
                    ? undefined
                    : applyMutationLimits(
                          hydrateUpdateLineNumbers(
                              hydrateDeletePreimages(parsedSummary, context.toolCallId),
                              patch ?? "",
                              context.toolCallId,
                          ),
                          mutationSettings,
                      ));
            const summaryContext =
                persistedSummary === undefined
                    ? context
                    : { ...context, argsComplete: true, isPartial: false };
            const changedOnly =
                !context.expanded &&
                mutationSettings.defaultView !== "full" &&
                persistedSummary !== undefined;
            return summary === undefined
                ? renderApplyPatchFallbackCall(args, theme, context, labelMode)
                : renderCompletedApplyPatchCall(
                      summary,
                      changedOnly,
                      theme,
                      context,
                      summaryContext,
                      labelMode,
                      mutationSettings,
                  );
        },
        renderResult(result, options, theme, context) {
            const previousSummary = persistedSummaries.get(context.toolCallId);
            const persistedSummary = persistedSummaryForRender(
                context.toolCallId,
                result,
                patchTextFromArgs(context.args),
                mutationSettings,
            );
            if (persistedSummary !== undefined && persistedSummary !== previousSummary) {
                queueMicrotask(() => context.invalidate?.());
            }
            if (context.isError) {
                return renderApplyPatchFailure(result, options, theme, labelMode);
            }
            const patch = patchTextFromArgs(context.args);
            if (patch !== undefined && parseCompletedPatchCall(patch) !== undefined) {
                return emptyComponent();
            }
            return renderGlowupOutput(theme, textOutput(result), {
                expanded: options.expanded,
                mode: "head",
                maxPreviewLines: 5,
            });
        },
    };
}
