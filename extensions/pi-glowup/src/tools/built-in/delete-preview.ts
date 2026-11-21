import { constants, type Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
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

async function isOpenedWithin(
    directory: string,
    filePath: string,
    opened: Stats,
): Promise<boolean> {
    const canonicalPath = await realpath(filePath);
    if (leavesDirectory(await realpath(directory), canonicalPath)) {
        return false;
    }

    const current = await stat(canonicalPath);
    return current.dev === opened.dev && current.ino === opened.ino;
}

async function readCheckedFile(
    cwd: string,
    filePath: string,
    maxBytes: number | null,
    options: TextFilePreimageOptions,
): Promise<Buffer | undefined> {
    // Non-blocking open keeps a FIFO from waiting for a writer before the file check.
    const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);

    try {
        const stats = await file.stat();
        if (!stats.isFile() || (maxBytes !== null && stats.size > maxBytes)) {
            return undefined;
        }

        if (options.allowOutsideCwd !== true && !(await isOpenedWithin(cwd, filePath, stats))) {
            return undefined;
        }

        return await file.readFile();
    } finally {
        await file.close();
    }
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
        const data = await readCheckedFile(resolvedCwd, resolvedPath, maxBytes, options);
        if (data === undefined || data.includes(0)) {
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
