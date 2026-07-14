import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Result } from "better-result";
import { afterEach, describe, expect, it } from "vitest";

import { checkSettingsArtifacts, generateSettingsArtifacts } from "../src/artifacts.ts";
import { FileOperationFailed } from "../src/failures.ts";
import {
    README_GENERATED_END,
    README_GENERATED_START,
    renderReadmeSettingsSection,
} from "../src/settings-documentation.ts";
import { testDefinition } from "./fixture.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "pi-settings-artifact-errors-"));
    temporaryDirectories.push(path);
    return path;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("artifact filesystem failures", () => {
    it("returns a typed failure when README cannot be read", async () => {
        const root = await temporaryDirectory();
        const readmePath = join(root, "README.md");
        await mkdir(readmePath);

        const result = await generateSettingsArtifacts(testDefinition(), {
            schemaPath: join(root, "config.schema.json"),
            readmePath,
        });

        expect(Result.isError(result)).toBe(true);
        if (Result.isOk(result)) return;
        expect(FileOperationFailed.is(result.error)).toBe(true);
    });

    it("returns a typed failure when schema output cannot be written", async () => {
        const root = await temporaryDirectory();
        const parentFile = join(root, "blocked");
        const readmePath = join(root, "README.md");
        await writeFile(parentFile, "file");
        await writeFile(readmePath, `${README_GENERATED_START}\nold\n${README_GENERATED_END}\n`);

        const result = await generateSettingsArtifacts(testDefinition(), {
            schemaPath: join(parentFile, "config.schema.json"),
            readmePath,
        });

        expect(Result.isError(result)).toBe(true);
        if (Result.isOk(result)) return;
        expect(FileOperationFailed.is(result.error)).toBe(true);
    });

    it("reports only a missing schema when README content is current", async () => {
        const root = await temporaryDirectory();
        const readmePath = join(root, "README.md");
        const section = renderReadmeSettingsSection(testDefinition());
        await writeFile(
            readmePath,
            `${README_GENERATED_START}\n${section}\n${README_GENERATED_END}\n`,
        );

        const result = await checkSettingsArtifacts(testDefinition(), {
            schemaPath: join(root, "config.schema.json"),
            readmePath,
        });

        expect(result).toEqual(
            Result.ok({ current: false, stalePaths: [join(root, "config.schema.json")] }),
        );
    });
});
