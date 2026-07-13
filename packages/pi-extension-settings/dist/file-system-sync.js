import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Result } from "better-result";
import { FileOperationFailed } from "./failures.js";
function errorCode(cause) {
    if (cause === null || typeof cause !== "object" || !("code" in cause))
        return undefined;
    return typeof cause.code === "string" ? cause.code : undefined;
}
function fileFailure(operation, path, cause) {
    return new FileOperationFailed({ operation, path, code: errorCode(cause), cause });
}
export function readTextIfPresentSync(path) {
    try {
        return Result.ok(readFileSync(path, "utf8"));
    }
    catch (cause) {
        if (errorCode(cause) === "ENOENT")
            return Result.ok(undefined);
        return Result.err(fileFailure("read", path, cause));
    }
}
export function writeTextIfMissingSync(path, content, mode = 0o600) {
    try {
        mkdirSync(dirname(path), { recursive: true });
    }
    catch (cause) {
        return Result.err(fileFailure("write", path, cause));
    }
    try {
        writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode });
        return Result.ok("created");
    }
    catch (cause) {
        if (errorCode(cause) === "EEXIST")
            return Result.ok("unchanged");
        return Result.err(fileFailure("write", path, cause));
    }
}
export function writeTextAtomicallySync(path, content, mode = 0o644) {
    const current = readTextIfPresentSync(path);
    if (Result.isError(current))
        return current;
    if (current.value === content)
        return Result.ok("unchanged");
    const directory = dirname(path);
    const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode });
        renameSync(temporaryPath, path);
        return Result.ok(current.value === undefined ? "created" : "updated");
    }
    catch (cause) {
        return Result.err(fileFailure("write", path, cause));
    }
    finally {
        rmSync(temporaryPath, { force: true });
    }
}
//# sourceMappingURL=file-system-sync.js.map