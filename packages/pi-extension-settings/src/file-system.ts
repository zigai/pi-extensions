import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

type WriteStatus = "created" | "unchanged" | "updated";

export function readTextIfPresent(path: string): string | undefined {
    try {
        return readFileSync(path, "utf8");
    } catch (cause: unknown) {
        const error: NodeJS.ErrnoException | undefined = cause instanceof Error ? cause : undefined;
        if (error?.code === "ENOENT") return undefined;
        throw cause;
    }
}

/** Atomically publish complete content only when the destination does not already exist. */
export function writeTextIfMissing(path: string, content: string, mode = 0o600): WriteStatus {
    const directory = dirname(path);
    const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);

    try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode });
        try {
            linkSync(temporaryPath, path);
            return "created";
        } catch (cause: unknown) {
            const error: NodeJS.ErrnoException | undefined =
                cause instanceof Error ? cause : undefined;
            if (error?.code === "EEXIST") return "unchanged";
            throw cause;
        }
    } finally {
        try {
            rmSync(temporaryPath, { force: true });
        } catch {
            // Cleanup must not mask the write result.
        }
    }
}

export function writeTextAtomically(path: string, content: string, mode = 0o644): WriteStatus {
    const current = readTextIfPresent(path);
    if (current === content) return "unchanged";

    const directory = dirname(path);
    const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode });
        renameSync(temporaryPath, path);
        return current === undefined ? "created" : "updated";
    } finally {
        try {
            rmSync(temporaryPath, { force: true });
        } catch {
            // Cleanup must not mask the write result.
        }
    }
}
