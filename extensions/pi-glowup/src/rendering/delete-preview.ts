import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { DiffSection } from "./core.ts";

const MAX_DELETE_PREIMAGE_BYTES = 256 * 1024;

export type DeletedTextPreview = {
    readonly section: DiffSection;
    readonly removed: number;
};

/** Captures a bounded readable text file before deletion without leaving the working directory. */
export function captureDeletedTextPreview(
    cwd: string,
    filePath: string,
): DeletedTextPreview | undefined {
    const resolvedCwd = path.resolve(cwd);
    const resolvedPath = path.resolve(resolvedCwd, filePath);
    const relativePath = path.relative(resolvedCwd, resolvedPath);
    if (
        relativePath.length === 0 ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    ) {
        return undefined;
    }
    try {
        const stats = statSync(resolvedPath);
        if (!stats.isFile() || stats.size > MAX_DELETE_PREIMAGE_BYTES) {
            return undefined;
        }
        const data = readFileSync(resolvedPath);
        if (data.includes(0)) {
            return undefined;
        }
        const lines = data
            .toString("utf8")
            .replace(/\r\n/gu, "\n")
            .replace(/\r/gu, "\n")
            .split("\n");
        if (lines.at(-1) === "") {
            lines.pop();
        }
        return {
            section: {
                path: filePath,
                lines: lines.map((line, index) => `-${index + 1} ${line}`),
                added: 0,
                removed: lines.length,
            },
            removed: lines.length,
        };
    } catch {
        return undefined;
    }
}
