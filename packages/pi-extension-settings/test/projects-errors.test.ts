import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Result } from "better-result";
import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../src/cli.ts";
import { discoverSettingsProjects } from "../src/projects.ts";

const temporaryDirectories: string[] = [];
const definitionImport = pathToFileURL(resolve("src/definition.ts")).href;

async function temporaryProject(): Promise<string> {
    const path = await mkdtemp(join(process.cwd(), ".tmp-settings-errors-"));
    temporaryDirectories.push(path);
    return path;
}

function recordingIo(): { readonly io: CliIo; readonly out: string[]; readonly err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
        io: { stdout: (message) => out.push(message), stderr: (message) => err.push(message) },
        out,
        err,
    };
}

async function writeDefinition(path: string): Promise<void> {
    await writeFile(
        path,
        `import { Type } from "typebox";\nimport { defineExtensionSettings } from ${JSON.stringify(definitionImport)};\nexport default defineExtensionSettings({ id: "pi-errors", title: "Errors", description: "Error fixture settings.", schema: Type.Object({ enabled: Type.Boolean({ default: true, description: "Enable it." }) }, { additionalProperties: false }) });\n`,
    );
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("project discovery failures and options", () => {
    it("reports missing and malformed root package files", async () => {
        const missingRoot = await temporaryProject();
        expect(Result.isError(await discoverSettingsProjects(missingRoot))).toBe(true);

        const malformedRoot = await temporaryProject();
        await writeFile(join(malformedRoot, "package.json"), "not json");
        expect(Result.isError(await discoverSettingsProjects(malformedRoot))).toBe(true);
    });

    it.each([
        ["non-object manifest", { piExtensionSettings: true }],
        ["missing definition", { piExtensionSettings: { schema: "config.schema.json" } }],
        ["absolute definition", { piExtensionSettings: { definition: "/tmp/settings.mjs" } }],
    ])("rejects %s", async (_label, packageJson) => {
        const root = await temporaryProject();
        await writeFile(join(root, "package.json"), JSON.stringify(packageJson));
        expect(Result.isError(await discoverSettingsProjects(root))).toBe(true);
    });

    it("supports object-form workspaces and custom global display paths", async () => {
        const root = await temporaryProject();
        const child = join(root, "packages", "child");
        await mkdir(child, { recursive: true });
        await writeFile(
            join(root, "package.json"),
            JSON.stringify({ workspaces: { packages: ["packages/*"] } }),
        );
        await writeFile(
            join(child, "package.json"),
            JSON.stringify({
                piExtensionSettings: {
                    definition: "settings.mjs",
                    globalPath: "$PI_AGENT_DIR/extension-settings/pi-errors.json",
                },
            }),
        );
        await writeDefinition(join(child, "settings.mjs"));

        const discovered = await discoverSettingsProjects(root);

        expect(Result.isOk(discovered)).toBe(true);
        if (Result.isError(discovered)) return;
        expect(discovered.value[0]?.targets.globalPath).toBe(
            "$PI_AGENT_DIR/extension-settings/pi-errors.json",
        );
    });

    it("reports definition import failures", async () => {
        const root = await temporaryProject();
        await writeFile(
            join(root, "package.json"),
            JSON.stringify({ piExtensionSettings: { definition: "settings.mjs" } }),
        );
        await writeFile(join(root, "settings.mjs"), 'throw new Error("module failed");\n');

        const discovered = await discoverSettingsProjects(root);
        expect(Result.isError(discovered)).toBe(true);
        if (Result.isOk(discovered)) return;
        expect(discovered.error.message).toContain("could not be imported");
        expect(discovered.error.message).not.toContain("module failed");
    });
});

describe("CLI failure behavior", () => {
    it("accepts explicit help and rejects incomplete root options", async () => {
        const help = recordingIo();
        expect(await runCli(["check", "--help"], help.io)).toBe(0);
        expect(help.out.join("")).toContain("Usage:");

        const invalid = recordingIo();
        expect(await runCli(["check", "--root"], invalid.io)).toBe(2);
    });

    it("reports discovery and artifact failures", async () => {
        const missing = await temporaryProject();
        const discoveryOutput = recordingIo();
        expect(await runCli(["check", "--root", missing], discoveryOutput.io)).toBe(1);
        expect(discoveryOutput.err.join("")).toContain("package.json");

        const root = await temporaryProject();
        await writeFile(
            join(root, "package.json"),
            JSON.stringify({ piExtensionSettings: { definition: "settings.mjs" } }),
        );
        await writeDefinition(join(root, "settings.mjs"));
        await writeFile(join(root, "README.md"), "# No markers\n");

        const generateOutput = recordingIo();
        expect(await runCli(["generate", "--root", root], generateOutput.io)).toBe(1);
        expect(generateOutput.err.join("")).toContain("markers");

        const checkOutput = recordingIo();
        expect(await runCli(["check", "--root", root], checkOutput.io)).toBe(1);
        expect(checkOutput.err.join("")).toContain("markers");
    });
});
