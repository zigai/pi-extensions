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
        expect(readTextIfPresent(path)).toBeUndefined();
        expect(writeTextIfMissing(path, "first\n")).toBe("created");
        expect(writeTextIfMissing(path, "second\n")).toBe("unchanged");
        expect(readTextIfPresent(path)).toBe("first\n");
        expect(readdirSync(join(root, "nested"))).toEqual(["config.json"]);
    });

    it("atomically creates, preserves, and updates schema", () => {
        const path = join(temporaryDirectory(), "schemas", "config.schema.json");
        expect(writeTextAtomically(path, "first\n")).toBe("created");
        expect(writeTextAtomically(path, "first\n")).toBe("unchanged");
        expect(writeTextAtomically(path, "second\n")).toBe("updated");
        expect(readFileSync(path, "utf8")).toBe("second\n");
    });

    it("throws for invalid parent paths", () => {
        const root = temporaryDirectory();
        const parentFile = join(root, "parent");
        writeFileSync(parentFile, "file");

        expect(readTextIfPresent(parentFile)).toBe("file");
        expect(() => writeTextIfMissing(join(parentFile, "child"), "x")).toThrow();
        expect(() => writeTextAtomically(join(parentFile, "child"), "x")).toThrow();
    });

    it("throws for a read-only directory", () => {
        const root = temporaryDirectory();
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o500);
        try {
            expect(() => writeTextIfMissing(join(locked, "config.json"), "x")).toThrow();
            expect(() => writeTextAtomically(join(locked, "schema.json"), "x")).toThrow();
        } finally {
            chmodSync(locked, 0o700);
        }
    });

    it("throws when reading a directory", () => {
        const directory = temporaryDirectory();
        expect(() => readTextIfPresent(directory)).toThrow();
    });
});
