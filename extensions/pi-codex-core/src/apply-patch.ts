import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const ENVIRONMENT_ID_MARKER = "*** Environment ID:";

type ApplyPatchErrorKind = "invalidPatch" | "invalidHunk" | "compute" | "io";

/** Expected apply_patch parse or application failure. */
export class ApplyPatchError extends Error {
    readonly kind: ApplyPatchErrorKind;
    readonly lineNumber: number | undefined;

    constructor(kind: ApplyPatchErrorKind, message: string, lineNumber?: number) {
        super(message);
        this.name = "ApplyPatchError";
        this.kind = kind;
        this.lineNumber = lineNumber;
    }
}

export type AddFileHunk = {
    readonly type: "add";
    readonly path: string;
    readonly contents: string;
};

export type DeleteFileHunk = {
    readonly type: "delete";
    readonly path: string;
};

export type UpdateFileChunk = {
    readonly changeContext: string | undefined;
    readonly oldLines: readonly string[];
    readonly newLines: readonly string[];
    readonly isEndOfFile: boolean;
};

export type UpdateFileHunk = {
    readonly type: "update";
    readonly path: string;
    readonly movePath: string | undefined;
    readonly chunks: readonly UpdateFileChunk[];
};

export type ApplyPatchHunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

export type ApplyPatchArgs = {
    readonly patch: string;
    readonly hunks: readonly ApplyPatchHunk[];
    readonly workdir: string | undefined;
    readonly environmentId: string | undefined;
};

export type ApplyPatchAffectedPaths = {
    readonly added: readonly string[];
    readonly modified: readonly string[];
    readonly deleted: readonly string[];
};

export type AppliedPatchFileChange =
    | {
          readonly type: "add";
          readonly path: string;
          readonly content: string;
          readonly overwrittenContent: string | undefined;
      }
    | { readonly type: "delete"; readonly path: string; readonly content: string }
    | {
          readonly type: "update";
          readonly path: string;
          readonly movePath: string | undefined;
          readonly oldContent: string;
          readonly newContent: string;
          readonly overwrittenMoveContent: string | undefined;
      };

export type ApplyPatchResult = {
    readonly summary: string;
    readonly affectedPaths: ApplyPatchAffectedPaths;
    readonly changes: readonly AppliedPatchFileChange[];
};

type StreamingParserMode =
    | { readonly type: "notStarted" }
    | { readonly type: "startedPatch" }
    | { readonly type: "addFile" }
    | { readonly type: "deleteFile" }
    | { readonly type: "updateFile"; readonly hunkLineNumber: number }
    | { readonly type: "endedPatch" };

type MutableAddFileHunk = {
    type: "add";
    path: string;
    contents: string;
};

type MutableDeleteFileHunk = {
    type: "delete";
    path: string;
};

type MutableUpdateFileChunk = {
    changeContext: string | undefined;
    oldLines: string[];
    newLines: string[];
    isEndOfFile: boolean;
};

type MutableUpdateFileHunk = {
    type: "update";
    path: string;
    movePath: string | undefined;
    chunks: MutableUpdateFileChunk[];
};

type MutableApplyPatchHunk = MutableAddFileHunk | MutableDeleteFileHunk | MutableUpdateFileHunk;

type Replacement = {
    readonly startIndex: number;
    readonly oldLength: number;
    readonly newLines: readonly string[];
};

type ApplyPatchOptions = {
    readonly signal?: AbortSignal | undefined;
};

/** Incremental parser for Codex's apply_patch patch language. */
export class StreamingPatchParser {
    private lineBuffer = "";
    private mode: StreamingParserMode = { type: "notStarted" };
    private lineNumber = 0;
    private hunks: MutableApplyPatchHunk[] = [];
    private parsedEnvironmentId: string | undefined;

    environmentId(): string | undefined {
        return this.parsedEnvironmentId;
    }

