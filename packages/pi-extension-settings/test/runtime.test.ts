import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatJson } from "../src/json-value.ts";
import { resolveGlobalSettingsPaths, resolveProjectSettingsPaths } from "../src/paths.ts";
import { loadExtensionSettings } from "../src/runtime.ts";
import { createSettingsFileSchema } from "../src/schema-document.ts";
import { testDefinition } from "./fixture.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "pi-extension-settings-"));
    temporaryDirectories.push(path);
    return path;
}

function bundledSchema() {
    return {
        kind: "content" as const,
        content: formatJson(createSettingsFileSchema(testDefinition())),
    };
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("loadExtensionSettings", () => {
    it("scaffolds defaults and the editor schema on first load", async () => {
        const agentDir = await temporaryDirectory();
        const definition = testDefinition();
        const loaded = await loadExtensionSettings(definition, {
            agentDir,
            bundledSchema: bundledSchema(),
        });
        const paths = resolveGlobalSettingsPaths(agentDir, definition.id);

        expect(loaded.settings).toEqual(definition.defaultSettings);
        expect(loaded.diagnostics).toEqual([]);
        expect(loaded.scaffoldedGlobalConfig).toBe(true);
        expect(loaded.schemaStatus).toBe("created");
        expect(JSON.parse(await readFile(paths.configPath, "utf8"))).toEqual({
            $schema: "./schemas/pi-example.schema.json",
            ...definition.defaultSettings,
        });
        expect(await readFile(paths.schemaPath, "utf8")).toBe(bundledSchema().content);
    });

    it("concurrently scaffolds one complete global settings file", async () => {
        const agentDir = await temporaryDirectory();
        const definition = testDefinition();

        const loads = await Promise.all(
            Array.from({ length: 16 }, () =>
                loadExtensionSettings(definition, {
                    agentDir,
                    bundledSchema: bundledSchema(),
                }),
            ),
        );

        for (const loaded of loads) {
            expect(loaded.settings).toEqual(definition.defaultSettings);
            expect(loaded.diagnostics).toEqual([]);
        }
        expect(loads.filter((loaded) => loaded.scaffoldedGlobalConfig)).toHaveLength(1);

        const paths = resolveGlobalSettingsPaths(agentDir, definition.id);
        expect(JSON.parse(await readFile(paths.configPath, "utf8"))).toEqual({
            $schema: "./schemas/pi-example.schema.json",
            ...definition.defaultSettings,
        });
    });

    it("applies partial global settings and refreshes only the stale schema", async () => {
        const agentDir = await temporaryDirectory();
        const definition = testDefinition();
        const paths = resolveGlobalSettingsPaths(agentDir, definition.id);
        await mkdir(join(agentDir, "extension-settings", "schemas"), { recursive: true });
        const custom = `${JSON.stringify({
            $schema: "./schemas/pi-example.schema.json",
            enabled: false,
            appearance: { color: "red" },
        })}\n`;
        await writeFile(paths.configPath, custom);
        await writeFile(paths.schemaPath, "stale schema\n");

        const loaded = await loadExtensionSettings(definition, {
            agentDir,
            bundledSchema: bundledSchema(),
        });

        expect(loaded.settings).toEqual({
            enabled: false,
            mode: "compact",
            appearance: { color: "red", opacity: 0.8 },
            tools: ["read"],
        });
        expect(loaded.usedGlobalConfig).toBe(true);
        expect(loaded.scaffoldedGlobalConfig).toBe(false);
        expect(loaded.schemaStatus).toBe("updated");
        expect(await readFile(paths.configPath, "utf8")).toBe(custom);
        expect(await readFile(paths.schemaPath, "utf8")).toBe(bundledSchema().content);
    });

    it("layers trusted project settings without creating project files", async () => {
        const root = await temporaryDirectory();
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        const projectPaths = resolveProjectSettingsPaths(cwd, ".pi", "pi-example");
        await mkdir(join(cwd, ".pi", "extension-settings"), { recursive: true });
        await writeFile(
            projectPaths.configPath,
            JSON.stringify({ appearance: { opacity: 0.25 }, tools: ["bash"] }),
        );

        const loaded = await loadExtensionSettings(testDefinition(), {
            agentDir,
            bundledSchema: bundledSchema(),
            project: { cwd, configDirName: ".pi", trusted: true },
        });

        expect(loaded.settings).toMatchObject({
            appearance: { color: "blue", opacity: 0.25 },
            tools: ["bash"],
        });
        expect(loaded.usedProjectConfig).toBe(true);
        expect(loaded.projectSettingsLayer).toEqual({
            appearance: { opacity: 0.25 },
            tools: ["bash"],
        });
        await expect(readFile(projectPaths.schemaPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("ignores project settings when the project is not trusted", async () => {
        const root = await temporaryDirectory();
        const cwd = join(root, "project");
        const projectPaths = resolveProjectSettingsPaths(cwd, ".pi", "pi-example");
        await mkdir(join(cwd, ".pi", "extension-settings"), { recursive: true });
        await writeFile(projectPaths.configPath, JSON.stringify({ enabled: false }));

        const loaded = await loadExtensionSettings(testDefinition(), {
            agentDir: join(root, "agent"),
            bundledSchema: bundledSchema(),
            project: { cwd, configDirName: ".pi", trusted: false },
        });

        expect(loaded.settings.enabled).toBe(true);
        expect(loaded.usedProjectConfig).toBe(false);
    });

    it("preserves and ignores malformed user settings", async () => {
        const agentDir = await temporaryDirectory();
        const paths = resolveGlobalSettingsPaths(agentDir, "pi-example");
        await mkdir(join(agentDir, "extension-settings"), { recursive: true });
        await writeFile(paths.configPath, "{ malformed");

        const loaded = await loadExtensionSettings(testDefinition(), {
            agentDir,
            bundledSchema: bundledSchema(),
        });

        expect(loaded.settings.enabled).toBe(true);
        expect(loaded.diagnostics).toContainEqual(
            expect.objectContaining({ code: "config-malformed", scope: "global" }),
        );
        expect(await readFile(paths.configPath, "utf8")).toBe("{ malformed");
    });

    it("reports schema violations without exposing raw values", async () => {
        const agentDir = await temporaryDirectory();
        const paths = resolveGlobalSettingsPaths(agentDir, "pi-example");
        await mkdir(join(agentDir, "extension-settings"), { recursive: true });
        await writeFile(paths.configPath, JSON.stringify({ secretTypo: "do-not-report" }));

        const loaded = await loadExtensionSettings(testDefinition(), {
            agentDir,
            bundledSchema: bundledSchema(),
        });
        const diagnostic = loaded.diagnostics.find((item) => item.code === "config-invalid");

        expect(diagnostic?.issues).toBeDefined();
        expect(loaded.globalSettingsLayer).toBeUndefined();
        expect(loaded.projectSettingsLayer).toBeUndefined();
        expect(JSON.stringify(diagnostic)).not.toContain("do-not-report");
        expect(await readFile(paths.configPath, "utf8")).toContain("do-not-report");
    });

    it("does not scaffold from a stale bundled schema", async () => {
        const agentDir = await temporaryDirectory();
        const loaded = await loadExtensionSettings(testDefinition(), {
            agentDir,
            bundledSchema: { kind: "content", content: "{}\n" },
        });
        const paths = resolveGlobalSettingsPaths(agentDir, "pi-example");

        expect(loaded.schemaStatus).toBe("unavailable");
        expect(loaded.diagnostics).toContainEqual(
            expect.objectContaining({ code: "bundled-schema-stale" }),
        );
        await expect(readFile(paths.configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("reports an unreadable bundled schema URL", async () => {
        const agentDir = await temporaryDirectory();
        const loaded = await loadExtensionSettings(testDefinition(), {
            agentDir,
            bundledSchema: { kind: "url", url: new URL("file:///does/not/exist/schema.json") },
        });

        expect(loaded.diagnostics).toContainEqual(
            expect.objectContaining({ code: "bundled-schema-read-failed" }),
        );
    });

    it("falls back safely when the config path cannot be read", async () => {
        const agentDir = await temporaryDirectory();
        const paths = resolveGlobalSettingsPaths(agentDir, "pi-example");
        await mkdir(paths.configPath, { recursive: true });

        const loaded = await loadExtensionSettings(testDefinition(), {
            agentDir,
            bundledSchema: bundledSchema(),
        });

        expect(loaded.settings.enabled).toBe(true);
        expect(loaded.diagnostics).toContainEqual(
            expect.objectContaining({ code: "config-read-failed" }),
        );
    });
});
