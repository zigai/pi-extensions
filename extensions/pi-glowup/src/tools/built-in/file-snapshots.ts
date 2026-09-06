import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import Type from "typebox";
import { Value } from "typebox/value";
import {
    DEFAULT_DIFF_RENDER_LIMITS,
    type DiffRenderLimits,
    type DiffSnapshot,
} from "../../rendering/diff/payload.ts";
import type { PierreDiffSummary } from "../../rendering/diff/types.ts";
import { countContentLines } from "../../text-boundaries.ts";

const nodeErrorCodeSchema = Type.Object({ code: Type.String() });

type FileSnapshot = {
    readonly content: string;
    readonly sizeBytes: number;
    readonly lineCount: number;
    readonly skippedReason?: "too-large" | "not-readable";
};

/** In-flight snapshot for edit tool execution. */
export type EditSnapshotState = {
    readonly finish: () => Promise<DiffSnapshot>;
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
