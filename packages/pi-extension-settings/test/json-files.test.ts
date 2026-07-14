import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Result } from "better-result";
import { afterEach, describe, expect, it } from "vitest";

import { readTextIfPresent, writeTextAtomically, writeTextIfMissing } from "../src/file-system.ts";
import {
    cloneJson,
    formatJson,
    isJsonArray,
    isJsonObject,
    isJsonValue,
    parseJson,
} from "../src/json-value.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "pi-settings-files-"));
    temporaryDirectories.push(path);
    return path;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("JSON values", () => {
    it("accepts only finite, plain JSON values", () => {
        expect(isJsonValue(null)).toBe(true);
        expect(isJsonValue(true)).toBe(true);
        expect(isJsonValue("text")).toBe(true);
        expect(isJsonValue(4.5)).toBe(true);
        expect(isJsonValue([1, { nested: false }])).toBe(true);
        expect(isJsonArray([1, 2])).toBe(true);
        expect(isJsonObject({ value: 1 })).toBe(true);

        expect(isJsonValue(Number.NaN)).toBe(false);
        expect(isJsonValue(1n)).toBe(false);
        expect(isJsonValue(Symbol("x"))).toBe(false);
        expect(isJsonValue(undefined)).toBe(false);
        expect(isJsonValue(() => undefined)).toBe(false);
        expect(isJsonValue(new Date())).toBe(false);
        expect(isJsonArray({ 0: "not-array" })).toBe(false);
    });

    it("parses, clones, and formats without sharing mutable state", () => {
        const parsed = parseJson('{"items":[1,2]}');
        expect(parsed).toEqual({ items: [1, 2] });
        expect(parseJson("not json")).toBeUndefined();

        if (!isJsonObject(parsed)) return;
        const cloned = cloneJson(parsed);
        expect(cloned).toEqual(parsed);
        expect(cloned).not.toBe(parsed);
        expect(formatJson(cloned)).toBe('{\n  "items": [\n    1,\n    2\n  ]\n}\n');
    });
});

describe("safe file operations", () => {
    it("reads missing files and creates a file only once", async () => {
        const root = await temporaryDirectory();
        const path = join(root, "nested", "settings.json");

        expect(await readTextIfPresent(path)).toEqual(Result.ok(undefined));
        expect(await writeTextIfMissing(path, "first\n")).toEqual(Result.ok("created"));
        expect(await writeTextIfMissing(path, "second\n")).toEqual(Result.ok("unchanged"));
        expect(await readTextIfPresent(path)).toEqual(Result.ok("first\n"));
    });

    it("atomically chooses one complete config during concurrent creation", async () => {
        const root = await temporaryDirectory();
        const directory = join(root, "settings");
        const path = join(directory, "config.json");
        const candidates = Array.from(
            { length: 16 },
            (_, index) => `${JSON.stringify({ source: index, value: "x".repeat(64_000) })}\n`,
        );

        const writes = await Promise.all(
            candidates.map((content) => writeTextIfMissing(path, content)),
        );

        expect(writes.every((result) => !Result.isError(result))).toBe(true);
        expect(
            writes.filter((result) => !Result.isError(result) && result.value === "created"),
        ).toHaveLength(1);
        expect(candidates).toContain(await readFile(path, "utf8"));
        expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("atomically creates, preserves, and updates extension-owned files", async () => {
        const root = await temporaryDirectory();
        const path = join(root, "schemas", "config.schema.json");

        expect(await writeTextAtomically(path, "first\n")).toEqual(Result.ok("created"));
        expect(await writeTextAtomically(path, "first\n")).toEqual(Result.ok("unchanged"));
        expect(await writeTextAtomically(path, "second\n")).toEqual(Result.ok("updated"));
        expect(await readFile(path, "utf8")).toBe("second\n");
    });

    it("returns typed read and write failures", async () => {
        const root = await temporaryDirectory();
        const directoryPath = join(root, "directory");
        await mkdir(directoryPath);
        const read = await readTextIfPresent(directoryPath);
        expect(Result.isError(read)).toBe(true);

        const parentFile = join(root, "parent-file");
        await writeFile(parentFile, "file");
        const exclusive = await writeTextIfMissing(join(parentFile, "child"), "content");
        const atomic = await writeTextAtomically(join(parentFile, "child"), "content");
        expect(Result.isError(exclusive)).toBe(true);
        expect(Result.isError(atomic)).toBe(true);
    });

    it("returns typed failures when an existing directory is not writable", async () => {
        const root = await temporaryDirectory();
        const locked = join(root, "locked");
        await mkdir(locked);
        await chmod(locked, 0o500);
        try {
            const exclusive = await writeTextIfMissing(join(locked, "config.json"), "content");
            const atomic = await writeTextAtomically(join(locked, "schema.json"), "content");
            expect(Result.isError(exclusive)).toBe(true);
            expect(Result.isError(atomic)).toBe(true);
        } finally {
            await chmod(locked, 0o700);
        }
    });
});
