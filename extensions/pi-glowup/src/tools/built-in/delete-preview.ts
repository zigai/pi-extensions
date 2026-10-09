import { readFile, realpath, stat } from "node:fs/promises";
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

function leavesDirectory(directory: string, filePath: string): boolean {
    const relativePath = path.relative(directory, filePath);
    return (
        relativePath.length === 0 ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    );
}

/** Captures text after a size check; default paths must resolve within cwd. */
export async function captureTextFilePreimage(
    cwd: string,
    filePath: string,
    maxBytes: number | null = DEFAULT_DELETE_PREIMAGE_BYTES,
    options: TextFilePreimageOptions = {},
): Promise<TextFilePreimage | undefined> {
    const resolvedCwd = path.resolve(cwd);
    const resolvedPath = path.resolve(resolvedCwd, filePath);
    if (leavesDirectory(resolvedCwd, resolvedPath) && options.allowOutsideCwd !== true) {
        return undefined;
    }

    try {
        let readablePath = resolvedPath;
        if (options.allowOutsideCwd !== true) {
            const canonicalCwd = await realpath(resolvedCwd);
            const canonicalPath = await realpath(resolvedPath);
            if (leavesDirectory(canonicalCwd, canonicalPath)) {
                return undefined;
            }

            // Follow the validated target, not the original symlink. This does not
            // provide an atomic sandbox against concurrent ancestor replacement.
            readablePath = canonicalPath;
        }

        const stats = await stat(readablePath);
        if (!stats.isFile() || (maxBytes !== null && stats.size > maxBytes)) {
            return undefined;
        }

        const data = await readFile(readablePath);
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
