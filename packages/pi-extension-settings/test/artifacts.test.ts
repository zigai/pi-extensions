import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    checkSettingsArtifacts,
    generateSettingsArtifacts,
    renderSettingsArtifacts,
} from "../src/artifacts.ts";
import { README_GENERATED_END, README_GENERATED_START } from "../src/settings-documentation.ts";
import { testDefinition } from "./fixture.ts";

const temporaryDirectories: string[] = [];

async function artifactFiles(readmeContent?: string) {
    const root = await mkdtemp(join(tmpdir(), "pi-settings-artifacts-"));
    temporaryDirectories.push(root);
    const targets = {
        schemaPath: join(root, "config.schema.json"),
        readmePath: join(root, "README.md"),
    };
    await writeFile(
        targets.readmePath,
        readmeContent ??
            `# Package\n\nIntro.\n\n${README_GENERATED_START}\nold\n${README_GENERATED_END}\n`,
    );
    return targets;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("settings artifacts", () => {
    it("renders deterministic schema and README content", () => {
        const rendered = renderSettingsArtifacts(testDefinition(), {
            schemaPath: "/repo/config.schema.json",
            readmePath: "/repo/README.md",
        });

        expect(rendered.schema.endsWith("\n")).toBe(true);
        expect(rendered.schema).toContain(
            '"$id": "https://example.test/pi-example/config.schema.json"',
        );
        expect(rendered.readmeSection).toContain("| `appearance.opacity` | number | `0.8`");
    });

    it("generates, checks, and then remains idempotent", async () => {
        const targets = await artifactFiles();
        const generated = generateSettingsArtifacts(testDefinition(), targets);
        expect(generated.changedPaths).toEqual([targets.schemaPath, targets.readmePath]);

        const checked = checkSettingsArtifacts(testDefinition(), targets);
        expect(checked).toEqual({ current: true, stalePaths: [] });

        const repeated = generateSettingsArtifacts(testDefinition(), targets);
        expect(repeated).toEqual({ changedPaths: [] });
        expect(await readFile(targets.readmePath, "utf8")).toContain("Intro.");
    });

    it("reports each stale artifact without modifying it", async () => {
        const targets = await artifactFiles();
        generateSettingsArtifacts(testDefinition(), targets);
        await writeFile(targets.schemaPath, "stale\n");
        await writeFile(
            targets.readmePath,
            `# Changed\n${README_GENERATED_START}\nstale\n${README_GENERATED_END}\n`,
        );

        const checked = checkSettingsArtifacts(testDefinition(), targets);

        expect(checked).toEqual({
            current: false,
            stalePaths: [targets.schemaPath, targets.readmePath],
        });
        expect(await readFile(targets.schemaPath, "utf8")).toBe("stale\n");
    });

    it("rejects an incomplete generated README region", async () => {
        const targets = await artifactFiles(`# Package\n\n${README_GENERATED_START}\n`);

        expect(() => generateSettingsArtifacts(testDefinition(), targets)).toThrow("markers");
        await expect(readFile(targets.schemaPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("appends the generated README section when markers are absent", async () => {
        const targets = await artifactFiles("# Package\n");

        const generated = generateSettingsArtifacts(testDefinition(), targets);

        expect(generated).toEqual({ changedPaths: [targets.schemaPath, targets.readmePath] });
        await expect(readFile(targets.readmePath, "utf8")).resolves.toContain(
            `${README_GENERATED_START}\n## Configuration`,
        );
    });
});
