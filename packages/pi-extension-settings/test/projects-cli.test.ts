import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Result } from "better-result";
import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../src/cli.ts";
import { DefinitionModuleInvalid, ProjectManifestInvalid } from "../src/failures.ts";
import { discoverSettingsProjects } from "../src/projects.ts";
import { README_GENERATED_END, README_GENERATED_START } from "../src/settings-documentation.ts";

const temporaryDirectories: string[] = [];
const definitionImport = pathToFileURL(resolve("src/definition.ts")).href;

async function temporaryProject(): Promise<string> {
    const path = await mkdtemp(join(process.cwd(), ".tmp-settings-project-"));
    temporaryDirectories.push(path);
    return path;
}

async function writeConfiguredPackage(root: string, packageName = "fixture"): Promise<void> {
    await mkdir(root, { recursive: true });
    await writeFile(
        join(root, "package.json"),
        `${JSON.stringify(
            {
                name: packageName,
                type: "module",
                piExtensionSettings: {
                    definition: "./settings.mjs",
                    schema: "./config.schema.json",
                    readme: "./README.md",
                },
            },
            undefined,
            2,
        )}\n`,
    );
    await writeFile(
        join(root, "settings.mjs"),
        `import { Type } from "typebox";\nimport { defineExtensionSettings } from ${JSON.stringify(definitionImport)};\nexport default defineExtensionSettings({ id: ${JSON.stringify(packageName)}, title: "Fixture", description: "Fixture settings.", schema: Type.Object({ enabled: Type.Boolean({ default: true, description: "Enable it." }) }, { additionalProperties: false }) });\n`,
    );
    await writeFile(
        join(root, "README.md"),
        `# Fixture\n\n${README_GENERATED_START}\nold\n${README_GENERATED_END}\n`,
    );
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("project discovery", () => {
    it("discovers a configured standalone package", async () => {
        const root = await temporaryProject();
        await writeConfiguredPackage(root, "pi-fixture");

        const discovered = await discoverSettingsProjects(root);

        expect(Result.isOk(discovered)).toBe(true);
        if (Result.isError(discovered)) return;
        expect(discovered.value).toHaveLength(1);
        expect(discovered.value[0]?.definition.id).toBe("pi-fixture");
        expect(discovered.value[0]?.targets.schemaPath).toBe(join(root, "config.schema.json"));
    });

    it("discovers configured npm workspace packages", async () => {
        const root = await temporaryProject();
        await writeFile(
            join(root, "package.json"),
            JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
        );
        await writeConfiguredPackage(join(root, "packages", "first"), "pi-first");
        await writeConfiguredPackage(join(root, "packages", "second"), "pi-second");

        const discovered = await discoverSettingsProjects(root);

        expect(Result.isOk(discovered)).toBe(true);
        if (Result.isError(discovered)) return;
        expect(discovered.value.map((project) => project.definition.id)).toEqual([
            "pi-first",
            "pi-second",
        ]);
    });

    it("rejects unknown manifest keys", async () => {
        const root = await temporaryProject();
        await writeFile(
            join(root, "package.json"),
            JSON.stringify({
                piExtensionSettings: { definition: "./settings.mjs", unsupported: true },
            }),
        );

        const discovered = await discoverSettingsProjects(root);

        expect(Result.isError(discovered)).toBe(true);
        if (Result.isOk(discovered)) return;
        expect(ProjectManifestInvalid.is(discovered.error)).toBe(true);
    });

    it("rejects artifact paths outside the package", async () => {
        const root = await temporaryProject();
        await writeFile(
            join(root, "package.json"),
            JSON.stringify({ piExtensionSettings: { definition: "../settings.mjs" } }),
        );

        const discovered = await discoverSettingsProjects(root);

        expect(Result.isError(discovered)).toBe(true);
        if (Result.isOk(discovered)) return;
        expect(discovered.error.message).toContain("must stay inside");
    });

    it("rejects modules that do not export a definition", async () => {
        const root = await temporaryProject();
        await writeFile(
            join(root, "package.json"),
            JSON.stringify({ piExtensionSettings: { definition: "./settings.mjs" } }),
        );
        await writeFile(join(root, "settings.mjs"), "export default {};\n");

        const discovered = await discoverSettingsProjects(root);

        expect(Result.isError(discovered)).toBe(true);
        if (Result.isOk(discovered)) return;
        expect(DefinitionModuleInvalid.is(discovered.error)).toBe(true);
    });
});

describe("CLI", () => {
    function recordingIo(): {
        readonly io: CliIo;
        readonly stdout: string[];
        readonly stderr: string[];
    } {
        const stdout: string[] = [];
        const stderr: string[] = [];
        return {
            io: {
                stdout: (message) => stdout.push(message),
                stderr: (message) => stderr.push(message),
            },
            stdout,
            stderr,
        };
    }

    it("generates and checks configured projects", async () => {
        const root = await temporaryProject();
        await writeConfiguredPackage(root, "pi-fixture");
        const output = recordingIo();

        expect(await runCli(["generate", "--root", root], output.io)).toBe(0);
        expect(output.stdout.join("")).toContain("updated");
        expect(await readFile(join(root, "config.schema.json"), "utf8")).toContain(
            '"title": "Fixture settings"',
        );

        output.stdout.length = 0;
        expect(await runCli(["check", "--root", root], output.io)).toBe(0);
        expect(output.stdout.join("")).toContain("artifacts are current (1 package(s))");
    });

    it("fails checks for stale artifacts", async () => {
        const root = await temporaryProject();
        await writeConfiguredPackage(root, "pi-fixture");
        const output = recordingIo();

        expect(await runCli(["check", "--root", root], output.io)).toBe(1);
        expect(output.stderr.join("")).toContain("stale");
        expect(output.stderr.join("")).toContain("Run pi-extension-settings generate");
    });

    it("prints help and rejects invalid arguments", async () => {
        const help = recordingIo();
        expect(await runCli([], help.io)).toBe(0);
        expect(help.stdout.join("")).toContain("Usage: pi-extension-settings");

        const invalid = recordingIo();
        expect(await runCli(["unknown"], invalid.io)).toBe(2);
        expect(invalid.stderr.join("")).toContain("Invalid arguments");
    });

    it("reports when no configured package exists", async () => {
        const root = await temporaryProject();
        await writeFile(join(root, "package.json"), JSON.stringify({ name: "empty" }));
        const output = recordingIo();

        expect(await runCli(["check", "--root", root], output.io)).toBe(1);
        expect(output.stderr.join("")).toContain("No package.json");
    });
});
