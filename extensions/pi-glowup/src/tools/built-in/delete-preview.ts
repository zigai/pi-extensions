import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { DiffSection } from "../../rendering/diff/text-diff.ts";

const DEFAULT_DELETE_PREIMAGE_BYTES = 256 * 1024;

export type TextFilePreimage = {
    readonly lines: readonly string[];
    readonly endsWithNewline: boolean;
};

export type DeletedTextPreview = {
    readonly section: DiffSection;
    readonly removed: number;
    readonly preimage?: TextFilePreimage;
};

type TextFilePreimageOptions = {
    /** Allow callers that only need metadata to read mutation targets outside cwd. */
    readonly allowOutsideCwd?: boolean;
};

/** Captures a bounded readable text file. By default, paths cannot leave the working directory. */
export async function captureTextFilePreimage(
    cwd: string,
    filePath: string,
    maxBytes: number | null = DEFAULT_DELETE_PREIMAGE_BYTES,
    options: TextFilePreimageOptions = {},
): Promise<TextFilePreimage | undefined> {
    const resolvedCwd = path.resolve(cwd);
    const resolvedPath = path.resolve(resolvedCwd, filePath);
    const relativePath = path.relative(resolvedCwd, resolvedPath);
    const leavesCwd =
        relativePath.length === 0 ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath);
    if (leavesCwd && options.allowOutsideCwd !== true) {
        return undefined;
    }

    try {
        const stats = await stat(resolvedPath);
        if (!stats.isFile() || (maxBytes !== null && stats.size > maxBytes)) {
            return undefined;
        }

        const data = await readFile(resolvedPath);
        if (data.includes(0)) {
            return undefined;
        }

        const normalized = data.toString("utf8").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
        const endsWithNewline = normalized.endsWith("\n");
        const lines = normalized.split("\n");
        if (lines.at(-1) === "") {
            lines.pop();
        }

        return { lines, endsWithNewline };
    } catch {
        return undefined;
    }
}

/** Captures a bounded readable text file before deletion without leaving the working directory. */
export async function captureDeletedTextPreview(
    cwd: string,
    filePath: string,
    maxBytes: number | null = DEFAULT_DELETE_PREIMAGE_BYTES,
): Promise<DeletedTextPreview | undefined> {
    const preimage = await captureTextFilePreimage(cwd, filePath, maxBytes);
    if (preimage === undefined) {
        return undefined;
    }

    return {
        section: {
            path: filePath,
            lines: preimage.lines.map((line, index) => `-${index + 1} ${line}`),
            added: 0,
            removed: preimage.lines.length,
        },
        removed: preimage.lines.length,
        preimage,
    };
}
