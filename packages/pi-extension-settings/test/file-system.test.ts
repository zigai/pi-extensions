import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    readTextIfPresent,
    readTextIfPresentAsync,
    writeTextAtomically,
    writeTextAtomicallyAsync,
    writeTextIfMissing,
} from "../src/file-system.ts";

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
        expect(writeTextIfMissing(path, () => "first\n")).toBe("created");
        expect(writeTextIfMissing(path, () => "second\n")).toBe("unchanged");
        expect(readTextIfPresent(path)).toBe("first\n");
        expect(readdirSync(join(root, "nested"))).toEqual(["config.json"]);
    });

    it.each(['{"enabled":false}\n', "{ malformed\n"])(
        "preserves existing content without touching its directory: %j",
        (content) => {
            const root = temporaryDirectory();
            const path = join(root, "config.json");
            writeFileSync(path, content, { mode: 0o400 });
            const timestamp = new Date("2000-01-01T00:00:00Z");
            utimesSync(root, timestamp, timestamp);
            const before = statSync(path);

            expect(
                writeTextIfMissing(path, () => {
                    throw new Error("Existing configs must not produce scaffold content");
                }),
            ).toBe("unchanged");

            expect(readFileSync(path, "utf8")).toBe(content);
            expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
            expect(statSync(path).mode).toBe(before.mode);
            expect(statSync(root).mtimeMs).toBe(timestamp.getTime());
            expect(readdirSync(root)).toEqual(["config.json"]);
        },
    );

    it("leaves an existing config in a read-only directory unchanged", () => {
        const root = temporaryDirectory();
        const path = join(root, "config.json");
        writeFileSync(path, "original\n");
        chmodSync(root, 0o500);
        try {
            expect(writeTextIfMissing(path, () => "replacement\n")).toBe("unchanged");
            expect(readFileSync(path, "utf8")).toBe("original\n");
            expect(readdirSync(root)).toEqual(["config.json"]);
        } finally {
            chmodSync(root, 0o700);
        }
    });

    it("preserves a dangling symlink without touching its directory", () => {
        const root = temporaryDirectory();
        const path = join(root, "config.json");
        symlinkSync("missing.json", path);
        const timestamp = new Date("2000-01-01T00:00:00Z");
        utimesSync(root, timestamp, timestamp);

        expect(writeTextIfMissing(path, () => "replacement\n")).toBe("unchanged");
        expect(readlinkSync(path)).toBe("missing.json");
        expect(statSync(root).mtimeMs).toBe(timestamp.getTime());
        expect(readdirSync(root)).toEqual(["config.json"]);
    });

    it("preserves a competing config created while producing scaffold content", () => {
        const root = temporaryDirectory();
        const path = join(root, "config.json");

        const status = writeTextIfMissing(path, () => {
            writeFileSync(path, "competitor\n", { flag: "wx", mode: 0o400 });
            return "scaffold\n";
        });

        expect(status).toBe("unchanged");
        expect(readFileSync(path, "utf8")).toBe("competitor\n");
        expect(statSync(path).mode & 0o777).toBe(0o400);
        expect(readdirSync(root)).toEqual(["config.json"]);
    });

    it("propagates content production failures without publishing or leaving temporary files", () => {
        const root = temporaryDirectory();
        const path = join(root, "config.json");
        const failure = new Error("Content production failed");

        expect(() =>
            writeTextIfMissing(path, () => {
                throw failure;
            }),
        ).toThrow(failure);
        expect(readTextIfPresent(path)).toBeUndefined();
        expect(readdirSync(root)).toEqual([]);
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
        expect(() => writeTextIfMissing(join(parentFile, "child"), () => "x")).toThrow();
        expect(() => writeTextAtomically(join(parentFile, "child"), "x")).toThrow();
    });

    it("throws for a read-only directory", () => {
        const root = temporaryDirectory();
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o500);
        try {
            expect(() => writeTextIfMissing(join(locked, "config.json"), () => "x")).toThrow();
            expect(() => writeTextAtomically(join(locked, "schema.json"), "x")).toThrow();
        } finally {
            chmodSync(locked, 0o700);
        }
    });

    it("throws when reading a directory", () => {
        const directory = temporaryDirectory();
        expect(() => readTextIfPresent(directory)).toThrow();
    });

    it("asynchronously reads and atomically replaces content while preserving permissions", async () => {
        const root = temporaryDirectory();
        const path = join(root, "nested", "config.json");
        expect(await readTextIfPresentAsync(path)).toBeUndefined();

        await writeTextAtomicallyAsync(path, "first\n");
        expect(await readTextIfPresentAsync(path)).toBe("first\n");
        expect((await stat(path)).mode & 0o777).toBe(0o600);

        await chmod(path, 0o640);
        await writeTextAtomicallyAsync(path, "second\n");
        expect(await readFile(path, "utf8")).toBe("second\n");
        expect((await stat(path)).mode & 0o777).toBe(0o640);
        expect(await readdir(join(root, "nested"))).toEqual(["config.json"]);
    });

    it("reports asynchronous read and replacement failures without leaving temporary files", async () => {
        const root = temporaryDirectory();
        const directory = join(root, "directory");
        mkdirSync(directory);
        await expect(readTextIfPresentAsync(directory)).rejects.toBeDefined();

        const parentFile = join(root, "parent");
        await writeFile(parentFile, "file");
        await expect(
            writeTextAtomicallyAsync(join(parentFile, "config.json"), "content\n"),
        ).rejects.toBeDefined();
        expect(await readdir(root)).toEqual(["directory", "parent"]);
    });
});
