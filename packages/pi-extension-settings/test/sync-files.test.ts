import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Result } from "better-result";
import { afterEach, describe, expect, it } from "vitest";

import {
    readTextIfPresentSync,
    writeTextAtomicallySync,
    writeTextIfMissingSync,
} from "../src/file-system-sync.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
    const path = mkdtempSync(join(tmpdir(), "pi-settings-sync-files-"));
    temporaryDirectories.push(path);
    return path;
}

afterEach(() => {
    for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true });
});

describe("synchronous file operations", () => {
    it("reads missing files and exclusively creates config", () => {
        const path = join(temporaryDirectory(), "nested", "config.json");
        expect(readTextIfPresentSync(path)).toEqual(Result.ok(undefined));
        expect(writeTextIfMissingSync(path, "first\n")).toEqual(Result.ok("created"));
        expect(writeTextIfMissingSync(path, "second\n")).toEqual(Result.ok("unchanged"));
        expect(readTextIfPresentSync(path)).toEqual(Result.ok("first\n"));
    });

    it("atomically creates, preserves, and updates schema", () => {
        const path = join(temporaryDirectory(), "schemas", "config.schema.json");
        expect(writeTextAtomicallySync(path, "first\n")).toEqual(Result.ok("created"));
        expect(writeTextAtomicallySync(path, "first\n")).toEqual(Result.ok("unchanged"));
        expect(writeTextAtomicallySync(path, "second\n")).toEqual(Result.ok("updated"));
        expect(readFileSync(path, "utf8")).toBe("second\n");
    });

    it("returns typed failures for invalid parent paths", () => {
        const root = temporaryDirectory();
        const parentFile = join(root, "parent");
        writeFileSync(parentFile, "file");

        expect(Result.isError(readTextIfPresentSync(parentFile))).toBe(false);
        expect(Result.isError(writeTextIfMissingSync(join(parentFile, "child"), "x"))).toBe(true);
        expect(Result.isError(writeTextAtomicallySync(join(parentFile, "child"), "x"))).toBe(true);
    });

    it("returns typed write failures for a read-only directory", () => {
        const root = temporaryDirectory();
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o500);
        try {
            expect(Result.isError(writeTextIfMissingSync(join(locked, "config.json"), "x"))).toBe(
                true,
            );
            expect(Result.isError(writeTextAtomicallySync(join(locked, "schema.json"), "x"))).toBe(
                true,
            );
        } finally {
            chmodSync(locked, 0o700);
        }
    });

    it("returns a typed read failure for directories", () => {
        const directory = temporaryDirectory();
        expect(Result.isError(readTextIfPresentSync(directory))).toBe(true);
    });
});
