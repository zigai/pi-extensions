import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
export async function readTextIfPresent(path) {
    try {
        return Result.ok(await readFile(path, "utf8"));
    }
    catch (cause) {
        if (errorCode(cause) === "ENOENT")
            return Result.ok(undefined);
        return Result.err(fileFailure("read", path, cause));
    }
}
export async function writeTextIfMissing(path, content, mode = 0o600) {
    try {
        await mkdir(dirname(path), { recursive: true });
    }
    catch (cause) {
        return Result.err(fileFailure("write", path, cause));
    }
    try {
        await writeFile(path, content, { encoding: "utf8", flag: "wx", mode });
        return Result.ok("created");
    }
    catch (cause) {
        if (errorCode(cause) === "EEXIST")
            return Result.ok("unchanged");
        return Result.err(fileFailure("write", path, cause));
    }
}
export async function writeTextAtomically(path, content, mode = 0o644) {
    const current = await readTextIfPresent(path);
    if (Result.isError(current))
        return current;
    if (current.value === content)
        return Result.ok("unchanged");
    const directory = dirname(path);
    const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode });
        await rename(temporaryPath, path);
        return Result.ok(current.value === undefined ? "created" : "updated");
    }
    catch (cause) {
        return Result.err(fileFailure("write", path, cause));
    }
    finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}
//# sourceMappingURL=file-system.js.map