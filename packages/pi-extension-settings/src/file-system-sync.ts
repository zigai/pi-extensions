import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

export function readTextIfPresentSync(path: string): ReadTextResult {
    try {
        return Result.ok(readFileSync(path, "utf8"));
    } catch (cause: unknown) {
        if (errorCode(cause) === "ENOENT") return Result.ok(undefined);
        return Result.err(fileFailure("read", path, cause));
    }
}

export function writeTextIfMissingSync(path: string, content: string, mode = 0o600): WriteResult {
    try {
        mkdirSync(dirname(path), { recursive: true });
    } catch (cause: unknown) {
        return Result.err(fileFailure("write", path, cause));
    }

    try {
        writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode });
        return Result.ok("created");
    } catch (cause: unknown) {
        if (errorCode(cause) === "EEXIST") return Result.ok("unchanged");
        return Result.err(fileFailure("write", path, cause));
    }
}

export function writeTextAtomicallySync(path: string, content: string, mode = 0o644): WriteResult {
    const current = readTextIfPresentSync(path);
    if (Result.isError(current)) return current;
    if (current.value === content) return Result.ok("unchanged");

    const directory = dirname(path);
    const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode });
        renameSync(temporaryPath, path);
        return Result.ok(current.value === undefined ? "created" : "updated");
    } catch (cause: unknown) {
        return Result.err(fileFailure("write", path, cause));
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}