    pushDelta(delta: string): ApplyPatchHunk[] {
        for (const char of delta) {
            if (char === "\n") {
                const line = trimOneTrailingCarriageReturn(this.lineBuffer);
                this.lineBuffer = "";
                this.lineNumber += 1;
                this.processLine(line);
            } else {
                this.lineBuffer += char;
            }
        }
        return cloneHunks(this.hunks);
    }

    finish(): ApplyPatchHunk[] {
        if (this.lineBuffer.length > 0) {
            const line = this.lineBuffer;
            this.lineBuffer = "";
            this.lineNumber += 1;
            if (line.trim() === END_PATCH_MARKER) {
                this.ensureUpdateHunkIsNotEmpty(line.trim());
                this.mode = { type: "endedPatch" };
            } else {
                this.processLine(line);
            }
        }

        if (this.mode.type !== "endedPatch") {
            throw invalidPatch("The last line of the patch must be '*** End Patch'");
        }

        return cloneHunks(this.hunks);
    }

    private ensureUpdateHunkIsNotEmpty(line: string): void {
        const hunk = lastItem(this.hunks);
        if (hunk?.type !== "update") return;

        if (hunk.chunks.length === 0 && this.mode.type === "updateFile") {
            throw invalidHunk(
                `Update file hunk for path '${hunk.path}' is empty`,
                this.mode.hunkLineNumber,
            );
        }

        const chunk = lastItem(hunk.chunks);
        if (chunk && chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
            if (line === END_PATCH_MARKER) {
                throw invalidHunk("Update hunk does not contain any lines", this.lineNumber);
            }
            throw invalidHunk(unexpectedUpdateLineMessage(line), this.lineNumber);
        }
    }

    private handleHunkHeadersAndEndPatch(trimmed: string): boolean {
        if (this.mode.type === "startedPatch") {
            const environmentId = stripPrefix(trimmed, ENVIRONMENT_ID_MARKER);
            if (environmentId !== undefined) {
                if (this.parsedEnvironmentId !== undefined) {
                    throw invalidPatch(
                        "apply_patch environment_id cannot be specified more than once",
                    );
                }
                const id = environmentId.trim();
                if (id.length === 0) {
                    throw invalidPatch("apply_patch environment_id cannot be empty");
                }
                this.parsedEnvironmentId = id;
                return true;
            }
        }

        if (trimmed === END_PATCH_MARKER) {
            this.ensureUpdateHunkIsNotEmpty(trimmed);
            this.mode = { type: "endedPatch" };
            return true;
        }

        const addPath = stripPrefix(trimmed, ADD_FILE_MARKER);
        if (addPath !== undefined) {
            this.ensureUpdateHunkIsNotEmpty(trimmed);
            this.hunks.push({ type: "add", path: addPath, contents: "" });
            this.mode = { type: "addFile" };
            return true;
        }

        const deletePath = stripPrefix(trimmed, DELETE_FILE_MARKER);
        if (deletePath !== undefined) {
            this.ensureUpdateHunkIsNotEmpty(trimmed);
            this.hunks.push({ type: "delete", path: deletePath });
            this.mode = { type: "deleteFile" };
            return true;
        }

        const updatePath = stripPrefix(trimmed, UPDATE_FILE_MARKER);
        if (updatePath !== undefined) {
            this.ensureUpdateHunkIsNotEmpty(trimmed);
            this.hunks.push({
                type: "update",
                path: updatePath,
                movePath: undefined,
                chunks: [],
            });
            this.mode = { type: "updateFile", hunkLineNumber: this.lineNumber };
            return true;
        }

        return false;
    }

