import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatJson } from "../src/json-value.ts";
import { resolveProjectSettingsPaths } from "../src/paths.ts";
import { loadSettings } from "../src/settings-loader.ts";
import { createSettingsFileSchema } from "../src/schema-document.ts";
import { testDefinition } from "./fixture.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "pi-settings-runtime-errors-"));
    temporaryDirectories.push(path);
    return path;
}

function schemaContent(): string {
    return formatJson(createSettingsFileSchema(testDefinition()));
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("settings loader failure isolation", () => {
    it("reports schema installation failures and still returns defaults", async () => {
        const agentDir = await temporaryDirectory();
        await mkdir(join(agentDir, "extension-settings"), { recursive: true });
        await writeFile(join(agentDir, "extension-settings", "schemas"), "blocks directory");

        const loaded = loadSettings(testDefinition(), {
            agentDir,
            bundledSchema: { kind: "content", content: schemaContent() },
        });

        expect(loaded.schemaStatus).toBe("unavailable");
        expect(loaded.settings.enabled).toBe(true);
        expect(loaded.diagnostics).toContainEqual(
            expect.objectContaining({ code: "schema-install-failed" }),
        );
    });

    it("recognizes an unchanged installed schema on later loads", async () => {
        const agentDir = await temporaryDirectory();
        const options = {
            agentDir,
            bundledSchema: { kind: "content" as const, content: schemaContent() },
        };
        loadSettings(testDefinition(), options);

        const loaded = loadSettings(testDefinition(), options);

        expect(loaded.schemaStatus).toBe("unchanged");
        expect(loaded.scaffoldedGlobalConfig).toBe(false);
    });

    it("loads a verified bundled schema from a file URL", async () => {
        const root = await temporaryDirectory();
        const sourcePath = join(root, "bundled.schema.json");
        await writeFile(sourcePath, schemaContent());

        const loaded = loadSettings(testDefinition(), {
            agentDir: join(root, "agent"),
            bundledSchema: { kind: "url", url: new URL(`file://${sourcePath}`) },
        });

        expect(loaded.schemaStatus).toBe("created");
        expect(loaded.diagnostics).toEqual([]);
    });

    it("reports and ignores invalid trusted project settings", async () => {
        const root = await temporaryDirectory();
        const cwd = join(root, "project");
        const paths = resolveProjectSettingsPaths(cwd, ".pi", "pi-example");
        await mkdir(join(cwd, ".pi", "extension-settings"), { recursive: true });
        await writeFile(paths.configPath, JSON.stringify({ appearance: { opacity: 2 } }));

        const loaded = loadSettings(testDefinition(), {
            agentDir: join(root, "agent"),
            bundledSchema: { kind: "content", content: schemaContent() },
            project: { cwd, configDirName: ".pi", trusted: true },
        });

        expect(loaded.usedProjectConfig).toBe(false);
        expect(loaded.settings.appearance.opacity).toBe(0.8);
        expect(loaded.diagnostics).toContainEqual(
            expect.objectContaining({ code: "config-invalid", scope: "project" }),
        );
    });
});
