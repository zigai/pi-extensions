import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";

import {
    checkSettingsArtifacts,
    generateSettingsArtifacts,
    renderSettingsArtifacts,
} from "../src/artifacts.ts";
import { defineExtensionSettings } from "../src/definition.ts";
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
        expect(rendered.readmeSection).toContain("### Defaults");
        expect(rendered.readmeSection).toContain("### Advanced example");
        expect(rendered.readmeSection).toContain('"mode": "expanded"');
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

    it("detects codec-only source drift during artifact checking without modifying files", async () => {
        const files = await artifactFiles();
        const targets = {
            ...files,
            prevalidationPath: join(dirname(files.schemaPath), "settings.prevalidated.ts"),
        };
        const input = {
            id: "codec-artifacts",
            title: "Codec Artifacts",
            description: "Generated codec settings.",
        };
        const first = defineExtensionSettings({
            ...input,
            schema: Type.Object(
                {
                    value: Type.Codec(Type.String({ default: "value", description: "Value." }))
                        .Decode((value) => `${value}-a`)
                        .Encode((value) => value.slice(0, -2)),
                },
                { additionalProperties: false },
            ),
        });
        const changed = defineExtensionSettings({
            ...input,
            schema: Type.Object(
                {
                    value: Type.Codec(Type.String({ default: "value", description: "Value." }))
                        .Decode((value) => `${value}-b`)
                        .Encode((value) => value.slice(0, -2)),
                },
                { additionalProperties: false },
            ),
        });
        expect(JSON.stringify(changed.schema)).toBe(JSON.stringify(first.schema));
        generateSettingsArtifacts(first, targets);
        const original = await readFile(targets.prevalidationPath, "utf8");

        expect(checkSettingsArtifacts(changed, targets)).toEqual({
            current: false,
            stalePaths: [targets.prevalidationPath],
        });
        expect(await readFile(targets.prevalidationPath, "utf8")).toBe(original);
        expect(generateSettingsArtifacts(changed, targets).changedPaths).toEqual([
            targets.prevalidationPath,
        ]);
        expect(checkSettingsArtifacts(changed, targets)).toEqual({ current: true, stalePaths: [] });
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
