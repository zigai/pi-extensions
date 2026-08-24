import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Type, Value } from "./typebox-runtime.ts";

type WriteStatus = "created" | "unchanged" | "updated";

const CodedErrorSchema = Type.Object({ code: Type.String() });

function errorCode(cause: Error): string | undefined {
    return Value.Check(CodedErrorSchema, cause) ? cause.code : undefined;
}

export function readTextIfPresent(path: string): string | undefined {
    try {
        return readFileSync(path, "utf8");
    } catch (cause: unknown) {
        if (cause instanceof Error && errorCode(cause) === "ENOENT") return undefined;
        throw cause;
    }
}

export async function readTextIfPresentAsync(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf8");
    } catch (cause: unknown) {
        if (cause instanceof Error && errorCode(cause) === "ENOENT") return undefined;
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
            if (cause instanceof Error && errorCode(cause) === "EEXIST") return "unchanged";
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

/** Atomically replace complete content while preserving an existing file's permission mode. */
export async function writeTextAtomicallyAsync(
    path: string,
    content: string,
    defaultMode = 0o600,
): Promise<void> {
    let mode = defaultMode;
    try {
        mode = (await stat(path)).mode & 0o777;
    } catch (cause: unknown) {
        if (!(cause instanceof Error) || errorCode(cause) !== "ENOENT") throw cause;
    }

    const directory = dirname(path);
    const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
        const handle = await open(temporaryPath, "wx", mode);
        try {
            await handle.writeFile(content, { encoding: "utf8" });
            await handle.sync();
        } finally {
            await handle.close();
        }
        await chmod(temporaryPath, mode);
        await rename(temporaryPath, path);
    } finally {
        try {
            await rm(temporaryPath, { force: true });
        } catch {
            // Cleanup must not mask the write result.
        }
    }
}