    private processLine(line: string): void {
        const trimmed = line.trim();
        switch (this.mode.type) {
            case "notStarted": {
                if (trimmed === BEGIN_PATCH_MARKER) {
                    this.mode = { type: "startedPatch" };
                    return;
                }
                throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
            }
            case "startedPatch": {
                if (this.handleHunkHeadersAndEndPatch(trimmed)) return;
                throw invalidHunk(invalidHunkHeaderMessage(trimmed), this.lineNumber);
            }
            case "addFile": {
                if (this.handleHunkHeadersAndEndPatch(trimmed)) return;
                const lineToAdd = stripPrefix(line, "+");
                const hunk = lastItem(this.hunks);
                if (lineToAdd !== undefined && hunk?.type === "add") {
                    hunk.contents += `${lineToAdd}\n`;
                    return;
                }
                throw invalidHunk(invalidHunkHeaderMessage(trimmed), this.lineNumber);
            }
            case "deleteFile": {
                if (this.handleHunkHeadersAndEndPatch(trimmed)) return;
                throw invalidHunk(invalidHunkHeaderMessage(trimmed), this.lineNumber);
            }
            case "updateFile": {
                this.processUpdateLine(line, this.mode.hunkLineNumber);
                return;
            }
            case "endedPatch": {
                if (trimmed.length === 0) return;
                throw invalidPatch("The last line of the patch must be '*** End Patch'");
            }
        }
    }

    private processUpdateLine(line: string, hunkLineNumber: number): void {
        const updateLine = line.trimEnd();
        if (this.handleHunkHeadersAndEndPatch(updateLine)) return;

        const hunk = lastItem(this.hunks);
        if (hunk?.type !== "update") {
            throw invalidHunk(unexpectedUpdateLineMessage(line), this.lineNumber);
        }

        const previousChunk = lastItem(hunk.chunks);
        if (previousChunk?.isEndOfFile) {
            if (updateLine.length === 0) return;
            if (
                updateLine !== EMPTY_CHANGE_CONTEXT_MARKER &&
                !updateLine.startsWith(CHANGE_CONTEXT_MARKER)
            ) {
                throw invalidHunk(
                    `Expected update hunk to start with a @@ context marker, got: '${line}'`,
                    this.lineNumber,
                );
            }
        }

        const moveToPath = stripPrefix(updateLine, MOVE_TO_MARKER);
        if (hunk.chunks.length === 0 && hunk.movePath === undefined && moveToPath !== undefined) {
            hunk.movePath = moveToPath;
            this.mode = { type: "updateFile", hunkLineNumber };
            return;
        }

        if (
            (updateLine === EMPTY_CHANGE_CONTEXT_MARKER ||
                updateLine.startsWith(CHANGE_CONTEXT_MARKER)) &&
            previousChunk !== undefined &&
            previousChunk.oldLines.length === 0 &&
            previousChunk.newLines.length === 0
        ) {
            throw invalidHunk(unexpectedUpdateLineMessage(line), this.lineNumber);
        }

        if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
            hunk.chunks.push(makeUpdateChunk(undefined));
            this.mode = { type: "updateFile", hunkLineNumber };
            return;
        }

        const changeContext = stripPrefix(updateLine, CHANGE_CONTEXT_MARKER);
        if (changeContext !== undefined) {
            hunk.chunks.push(makeUpdateChunk(changeContext));
            this.mode = { type: "updateFile", hunkLineNumber };
            return;
        }

        if (updateLine === EOF_MARKER) {
            if (
                previousChunk !== undefined &&
                previousChunk.oldLines.length === 0 &&
                previousChunk.newLines.length === 0
            ) {
                throw invalidHunk("Update hunk does not contain any lines", this.lineNumber);
            }
            if (previousChunk !== undefined) previousChunk.isEndOfFile = true;
            this.mode = { type: "updateFile", hunkLineNumber };
            return;
        }

        if (line.length === 0) {
            const chunk = ensureCurrentUpdateChunk(hunk);
            chunk.oldLines.push("");
            chunk.newLines.push("");
            this.mode = { type: "updateFile", hunkLineNumber };
            return;
        }

        const contextLine = stripPrefix(line, " ");
        if (contextLine !== undefined) {
            const chunk = ensureCurrentUpdateChunk(hunk);
            chunk.oldLines.push(contextLine);
            chunk.newLines.push(contextLine);
            this.mode = { type: "updateFile", hunkLineNumber };
            return;
        }

        const addedLine = stripPrefix(line, "+");
        if (addedLine !== undefined) {
            const chunk = ensureCurrentUpdateChunk(hunk);
            chunk.newLines.push(addedLine);
            this.mode = { type: "updateFile", hunkLineNumber };
            return;
        }

