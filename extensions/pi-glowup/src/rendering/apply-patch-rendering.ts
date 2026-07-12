import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
    emptyComponent,
    formatPathTarget,
    makeComponent,
    renderCodexBody,
    renderCodexCall,
    renderCodexDiff,
    renderCodexOutput,
    renderMutationCall,
    MUTATION_DIFF_PREVIEW_ROWS,
    type CodexRenderTheme,
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

type ApplyPatchKind = "add" | "delete" | "update";

type ApplyPatchSection = DiffSection & {
    readonly kind: ApplyPatchKind;
    readonly countsKnown: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const field = value[key];
    return typeof field === "string" ? field : undefined;
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
    for (const line of patch.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n")) {
        if (line.startsWith("*** Delete File: ")) {
            const filePath = line.slice("*** Delete File: ".length);
            if (filePath.length > 0) deletePaths.add(filePath);
        }
        if (line.startsWith("*** Update File: ")) {
            const filePath = line.slice("*** Update File: ".length);
            if (filePath.length > 0) updatePaths.add(filePath);
        }
    }

    const tasks: Array<() => Promise<void>> = [];
    for (const filePath of deletePaths) {
        if (deletePreviews.has(filePath)) continue;
        tasks.push(async () => {
            const preview = await captureDeletedTextPreview(cwd, filePath);
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

function schedulePartialUpdatePreimages(
    toolCallId: string,
    cwd: string | undefined,
    patch: string,
    invalidate: (() => void) | undefined,
): void {
    if (cwd === undefined || invalidate === undefined) return;
    const previews = boundedPreimageMap(updatePreimages, toolCallId);
    const unavailable = boundedPreimageMap(unavailableUpdatePreimages, toolCallId);
    const pending = boundedPreimageMap(pendingUpdatePreimages, toolCallId);
    const normalized = patch.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
    const completeLines = normalized.split("\n");
    if (!normalized.endsWith("\n")) completeLines.pop();
    for (const line of completeLines) {
        if (!line.startsWith("*** Update File: ")) continue;
        const filePath = line.slice("*** Update File: ".length);
        if (filePath.length === 0 || previews.has(filePath) || unavailable.has(filePath)) {
            continue;
        }
        const pendingRequest = pending.get(filePath);
        if (pendingRequest !== undefined) {
            void pendingRequest.finally(invalidate);
            continue;
        }
        const request = captureTextFilePreimage(cwd, filePath, MAX_UPDATE_PREIMAGE_BYTES, {
            allowOutsideCwd: true,
        })
            .then((preimage) => {
                if (preimage === undefined) unavailable.set(filePath, true);
                else previews.set(filePath, preimage);
                invalidate();
            })
            .finally(() => {
                pending.delete(filePath);
            });
        pending.set(filePath, request);
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

function makeSection(kind: ApplyPatchKind, path: string): MutableApplyPatchSection {
    return {
        kind,
        path,
        movePath: undefined,
        lines: [],
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
                current.lines.push(numberedDiffLine("+", current.added, line.slice(1), true));
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
            current.lines.push(
                numberedDiffLine("+", current.newLine, line.slice(1), current.lineNumbersKnown),
            );
            current.newLine += 1;
            continue;
        }

        if (line.startsWith("-")) {
            current.removed += 1;
            current.lines.push(
                numberedDiffLine("-", current.oldLine, line.slice(1), current.lineNumbersKnown),
            );
            current.oldLine += 1;
            continue;
        }

        if (line.startsWith(" ")) {
            current.lines.push(
                numberedDiffLine(" ", current.newLine, line.slice(1), current.lineNumbersKnown),
            );
            current.oldLine += 1;
            current.newLine += 1;
            continue;
        }

        if (line.length === 0) {
            current.lines.push(
                numberedDiffLine(" ", current.newLine, "", current.lineNumbersKnown),
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
        return Math.min(fromIndex, source.length);
    }
    for (const searchStart of [fromIndex, 0]) {
        for (let index = searchStart; index + needle.length <= source.length; index += 1) {
            if (needle.every((line, offset) => source[index + offset] === line)) {
                return index;
            }
        }
    }
    return undefined;
}

function numberedUpdateHunks(
    hunks: readonly UpdateHunk[],
    preimage: TextFilePreimage | undefined,
): readonly string[] | undefined {
    const lines: string[] = [];
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
            if (row.sign !== "+") oldLine += 1;
            if (row.sign !== "-") newLine += 1;
        }
        oldCursor = oldLine - 1;
        lineDelta = newLine - oldLine;
    }
    return lines;
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
            const lines = numberedUpdateHunks(update.hunks, preimages?.get(update.path));
            return lines === undefined ? section : { ...section, lines };
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

function appendPartialPatchDiffLine(section: PartialApplyPatchSection, line: string): void {
    section.diffLineCount += 1;
    section.lines.push(line);
    if (section.lines.length > MAX_PARTIAL_PATCH_PREVIEW_LINES) {
        section.lines.shift();
    }
}

function applyPartialPatchBodyLine(section: PartialApplyPatchSection, line: string): void {
    if (line === "*** End Patch" || line === "*** End of File") {
        return;
    }

    if (section.kind === "add") {
        if (line.startsWith("+")) {
            section.added += 1;
            appendPartialPatchDiffLine(
                section,
                numberedDiffLine("+", section.added, line.slice(1), true),
            );
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
        appendPartialPatchDiffLine(
            section,
            numberedDiffLine("+", section.newLine, line.slice(1), section.lineNumbersKnown),
        );
        section.newLine += 1;
        return;
    }

    if (line.startsWith("-")) {
        section.removed += 1;
        appendPartialPatchDiffLine(
            section,
            numberedDiffLine("-", section.oldLine, line.slice(1), section.lineNumbersKnown),
        );
        section.oldLine += 1;
        return;
    }

    if (line.startsWith(" ") || line.length === 0) {
        const content = line.startsWith(" ") ? line.slice(1) : "";
        appendPartialPatchDiffLine(
            section,
            numberedDiffLine(" ", section.newLine, content, section.lineNumbersKnown),
        );
        section.oldLine += 1;
        section.newLine += 1;
    }
}

function finalizedPartialSection(section: PartialApplyPatchSection): ApplyPatchSection {
    return {
        kind: section.kind,
        path: displayPath(section),
        lines: section.lines.slice(-MAX_PARTIAL_PATCH_PREVIEW_LINES),
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
            return this.currentLine;
        }
        return `${this.currentLine.slice(0, MAX_PARTIAL_PATCH_LINE_CHARS - 1)}…`;
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
    readonly theme: CodexRenderTheme;
    readonly expanded: boolean;
    readonly labelMode: ToolLabelMode;
    readonly toolCallId: string;
};

class PartialApplyPatchCallPreviewComponent implements Component {
    private readonly preview = new PartialApplyPatchPreview();
    private readonly toolCallId: string;
    private theme: CodexRenderTheme;
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
                ? renderCodexCall(this.theme, {
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

function completedDiffLineBudget(lineCount: number, maxRenderedRows: number): number {
    return Math.min(Math.max(1, lineCount), maxRenderedRows);
}

function completedSectionDiff(
    section: ApplyPatchSection,
    theme: CodexRenderTheme,
): Component | undefined {
    if (section.lines.length === 0) {
        return undefined;
    }
    return renderCodexDiff(theme, [section], false, {
        collapsedLineBudget: completedDiffLineBudget(
            section.lines.length,
            MAX_PARTIAL_PATCH_PREVIEW_LINES,
        ),
        maxWrappedRows: 1,
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
    theme: CodexRenderTheme,
    context: PatchCallLifecycleContext,
    labelMode: ToolLabelMode,
): Component {
    const firstSection = summary.sections[0];
    if (firstSection === undefined) {
        return renderCodexBody(theme, "");
    }

    return renderStandalonePatchSections(summary.sections, theme, false, context, labelMode);
}

function deleteStats(theme: CodexRenderTheme, section: ApplyPatchSection): string {
    return section.countsKnown && section.removed > 0
        ? ` (${theme.fg("toolDiffRemoved", `-${section.removed}`)})`
        : "";
}

function completedPatchSection(
    section: ApplyPatchSection,
    theme: CodexRenderTheme,
    expanded: boolean,
    context: PatchCallLifecycleContext,
    labelMode: ToolLabelMode,
): Component {
    const label = patchCallLabel(labelMode, context);
    const diff = expanded
        ? section.lines.length === 0
            ? undefined
            : renderCodexDiff(theme, [section], true)
        : completedSectionDiff(section, theme);
    const header =
        section.kind === "delete" && !section.countsKnown
            ? renderCodexCall(theme, {
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
    theme: CodexRenderTheme,
    expanded: boolean,
    context: PatchCallLifecycleContext,
    labelMode: ToolLabelMode,
): Component {
    const components = sections.map((section) =>
        completedPatchSection(section, theme, expanded, context, labelMode),
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
    theme: CodexRenderTheme,
    expanded: boolean,
    context: PatchCallLifecycleContext,
    labelMode: ToolLabelMode,
): Component {
    const label = patchCallLabel(labelMode, context);
    if (isActiveToolCall(context)) {
        const header =
            section.kind === "delete"
                ? renderCodexCall(theme, {
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
                ? renderCodexBody(theme, theme.fg("dim", "    …"))
                : renderCodexDiff(theme, [section], false, {
                      collapsedLineBudget: MAX_PARTIAL_PATCH_PREVIEW_LINES,
                      maxWrappedRows: 1,
                  });
        return renderPartialPatchViewport(header, body);
    }
    if (section.kind === "delete") {
        const header = renderCodexCall(theme, {
            state: "muted",
            statusText: label,
            body: formatPathTarget(theme, section.path ?? "file"),
        });
        return header;
    }
    const body = renderCodexDiff(theme, [section], expanded);
    return renderMutationCall(
        theme,
        {
            label,
            path: section.path ?? "file",
            added: section.added,
            removed: section.removed,
        },
        { body, state: context.isError === true ? "muted" : "success" },
    );
}

function renderApplyPatchSummary(
    summary: ApplyPatchSummary,
    theme: CodexRenderTheme,
    expanded: boolean,
    context: PatchCallLifecycleContext,
    labelMode: ToolLabelMode,
): Component {
    if (!expanded && !isActiveToolCall(context)) {
        return renderCompletedPatchViewport(summary, theme, context, labelMode);
    }

    if (summary.sections.length === 1) {
        const section = summary.sections[0];
        return section === undefined
            ? renderCodexBody(theme, "")
            : renderSinglePatchSection(section, theme, expanded, context, labelMode);
    }

    return renderStandalonePatchSections(summary.sections, theme, expanded, context, labelMode);
}

function renderApplyPatchFallbackCall(
    args: unknown,
    theme: CodexRenderTheme,
    context: ThirdPartyToolRenderContext,
    labelMode: ToolLabelMode,
): Component {
    const patch = patchTextFromArgs(args);
    const active = context.isPartial || !context.argsComplete;
    const lines = patch === undefined || active ? 0 : lineCount(patch);
    const state = isActiveToolCall(context) ? "running" : "muted";
    const statusText = patchCallLabel(labelMode, context);
    if (active) {
        return renderCodexCall(theme, { state, statusText });
    }
    return renderCodexCall(theme, {
        state,
        statusText,
        body: lines > 0 ? `${lines} patch lines` : "patch",
    });
}

function renderPartialApplyPatchCall(
    patch: string,
    theme: CodexRenderTheme,
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
    theme: CodexRenderTheme,
    labelMode: ToolLabelMode,
): Component {
    return makeComponent((width) => [
        ...renderCodexCall(theme, {
            state: "error",
            statusText: labelMode === "lifecycle" ? "Failed to patch" : "Patch",
        }).render(width),
        ...renderCodexOutput(theme, textOutput(result), {
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
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const patch = patchTextFromArgs(args);
            if (patch !== undefined) {
                schedulePartialUpdatePreimages(
                    context.toolCallId,
                    context.cwd,
                    patch,
                    context.invalidate,
                );
            }
            if (patch !== undefined && isActiveToolCall(context)) {
                return renderPartialApplyPatchCall(patch, theme, context, labelMode);
            }
            const parsedSummary =
                patch === undefined || !canParseCompletedPatchCall(patch)
                    ? undefined
                    : parseApplyPatchSummary(patch);
            const summary =
                parsedSummary === undefined
                    ? undefined
                    : hydrateUpdateLineNumbers(
                          hydrateDeletePreimages(parsedSummary, context.toolCallId),
                          patch ?? "",
                          context.toolCallId,
                      );
            return summary === undefined
                ? renderApplyPatchFallbackCall(args, theme, context, labelMode)
                : renderApplyPatchSummary(summary, theme, context.expanded, context, labelMode);
        },
        renderResult(result, options, theme, context) {
            if (context.isError) {
                return renderApplyPatchFailure(result, options, theme, labelMode);
            }
            const patch = patchTextFromArgs(context.args);
            if (
                patch !== undefined &&
                canParseCompletedPatchCall(patch) &&
                parseApplyPatchSummary(patch) !== undefined
            ) {
                return emptyComponent();
            }
            return renderCodexOutput(theme, textOutput(result), {
                expanded: options.expanded,
                mode: "head",
                maxPreviewLines: 5,
            });
        },
    };
}
