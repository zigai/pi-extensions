import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Result } from "better-result";
import { afterEach, describe, expect, it } from "vitest";

import { readTextIfPresent, writeTextAtomically, writeTextIfMissing } from "../src/file-system.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
    const path = mkdtempSync(join(tmpdir(), "pi-settings-sync-files-"));
    temporaryDirectories.push(path);
    return path;
}

afterEach(() => {
    for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true });
});

describe("file operations", () => {
    it("reads missing files and atomically creates config", () => {
        const root = temporaryDirectory();
        const path = join(root, "nested", "config.json");
        expect(readTextIfPresent(path)).toEqual(Result.ok(undefined));
        expect(writeTextIfMissing(path, "first\n")).toEqual(Result.ok("created"));
        expect(writeTextIfMissing(path, "second\n")).toEqual(Result.ok("unchanged"));
        expect(readTextIfPresent(path)).toEqual(Result.ok("first\n"));
        expect(readdirSync(join(root, "nested"))).toEqual(["config.json"]);
    });

    it("atomically creates, preserves, and updates schema", () => {
        const path = join(temporaryDirectory(), "schemas", "config.schema.json");
        expect(writeTextAtomically(path, "first\n")).toEqual(Result.ok("created"));
        expect(writeTextAtomically(path, "first\n")).toEqual(Result.ok("unchanged"));
        expect(writeTextAtomically(path, "second\n")).toEqual(Result.ok("updated"));
        expect(readFileSync(path, "utf8")).toBe("second\n");
    });

    it("returns typed failures for invalid parent paths", () => {
        const root = temporaryDirectory();
        const parentFile = join(root, "parent");
        writeFileSync(parentFile, "file");

        expect(Result.isError(readTextIfPresent(parentFile))).toBe(false);
        expect(Result.isError(writeTextIfMissing(join(parentFile, "child"), "x"))).toBe(true);
        expect(Result.isError(writeTextAtomically(join(parentFile, "child"), "x"))).toBe(true);
    });

    it("returns typed write failures for a read-only directory", () => {
        const root = temporaryDirectory();
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o500);
        try {
            expect(Result.isError(writeTextIfMissing(join(locked, "config.json"), "x"))).toBe(true);
            expect(Result.isError(writeTextAtomically(join(locked, "schema.json"), "x"))).toBe(
                true,
            );
        } finally {
            chmodSync(locked, 0o700);
        }
    });

    it("returns a typed read failure for directories", () => {
        const directory = temporaryDirectory();
        expect(Result.isError(readTextIfPresent(directory))).toBe(true);
    });
});
