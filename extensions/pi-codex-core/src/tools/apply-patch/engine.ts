import {
    lstat as nodeLstat,
    mkdir as nodeMkdir,
    readFile as nodeReadFile,
    readlink as nodeReadlink,
    realpath as nodeRealpath,
    rm as nodeRm,
    writeFile as nodeWriteFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";

import { Result, type Result as BetterResult } from "better-result";

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

export type ApplyPatchErrorKind =
    | "invalidPatch"
    | "invalidHunk"
    | "compute"
    | "conflict"
    | "cancelled"
    | "io";

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

/** Failure raised after filesystem mutations committed or may have partially occurred. */
export class ApplyPatchExecutionError extends ApplyPatchError {
    readonly committedResult: ApplyPatchResult;
    readonly uncertainPaths: readonly string[];
    override readonly cause: ApplyPatchError;

    constructor(
        cause: ApplyPatchError,
        committedResult: ApplyPatchResult,
        uncertainPaths: readonly string[] = [],
    ) {
        super(cause.kind, cause.message, cause.lineNumber);
        this.name = "ApplyPatchExecutionError";
        this.cause = cause;
        this.committedResult = committedResult;
        this.uncertainPaths = uncertainPaths;
    }
}

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

type PatchFileMetadata = {
    isSymbolicLink(): boolean;
};

/** Filesystem boundary used by apply_patch execution. */
export type ApplyPatchFileSystem = {
    readFile(path: string): Promise<string>;
    writeFile(path: string, contents: string): Promise<void>;
    lstat(path: string): Promise<PatchFileMetadata>;
    mkdir(path: string): Promise<void>;
    readlink(path: string): Promise<string>;
    realpath(path: string): Promise<string>;
    removeFile(path: string): Promise<void>;
};

export type ApplyPatchOptions = {
    readonly signal?: AbortSignal | undefined;
    readonly environmentId?: string | undefined;
    readonly fileSystem?: ApplyPatchFileSystem | undefined;
};

const nodeFileSystem: ApplyPatchFileSystem = {
    readFile: (path) => nodeReadFile(path, "utf8"),
    writeFile: (path, contents) => nodeWriteFile(path, contents, "utf8"),
    lstat: (path) => nodeLstat(path),
    mkdir: async (path) => {
        await nodeMkdir(path, { recursive: true });
    },
    readlink: (path) => nodeReadlink(path),
    realpath: (path) => nodeRealpath(path),
    removeFile: async (path) => {
        await nodeRm(path, { force: false, recursive: false });
    },
};

type FileSnapshot =
    | { readonly type: "missing" }
    | { readonly type: "file"; readonly contents: string };

type PlannedPatchMutation =
    | {
          readonly type: "add";
          readonly patchPath: string;
          readonly absolutePath: string;
          readonly contents: string;
          readonly before: FileSnapshot;
      }
    | {
          readonly type: "delete";
          readonly patchPath: string;
          readonly absolutePath: string;
          readonly content: string;
          readonly before: FileSnapshot;
      }
    | {
          readonly type: "update";
          readonly patchPath: string;
          readonly absolutePath: string;
          readonly movePatchPath: string | undefined;
          readonly absoluteMovePath: string | undefined;
          readonly originalContents: string;
          readonly newContents: string;
          readonly before: FileSnapshot;
          readonly moveBefore: FileSnapshot | undefined;
      };

type CommittedPatchChange = {
    readonly action: "added" | "modified" | "deleted";
    readonly patchPath: string;
    readonly change: AppliedPatchFileChange;
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

/** Parses a Codex apply_patch document into executable hunks or a typed parse failure. */
export function parseApplyPatch(patchText: string): BetterResult<ApplyPatchArgs, ApplyPatchError> {
    try {
        const originalLines = trimmedLines(patchText);
        const patchLines = checkPatchBoundariesLenient(originalLines);
        const patch = patchLines.join("\n");
        const parser = new StreamingPatchParser();
        parser.pushDelta(patch);
        const hunks = parser.finish();
        return Result.ok({
            patch,
            hunks,
            workdir: undefined,
            environmentId: parser.environmentId(),
        });
    } catch (cause: unknown) {
        if (cause instanceof ApplyPatchError) return Result.err(cause);
        throw cause;
    }
}

/** Applies a patch document, returning expected parse and execution failures as values. */
export async function applyPatchText(
    patchText: string,
    cwd: string,
    options: ApplyPatchOptions = {},
): Promise<BetterResult<ApplyPatchResult, ApplyPatchError>> {
    const parsed = parseApplyPatch(patchText);
    if (parsed.isErr()) return Result.err(parsed.error);
    return applyPatchHunks(parsed.value.hunks, cwd, {
        ...options,
        environmentId: parsed.value.environmentId ?? options.environmentId,
    });
}

/** Applies parsed hunks, returning expected execution failures as values. */
export async function applyPatchHunks(
    hunks: readonly ApplyPatchHunk[],
    cwd: string,
    options: ApplyPatchOptions = {},
): Promise<BetterResult<ApplyPatchResult, ApplyPatchError>> {
    try {
        return Result.ok(await applyPatchHunksOrThrow(hunks, cwd, options));
    } catch (cause: unknown) {
        return Result.err(classifyApplyPatchFailure(cause));
    }
}

async function applyPatchHunksOrThrow(
    hunks: readonly ApplyPatchHunk[],
    cwd: string,
    options: ApplyPatchOptions,
): Promise<ApplyPatchResult> {
    if (options.environmentId !== undefined) {
        throw invalidPatch(
            "apply_patch environment_id is not supported because Pi has no environment selector",
        );
    }
    if (hunks.length === 0) throw new ApplyPatchError("compute", "No files were modified.");

    throwIfAborted(options.signal);
    const fileSystem = options.fileSystem ?? nodeFileSystem;
    const root = normalize(resolve(cwd));
    const plan = await preflightPatchHunks(hunks, root, fileSystem, options.signal);
    const committed: CommittedPatchChange[] = [];
    const uncertainPaths = new Set<string>();

    try {
        for (const mutation of plan) {
            await executePlannedMutation(
                mutation,
                fileSystem,
                committed,
                uncertainPaths,
                options.signal,
            );
        }
    } catch (cause: unknown) {
        const error = classifyApplyPatchFailure(cause);
        if (committed.length > 0 || uncertainPaths.size > 0) {
            throw new ApplyPatchExecutionError(error, buildApplyPatchResult(committed), [
                ...uncertainPaths,
            ]);
        }
        throw error;
    }

    return buildApplyPatchResult(committed);
}

/** Formats an apply_patch failure as model-visible tool output text. */
export function formatApplyPatchError(error: ApplyPatchError): string {
    if (error instanceof ApplyPatchExecutionError) {
        const failure = formatApplyPatchFailure(error.cause);
        const sections = [failure];
        if (error.committedResult.changes.length > 0) {
            sections.push(formatCommittedPatchSummary(error.committedResult.affectedPaths));
        }
        if (error.uncertainPaths.length > 0) {
            sections.push(formatUncertainPatchSummary(error.uncertainPaths));
        }
        return sections.join("\n\n");
    }
    return formatApplyPatchFailure(error);
}

function formatApplyPatchFailure(error: ApplyPatchError): string {
    if (error.kind === "invalidPatch") return `Invalid patch: ${error.message}`;
    if (error.kind === "invalidHunk") {
        const line = error.lineNumber ?? 0;
        return `Invalid patch hunk on line ${line}: ${error.message}`;
    }
    if (error.kind === "cancelled") return `Patch application cancelled: ${error.message}`;
    return error.message;
}

function formatUncertainPatchSummary(paths: readonly string[]): string {
    return `A failed write may have partially modified the following paths; their state is uncertain:\n${paths.map((path) => `? ${path}`).join("\n")}`;
}

function formatCommittedPatchSummary(affected: ApplyPatchAffectedPaths): string {
    const successSummary = formatApplyPatchSummary(affected).trimEnd();
    return successSummary.replace(
        "Success. Updated the following files:",
        "Patch stopped after committing the following changes:",
    );
}

/** Returns the native Codex success summary for affected paths. */
export function formatApplyPatchSummary(affected: ApplyPatchAffectedPaths): string {
    const lines = ["Success. Updated the following files:"];
    for (const filePath of affected.added) lines.push(`A ${filePath}`);
    for (const filePath of affected.modified) lines.push(`M ${filePath}`);
    for (const filePath of affected.deleted) lines.push(`D ${filePath}`);
    return `${lines.join("\n")}\n`;
}

function seekSequence(
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

async function preflightPatchHunks(
    hunks: readonly ApplyPatchHunk[],
    root: string,
    fileSystem: ApplyPatchFileSystem,
    signal: AbortSignal | undefined,
): Promise<PlannedPatchMutation[]> {
    const plan: PlannedPatchMutation[] = [];
    const virtualFiles = new Map<string, FileSnapshot>();
    const lexicalPathByPhysicalPath = new Map<string, string>();

    const registerPath = async (absolutePath: string): Promise<void> => {
        const physicalPath = normalize(
            await resolvePhysicalPath(fileSystem, absolutePath, new Set<string>()),
        );
        const existingLexicalPath = lexicalPathByPhysicalPath.get(physicalPath);
        if (existingLexicalPath !== undefined && existingLexicalPath !== absolutePath) {
            throw new ApplyPatchError(
                "compute",
                `Patch paths ${existingLexicalPath} and ${absolutePath} resolve to the same filesystem target`,
            );
        }
        lexicalPathByPhysicalPath.set(physicalPath, absolutePath);
    };

    const snapshot = async (absolutePath: string): Promise<FileSnapshot> => {
        const existing = virtualFiles.get(absolutePath);
        if (existing !== undefined) return existing;
        const loaded = await readFileSnapshot(fileSystem, absolutePath);
        virtualFiles.set(absolutePath, loaded);
        return loaded;
    };

    for (const hunk of hunks) {
        throwIfAborted(signal);
        const absolutePath = resolvePatchPath(root, hunk.path);
        await registerPath(absolutePath);
        const before = await snapshot(absolutePath);

        if (hunk.type === "add") {
            plan.push({
                type: "add",
                patchPath: hunk.path,
                absolutePath,
                contents: hunk.contents,
                before,
            });
            virtualFiles.set(absolutePath, fileSnapshot(hunk.contents));
            continue;
        }

        const originalContents = requireFileSnapshot(before, absolutePath, hunk.type);
        if (hunk.type === "delete") {
            plan.push({
                type: "delete",
                patchPath: hunk.path,
                absolutePath,
                content: originalContents,
                before,
            });
            virtualFiles.set(absolutePath, missingSnapshot());
            continue;
        }

        const newContents = deriveNewContentsFromChunks(
            originalContents,
            absolutePath,
            hunk.chunks,
        );
        const absoluteMovePath =
            hunk.movePath === undefined ? undefined : resolvePatchPath(root, hunk.movePath);
        if (absoluteMovePath === absolutePath) {
            throw new ApplyPatchError("compute", `Cannot move ${absolutePath} onto the same path`);
        }
        if (absoluteMovePath !== undefined) await registerPath(absoluteMovePath);
        const moveBefore =
            absoluteMovePath === undefined ? undefined : await snapshot(absoluteMovePath);
        plan.push({
            type: "update",
            patchPath: hunk.path,
            absolutePath,
            movePatchPath: hunk.movePath,
            absoluteMovePath,
            originalContents,
            newContents,
            before,
            moveBefore,
        });
        if (absoluteMovePath === undefined) {
            virtualFiles.set(absolutePath, fileSnapshot(newContents));
        } else {
            virtualFiles.set(absolutePath, missingSnapshot());
            virtualFiles.set(absoluteMovePath, fileSnapshot(newContents));
        }
    }

    return plan;
}

async function executePlannedMutation(
    mutation: PlannedPatchMutation,
    fileSystem: ApplyPatchFileSystem,
    committed: CommittedPatchChange[],
    uncertainPaths: Set<string>,
    signal: AbortSignal | undefined,
): Promise<void> {
    if (mutation.type === "add") {
        await verifyMutationSnapshot(fileSystem, mutation.absolutePath, mutation.before);
        throwIfAborted(signal);
        await writeFileWithMissingParentRetry(
            fileSystem,
            mutation.absolutePath,
            mutation.contents,
            uncertainPaths,
            signal,
        );
        committed.push({
            action: "added",
            patchPath: mutation.patchPath,
            change: {
                type: "add",
                path: mutation.absolutePath,
                content: mutation.contents,
                overwrittenContent: snapshotContents(mutation.before),
            },
        });
        return;
    }

    if (mutation.type === "delete") {
        await verifyMutationSnapshot(fileSystem, mutation.absolutePath, mutation.before);
        throwIfAborted(signal);
        await removeFile(
            fileSystem,
            mutation.absolutePath,
            `Failed to delete file ${mutation.absolutePath}`,
        );
        committed.push({
            action: "deleted",
            patchPath: mutation.patchPath,
            change: { type: "delete", path: mutation.absolutePath, content: mutation.content },
        });
        return;
    }

    if (mutation.absoluteMovePath === undefined || mutation.movePatchPath === undefined) {
        await verifyMutationSnapshot(fileSystem, mutation.absolutePath, mutation.before);
        throwIfAborted(signal);
        await writeFileWithContext(
            fileSystem,
            mutation.absolutePath,
            mutation.newContents,
            uncertainPaths,
            signal,
        );
        committed.push({
            action: "modified",
            patchPath: mutation.patchPath,
            change: {
                type: "update",
                path: mutation.absolutePath,
                movePath: undefined,
                oldContent: mutation.originalContents,
                newContent: mutation.newContents,
                overwrittenMoveContent: undefined,
            },
        });
        return;
    }

    if (mutation.moveBefore === undefined) {
        throw new ApplyPatchError("compute", "Move destination snapshot was not planned");
    }
    await verifyMutationSnapshot(fileSystem, mutation.absolutePath, mutation.before);
    await verifyMutationSnapshot(fileSystem, mutation.absoluteMovePath, mutation.moveBefore);
    throwIfAborted(signal);
    await writeFileWithMissingParentRetry(
        fileSystem,
        mutation.absoluteMovePath,
        mutation.newContents,
        uncertainPaths,
        signal,
    );
    committed.push(destinationWriteChange(mutation));

    await verifyMutationSnapshot(fileSystem, mutation.absolutePath, mutation.before);
    throwIfAborted(signal);
    await removeFile(
        fileSystem,
        mutation.absolutePath,
        `Failed to remove original ${mutation.absolutePath}`,
    );

    committed.pop();
    committed.push({
        action: "modified",
        patchPath: mutation.movePatchPath,
        change: {
            type: "update",
            path: mutation.absolutePath,
            movePath: mutation.absoluteMovePath,
            oldContent: mutation.originalContents,
            newContent: mutation.newContents,
            overwrittenMoveContent: snapshotContents(mutation.moveBefore),
        },
    });
}

function destinationWriteChange(
    mutation: Extract<PlannedPatchMutation, { readonly type: "update" }>,
): CommittedPatchChange {
    const movePath = mutation.absoluteMovePath;
    const movePatchPath = mutation.movePatchPath;
    if (movePath === undefined || movePatchPath === undefined) {
        throw new ApplyPatchError("compute", "Move destination was not planned");
    }
    const overwrittenMoveContent = snapshotContents(mutation.moveBefore);
    if (overwrittenMoveContent === undefined) {
        return {
            action: "added",
            patchPath: movePatchPath,
            change: {
                type: "add",
                path: movePath,
                content: mutation.newContents,
                overwrittenContent: undefined,
            },
        };
    }
    return {
        action: "modified",
        patchPath: movePatchPath,
        change: {
            type: "update",
            path: movePath,
            movePath: undefined,
            oldContent: overwrittenMoveContent,
            newContent: mutation.newContents,
            overwrittenMoveContent: undefined,
        },
    };
}

function resolvePatchPath(root: string, patchPath: string): string {
    return normalize(
        patchPath.length === 0
            ? root
            : isAbsolute(patchPath)
              ? patchPath
              : resolve(root, patchPath),
    );
}

async function resolvePhysicalPath(
    fileSystem: ApplyPatchFileSystem,
    absolutePath: string,
    seenLinks: Set<string>,
): Promise<string> {
    try {
        return normalize(await fileSystem.realpath(absolutePath));
    } catch (cause: unknown) {
        if (hasNodeErrorCode(cause, "ELOOP")) {
            throw new ApplyPatchError(
                "io",
                `Failed to resolve apply_patch path with a symbolic-link loop: ${absolutePath}`,
            );
        }
        if (!hasNodeErrorCode(cause, "ENOENT") && !hasNodeErrorCode(cause, "ENOTDIR")) {
            throw ioError(`Failed to resolve apply_patch path ${absolutePath}`, cause);
        }
    }

    try {
        const metadata = await fileSystem.lstat(absolutePath);
        if (metadata.isSymbolicLink()) {
            if (seenLinks.has(absolutePath)) {
                throw new ApplyPatchError(
                    "io",
                    `Failed to resolve apply_patch path with a symbolic-link loop: ${absolutePath}`,
                );
            }
            seenLinks.add(absolutePath);
            const linkTarget = await fileSystem.readlink(absolutePath);
            return resolvePhysicalPath(
                fileSystem,
                resolve(dirname(absolutePath), linkTarget),
                seenLinks,
            );
        }
        throw new ApplyPatchError("io", `Failed to resolve apply_patch path: ${absolutePath}`);
    } catch (cause: unknown) {
        if (cause instanceof ApplyPatchError) throw cause;
        if (!hasNodeErrorCode(cause, "ENOENT") && !hasNodeErrorCode(cause, "ENOTDIR")) {
            throw ioError(`Failed to resolve apply_patch path ${absolutePath}`, cause);
        }
    }

    const parent = dirname(absolutePath);
    if (parent === absolutePath) return absolutePath;
    const physicalParent = await resolvePhysicalPath(fileSystem, parent, seenLinks);
    return normalize(resolve(physicalParent, basename(absolutePath)));
}

function buildApplyPatchResult(committed: readonly CommittedPatchChange[]): ApplyPatchResult {
    const affectedPaths: ApplyPatchAffectedPaths = {
        added: committed
            .filter((entry) => entry.action === "added")
            .map((entry) => entry.patchPath),
        modified: committed
            .filter((entry) => entry.action === "modified")
            .map((entry) => entry.patchPath),
        deleted: committed
            .filter((entry) => entry.action === "deleted")
            .map((entry) => entry.patchPath),
    };
    return {
        summary: formatApplyPatchSummary(affectedPaths),
        affectedPaths,
        changes: committed.map((entry) => entry.change),
    };
}

function classifyApplyPatchFailure(cause: unknown): ApplyPatchError {
    return cause instanceof ApplyPatchError
        ? cause
        : ioError("Failed while executing apply_patch mutation plan", cause);
}

function deriveNewContentsFromChunks(
    originalContents: string,
    absolutePath: string,
    chunks: readonly UpdateFileChunk[],
): string {
    const originalLines = originalContents.split("\n");
    if (originalLines.at(-1) === "") originalLines.pop();

    const replacements = computeReplacements(originalLines, absolutePath, chunks);
    const newLines = applyReplacements(originalLines, replacements);
    if (newLines.at(-1) !== "") newLines.push("");
    return newLines.join("\n");
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

function missingSnapshot(): FileSnapshot {
    return { type: "missing" };
}

function fileSnapshot(contents: string): FileSnapshot {
    return { type: "file", contents };
}

function snapshotContents(snapshot: FileSnapshot | undefined): string | undefined {
    return snapshot?.type === "file" ? snapshot.contents : undefined;
}

function requireFileSnapshot(
    snapshot: FileSnapshot,
    absolutePath: string,
    operation: "delete" | "update",
): string {
    if (snapshot.type === "file") return snapshot.contents;
    throw new ApplyPatchError("io", `Failed to ${operation} missing file ${absolutePath}`);
}

async function readFileSnapshot(
    fileSystem: ApplyPatchFileSystem,
    absolutePath: string,
): Promise<FileSnapshot> {
    try {
        return fileSnapshot(await fileSystem.readFile(absolutePath));
    } catch (cause: unknown) {
        if (hasNodeErrorCode(cause, "ENOENT")) return missingSnapshot();
        throw ioError(`Failed to read ${absolutePath}`, cause);
    }
}

async function verifyMutationSnapshot(
    fileSystem: ApplyPatchFileSystem,
    absolutePath: string,
    expected: FileSnapshot,
): Promise<void> {
    let actual: FileSnapshot;
    try {
        actual = await readFileSnapshot(fileSystem, absolutePath);
    } catch (cause: unknown) {
        const error = classifyApplyPatchFailure(cause);
        throw new ApplyPatchError(
            "conflict",
            `apply_patch detected a concurrent change at ${absolutePath}: ${error.message}`,
        );
    }
    if (snapshotsEqual(expected, actual)) return;
    throw new ApplyPatchError(
        "conflict",
        `apply_patch detected a concurrent change at ${absolutePath}; patch was not applied to stale contents`,
    );
}

function snapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
    if (left.type !== right.type) return false;
    return left.type === "missing" || (right.type === "file" && left.contents === right.contents);
}

async function removeFile(
    fileSystem: ApplyPatchFileSystem,
    absolutePath: string,
    context: string,
): Promise<void> {
    try {
        await fileSystem.removeFile(absolutePath);
    } catch (cause: unknown) {
        throw ioError(context, cause);
    }
}

async function writeFileWithMissingParentRetry(
    fileSystem: ApplyPatchFileSystem,
    absolutePath: string,
    contents: string,
    uncertainPaths: Set<string>,
    signal: AbortSignal | undefined,
): Promise<void> {
    throwIfAborted(signal);
    try {
        await writeFileAttempt(fileSystem, absolutePath, contents, uncertainPaths);
    } catch (cause: unknown) {
        if (!hasNodeErrorCode(cause, "ENOENT")) {
            throw ioError(`Failed to write file ${absolutePath}`, cause);
        }
        uncertainPaths.delete(absolutePath);
        try {
            throwIfAborted(signal);
            await fileSystem.mkdir(dirname(absolutePath));
        } catch (mkdirCause: unknown) {
            if (mkdirCause instanceof ApplyPatchError) throw mkdirCause;
            throw ioError(`Failed to create parent directories for ${absolutePath}`, mkdirCause);
        }
        await writeFileWithContext(fileSystem, absolutePath, contents, uncertainPaths, signal);
    }
}

async function writeFileWithContext(
    fileSystem: ApplyPatchFileSystem,
    absolutePath: string,
    contents: string,
    uncertainPaths: Set<string>,
    signal: AbortSignal | undefined,
): Promise<void> {
    throwIfAborted(signal);
    try {
        await writeFileAttempt(fileSystem, absolutePath, contents, uncertainPaths);
    } catch (cause: unknown) {
        throw ioError(`Failed to write file ${absolutePath}`, cause);
    }
}

async function writeFileAttempt(
    fileSystem: ApplyPatchFileSystem,
    absolutePath: string,
    contents: string,
    uncertainPaths: Set<string>,
): Promise<void> {
    uncertainPaths.add(absolutePath);
    await fileSystem.writeFile(absolutePath, contents);
    uncertainPaths.delete(absolutePath);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new ApplyPatchError("cancelled", "operation was aborted");
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
