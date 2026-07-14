import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkSettingsArtifacts, generateSettingsArtifacts } from "../src/artifacts.ts";
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
    it("throws when README cannot be read", async () => {
        const root = await temporaryDirectory();
        const readmePath = join(root, "README.md");
        await mkdir(readmePath);

        expect(() =>
            generateSettingsArtifacts(testDefinition(), {
                schemaPath: join(root, "config.schema.json"),
                readmePath,
            }),
        ).toThrow();
    });

    it("throws when schema output cannot be written", async () => {
        const root = await temporaryDirectory();
        const parentFile = join(root, "blocked");
        const readmePath = join(root, "README.md");
        await writeFile(parentFile, "file");
        await writeFile(readmePath, `${README_GENERATED_START}\nold\n${README_GENERATED_END}\n`);

        expect(() =>
            generateSettingsArtifacts(testDefinition(), {
                schemaPath: join(parentFile, "config.schema.json"),
                readmePath,
            }),
        ).toThrow();
    });

    it("reports only a missing schema when README content is current", async () => {
        const root = await temporaryDirectory();
        const readmePath = join(root, "README.md");
        const section = renderReadmeSettingsSection(testDefinition());
        await writeFile(
            readmePath,
            `${README_GENERATED_START}\n${section}\n${README_GENERATED_END}\n`,
        );

        const result = checkSettingsArtifacts(testDefinition(), {
            schemaPath: join(root, "config.schema.json"),
            readmePath,
        });

        expect(result).toEqual({
            current: false,
            stalePaths: [join(root, "config.schema.json")],
        });
    });
});