        const removedLine = stripPrefix(line, "-");
        if (removedLine !== undefined) {
            const chunk = ensureCurrentUpdateChunk(hunk);
            chunk.oldLines.push(removedLine);
            this.mode = { type: "updateFile", hunkLineNumber };
            return;
        }

        if (
            previousChunk !== undefined &&
            (previousChunk.oldLines.length > 0 || previousChunk.newLines.length > 0)
        ) {
            throw invalidHunk(
                `Expected update hunk to start with a @@ context marker, got: '${line}'`,
                this.lineNumber,
            );
        }

        throw invalidHunk(unexpectedUpdateLineMessage(line), this.lineNumber);
    }
}

/** Parses a Codex apply_patch document into executable hunks. */
export function parseApplyPatch(patchText: string): ApplyPatchArgs {
    const originalLines = trimmedLines(patchText);
    const patchLines = checkPatchBoundariesLenient(originalLines);
    const patch = patchLines.join("\n");
    const parser = new StreamingPatchParser();
    parser.pushDelta(patch);
    const hunks = parser.finish();
    return {
        patch,
        hunks,
        workdir: undefined,
        environmentId: parser.environmentId(),
    };
}

/** Applies a Codex apply_patch document to the local filesystem rooted at cwd. */
export async function applyPatchText(
    patchText: string,
    cwd: string,
    options: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> {
    const args = parseApplyPatch(patchText);
    return applyPatchHunks(args.hunks, cwd, options);
}

/** Applies parsed apply_patch hunks to the local filesystem rooted at cwd. */
export async function applyPatchHunks(
    hunks: readonly ApplyPatchHunk[],
    cwd: string,
    options: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> {
    if (hunks.length === 0) throw new ApplyPatchError("compute", "No files were modified.");

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    const changes: AppliedPatchFileChange[] = [];
    const absoluteCwd = resolve(cwd);

    for (const hunk of hunks) {
        throwIfAborted(options.signal);
        if (hunk.type === "add") {
            const absolutePath = resolvePatchPath(absoluteCwd, hunk.path);
            const overwrittenContent = await readOptionalFileText(absolutePath);
            throwIfAborted(options.signal);
            await writeFileWithMissingParentRetry(absolutePath, hunk.contents);
            throwIfAborted(options.signal);
            changes.push({
                type: "add",
                path: absolutePath,
                content: hunk.contents,
                overwrittenContent,
            });
            added.push(hunk.path);
            continue;
        }

        if (hunk.type === "delete") {
            const absolutePath = resolvePatchPath(absoluteCwd, hunk.path);
            const content = await readFileForPatch(absolutePath, `Failed to read ${absolutePath}`);
            throwIfAborted(options.signal);
            await ensureNotDirectory(absolutePath, `Failed to delete file ${absolutePath}`);
            await removeFile(absolutePath, `Failed to delete file ${absolutePath}`);
            throwIfAborted(options.signal);
            changes.push({ type: "delete", path: absolutePath, content });
            deleted.push(hunk.path);
            continue;
        }

        const absolutePath = resolvePatchPath(absoluteCwd, hunk.path);
        const applied = await deriveNewContentsFromChunks(absolutePath, hunk.chunks);
        throwIfAborted(options.signal);
        if (hunk.movePath !== undefined) {
            const absoluteMovePath = resolvePatchPath(absoluteCwd, hunk.movePath);
            const overwrittenMoveContent = await readOptionalFileText(absoluteMovePath);
            throwIfAborted(options.signal);
            await writeFileWithMissingParentRetry(absoluteMovePath, applied.newContents);
            throwIfAborted(options.signal);
            await ensureNotDirectory(absolutePath, `Failed to remove original ${absolutePath}`);
            await removeFile(absolutePath, `Failed to remove original ${absolutePath}`);
            throwIfAborted(options.signal);
            changes.push({
                type: "update",
                path: absolutePath,
                movePath: absoluteMovePath,
                oldContent: applied.originalContents,
                newContent: applied.newContents,
                overwrittenMoveContent,
            });
            modified.push(hunk.movePath);
        } else {
            await writeFileWithContext(absolutePath, applied.newContents);
            throwIfAborted(options.signal);
            changes.push({
                type: "update",
                path: absolutePath,
                movePath: undefined,
                oldContent: applied.originalContents,
                newContent: applied.newContents,
                overwrittenMoveContent: undefined,
            });
            modified.push(hunk.path);
        }
    }

    const affectedPaths = { added, modified, deleted };
    return {
        summary: formatApplyPatchSummary(affectedPaths),
        affectedPaths,
        changes,
    };
}

/** Formats an apply_patch failure as model-visible tool output text. */
export function formatApplyPatchError(error: ApplyPatchError): string {
    if (error.kind === "invalidPatch") return `Invalid patch: ${error.message}`;
    if (error.kind === "invalidHunk") {
        const line = error.lineNumber ?? 0;
        return `Invalid patch hunk on line ${line}: ${error.message}`;
    }
    return error.message;
}

/** Returns the native Codex success summary for affected paths. */
export function formatApplyPatchSummary(affected: ApplyPatchAffectedPaths): string {
    const lines = ["Success. Updated the following files:"];
    for (const filePath of affected.added) lines.push(`A ${filePath}`);
    for (const filePath of affected.modified) lines.push(`M ${filePath}`);
    for (const filePath of affected.deleted) lines.push(`D ${filePath}`);
    return `${lines.join("\n")}\n`;
}

export function seekSequence(
    lines: readonly string[],
    pattern: readonly string[],
    start: number,
    eof: boolean,
): number | undefined {
    if (pattern.length === 0) return start;
    if (pattern.length > lines.length) return undefined;

    const maxStart = lines.length - pattern.length;
    const searchStart = eof && lines.length >= pattern.length ? maxStart : start;
    if (searchStart > maxStart) return undefined;

    const passes: readonly ((line: string, patternLine: string) => boolean)[] = [
        (line, patternLine) => line === patternLine,
        (line, patternLine) => line.trimEnd() === patternLine.trimEnd(),
        (line, patternLine) => line.trim() === patternLine.trim(),
        (line, patternLine) => normalizeMatchText(line) === normalizeMatchText(patternLine),
    ];

    for (const matchesLine of passes) {
        for (let index = searchStart; index <= maxStart; index += 1) {
            if (sequenceMatches(lines, pattern, index, matchesLine)) return index;
        }
    }

    return undefined;
}

function checkPatchBoundariesLenient(originalLines: readonly string[]): readonly string[] {
    try {
        return checkPatchBoundariesStrict(originalLines);
    } catch (cause: unknown) {
        if (!(cause instanceof ApplyPatchError)) throw cause;
        const first = originalLines[0];
        const last = originalLines.at(-1);
        if (
            first !== undefined &&
            last !== undefined &&
            (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
            last.endsWith("EOF") &&
            originalLines.length >= 4
        ) {
            return checkPatchBoundariesStrict(originalLines.slice(1, -1));
        }
        throw cause;
    }
}

function checkPatchBoundariesStrict(lines: readonly string[]): readonly string[] {
    const first = lines[0]?.trim();
    const last = lines.at(-1)?.trim();
    if (first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) return lines;
    if (first !== undefined && first !== BEGIN_PATCH_MARKER) {
        throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
    }
    throw invalidPatch("The last line of the patch must be '*** End Patch'");
}

function trimmedLines(text: string): readonly string[] {
    const trimmed = text.trim();
    return trimmed.length === 0 ? [] : trimmed.split("\n");
}

function cloneHunks(hunks: readonly MutableApplyPatchHunk[]): ApplyPatchHunk[] {
    return hunks.map((hunk) => {
        if (hunk.type === "add") return { type: "add", path: hunk.path, contents: hunk.contents };
        if (hunk.type === "delete") return { type: "delete", path: hunk.path };
        return {
            type: "update",
            path: hunk.path,
            movePath: hunk.movePath,
            chunks: hunk.chunks.map((chunk) => ({
                changeContext: chunk.changeContext,
                oldLines: [...chunk.oldLines],
                newLines: [...chunk.newLines],
                isEndOfFile: chunk.isEndOfFile,
            })),
        };
    });
}

function makeUpdateChunk(changeContext: string | undefined): MutableUpdateFileChunk {
    return { changeContext, oldLines: [], newLines: [], isEndOfFile: false };
}

function ensureCurrentUpdateChunk(hunk: MutableUpdateFileHunk): MutableUpdateFileChunk {
    const existing = lastItem(hunk.chunks);
    if (existing !== undefined) return existing;
    const chunk = makeUpdateChunk(undefined);
    hunk.chunks.push(chunk);
    return chunk;
}

function resolvePatchPath(cwd: string, patchPath: string): string {
    const resolved =
        patchPath.length === 0 ? cwd : isAbsolute(patchPath) ? patchPath : resolve(cwd, patchPath);
    return normalize(resolved);
}

async function deriveNewContentsFromChunks(
    absolutePath: string,
    chunks: readonly UpdateFileChunk[],
): Promise<{ readonly originalContents: string; readonly newContents: string }> {
    const originalContents = await readFileForPatch(
        absolutePath,
        `Failed to read file to update ${absolutePath}`,
    );
    const originalLines = originalContents.split("\n");
    if (originalLines.at(-1) === "") originalLines.pop();

    const replacements = computeReplacements(originalLines, absolutePath, chunks);
    const newLines = applyReplacements(originalLines, replacements);
    if (newLines.at(-1) !== "") newLines.push("");
    return { originalContents, newContents: newLines.join("\n") };
}

function computeReplacements(
    originalLines: readonly string[],
    filePath: string,
    chunks: readonly UpdateFileChunk[],
): Replacement[] {
    const replacements: Replacement[] = [];
    let lineIndex = 0;

    for (const chunk of chunks) {
        if (chunk.changeContext !== undefined) {
            const contextIndex = seekSequence(
                originalLines,
                [chunk.changeContext],
                lineIndex,
                false,
            );
            if (contextIndex === undefined) {
                throw new ApplyPatchError(
                    "compute",
                    `Failed to find context '${chunk.changeContext}' in ${filePath}`,
                );
            }
            lineIndex = contextIndex + 1;
        }

        if (chunk.oldLines.length === 0) {
            const insertionIndex =
                originalLines.at(-1) === "" ? originalLines.length - 1 : originalLines.length;
            replacements.push({
                startIndex: insertionIndex,
                oldLength: 0,
                newLines: [...chunk.newLines],
            });
            continue;
        }

        let pattern = [...chunk.oldLines];
        let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
        let newLines = [...chunk.newLines];

        if (found === undefined && pattern.at(-1) === "") {
            pattern = pattern.slice(0, -1);
            if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
            found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
        }

        if (found === undefined) {
            throw new ApplyPatchError(
                "compute",
                `Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`,
            );
        }

        replacements.push({ startIndex: found, oldLength: pattern.length, newLines });
        lineIndex = found + pattern.length;
    }

    return replacements.sort((left, right) => left.startIndex - right.startIndex);
}

function applyReplacements(
    lines: readonly string[],
    replacements: readonly Replacement[],
): string[] {
    const nextLines = [...lines];
    for (const replacement of [...replacements].reverse()) {
        nextLines.splice(replacement.startIndex, replacement.oldLength, ...replacement.newLines);
    }
    return nextLines;
}

async function readOptionalFileText(absolutePath: string): Promise<string | undefined> {
    try {
        return await readFile(absolutePath, "utf8");
    } catch (cause: unknown) {
        if (hasNodeErrorCode(cause, "ENOENT")) return undefined;
        throw ioError(`Failed to read ${absolutePath}`, cause);
    }
}

async function readFileForPatch(absolutePath: string, context: string): Promise<string> {
    try {
        return await readFile(absolutePath, "utf8");
    } catch (cause: unknown) {
        throw ioError(context, cause);
    }
}

async function ensureNotDirectory(absolutePath: string, context: string): Promise<void> {
    try {
        const metadata = await stat(absolutePath);
        if (metadata.isDirectory())
            throw new ApplyPatchError("io", `${context}: path is a directory`);
    } catch (cause: unknown) {
        if (cause instanceof ApplyPatchError) throw cause;
        throw ioError(context, cause);
    }
}

async function removeFile(absolutePath: string, context: string): Promise<void> {
    try {
        await rm(absolutePath, { force: false, recursive: false });
    } catch (cause: unknown) {
        throw ioError(context, cause);
    }
}

async function writeFileWithMissingParentRetry(
    absolutePath: string,
    contents: string,
): Promise<void> {
    try {
        await writeFile(absolutePath, contents, "utf8");
    } catch (cause: unknown) {
        if (!hasNodeErrorCode(cause, "ENOENT")) {
            throw ioError(`Failed to write file ${absolutePath}`, cause);
        }
        try {
            await mkdir(dirname(absolutePath), { recursive: true });
        } catch (mkdirCause: unknown) {
            throw ioError(`Failed to create parent directories for ${absolutePath}`, mkdirCause);
        }
        await writeFileWithContext(absolutePath, contents);
    }
}

async function writeFileWithContext(absolutePath: string, contents: string): Promise<void> {
    try {
        await writeFile(absolutePath, contents, "utf8");
    } catch (cause: unknown) {
        throw ioError(`Failed to write file ${absolutePath}`, cause);
    }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new Error("Operation aborted");
}

function sequenceMatches(
    lines: readonly string[],
    pattern: readonly string[],
    start: number,
    matchesLine: (line: string, patternLine: string) => boolean,
): boolean {
    for (let offset = 0; offset < pattern.length; offset += 1) {
        const line = lines[start + offset];
        const patternLine = pattern[offset];
        if (line === undefined || patternLine === undefined) return false;
        if (!matchesLine(line, patternLine)) return false;
    }
    return true;
}

function normalizeMatchText(text: string): string {
    let normalized = "";
    for (const char of text.trim()) normalized += normalizeMatchCharacter(char);
    return normalized;
}

function normalizeMatchCharacter(char: string): string {
    switch (char) {
        case "\u2010":
        case "\u2011":
        case "\u2012":
        case "\u2013":
        case "\u2014":
        case "\u2015":
        case "\u2212":
            return "-";
        case "\u2018":
        case "\u2019":
        case "\u201A":
        case "\u201B":
            return "'";
        case "\u201C":
        case "\u201D":
        case "\u201E":
        case "\u201F":
            return '"';
        case "\u00A0":
        case "\u2002":
        case "\u2003":
        case "\u2004":
        case "\u2005":
        case "\u2006":
        case "\u2007":
        case "\u2008":
        case "\u2009":
        case "\u200A":
        case "\u202F":
        case "\u205F":
        case "\u3000":
            return " ";
        default:
            return char;
    }
}

function stripPrefix(text: string, prefix: string): string | undefined {
    return text.startsWith(prefix) ? text.slice(prefix.length) : undefined;
}

function trimOneTrailingCarriageReturn(text: string): string {
    return text.endsWith("\r") ? text.slice(0, -1) : text;
}

function lastItem<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : items[items.length - 1];
}

function invalidPatch(message: string): ApplyPatchError {
    return new ApplyPatchError("invalidPatch", message);
}

function invalidHunk(message: string, lineNumber: number): ApplyPatchError {
    return new ApplyPatchError("invalidHunk", message, lineNumber);
}

function invalidHunkHeaderMessage(line: string): string {
    return `'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`;
}

function unexpectedUpdateLineMessage(line: string): string {
    return `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`;
}

function ioError(context: string, cause: unknown): ApplyPatchError {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new ApplyPatchError("io", `${context}: ${message}`);
}

function hasNodeErrorCode(cause: unknown, code: string): boolean {
    return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}
