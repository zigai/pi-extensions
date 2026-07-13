import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Result, type Result as ResultType } from "better-result";

import { FileOperationFailed } from "./failures.ts";

type ReadTextResult = ResultType<string | undefined, FileOperationFailed>;
type WriteResult = ResultType<"created" | "unchanged" | "updated", FileOperationFailed>;

function errorCode(cause: unknown): string | undefined {
    if (cause === null || typeof cause !== "object" || !("code" in cause)) return undefined;
    return typeof cause.code === "string" ? cause.code : undefined;
}

function fileFailure(
    operation: "read" | "write",
    path: string,
    cause: unknown,
): FileOperationFailed {
    return new FileOperationFailed({ operation, path, code: errorCode(cause), cause });
}

export async function readTextIfPresent(path: string): Promise<ReadTextResult> {
    try {
        return Result.ok(await readFile(path, "utf8"));
    } catch (cause: unknown) {
        if (errorCode(cause) === "ENOENT") return Result.ok(undefined);
        return Result.err(fileFailure("read", path, cause));
    }
}

export async function writeTextIfMissing(
    path: string,
    content: string,
    mode = 0o600,
): Promise<WriteResult> {
    try {
        await mkdir(dirname(path), { recursive: true });
    } catch (cause: unknown) {
        return Result.err(fileFailure("write", path, cause));
    }

    try {
        await writeFile(path, content, { encoding: "utf8", flag: "wx", mode });
        return Result.ok("created");
    } catch (cause: unknown) {
        if (errorCode(cause) === "EEXIST") return Result.ok("unchanged");
        return Result.err(fileFailure("write", path, cause));
    }
}

export async function writeTextAtomically(
    path: string,
    content: string,
    mode = 0o644,
): Promise<WriteResult> {
    const current = await readTextIfPresent(path);
    if (Result.isError(current)) return current;
    if (current.value === content) return Result.ok("unchanged");

    const directory = dirname(path);
    const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);

    try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode });
        await rename(temporaryPath, path);
        return Result.ok(current.value === undefined ? "created" : "updated");
    } catch (cause: unknown) {
        return Result.err(fileFailure("write", path, cause));
    } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}
