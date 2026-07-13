import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatJson } from "../src/json-value.ts";
import { resolveGlobalSettingsPaths, resolveProjectSettingsPaths } from "../src/paths.ts";
import { loadExtensionSettingsSync } from "../src/runtime.ts";
import { createSettingsFileSchema } from "../src/schema-document.ts";
import { testDefinition } from "./fixture.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
    const path = mkdtempSync(join(tmpdir(), "pi-extension-settings-sync-"));
    temporaryDirectories.push(path);
    return path;
}

function bundledSchema() {
    return {
        kind: "content" as const,
        content: formatJson(createSettingsFileSchema(testDefinition())),
    };
}

afterEach(() => {
    for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true });
});

describe("loadExtensionSettingsSync", () => {
    it("scaffolds and resolves global plus trusted project settings", () => {
        const root = temporaryDirectory();
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        const projectPaths = resolveProjectSettingsPaths(cwd, ".pi", "pi-example");
        mkdirSync(join(cwd, ".pi", "extension-settings"), { recursive: true });
        writeFileSync(projectPaths.configPath, JSON.stringify({ appearance: { color: "red" } }));

        const loaded = loadExtensionSettingsSync(testDefinition(), {
            agentDir,
            bundledSchema: bundledSchema(),
            project: { cwd, configDirName: ".pi", trusted: true },
        });
        const globalPaths = resolveGlobalSettingsPaths(agentDir, "pi-example");

        expect(loaded.settings.appearance).toEqual({ color: "red", opacity: 0.8 });
        expect(loaded.usedProjectConfig).toBe(true);
        expect(loaded.projectSettingsLayer).toEqual({ appearance: { color: "red" } });
        expect(loaded.globalSettingsLayer).toEqual(testDefinition().defaultSettings);
        expect(loaded.scaffoldedGlobalConfig).toBe(true);
        expect(readFileSync(globalPaths.schemaPath, "utf8")).toBe(bundledSchema().content);
    });

    it("recognizes unchanged schema and config artifacts on later loads", () => {
        const agentDir = temporaryDirectory();
        const options = { agentDir, bundledSchema: bundledSchema() };
        loadExtensionSettingsSync(testDefinition(), options);

        const loaded = loadExtensionSettingsSync(testDefinition(), options);

        expect(loaded.schemaStatus).toBe("unchanged");
        expect(loaded.scaffoldedGlobalConfig).toBe(false);
    });

    it("preserves malformed global settings and returns defaults", () => {
        const agentDir = temporaryDirectory();
        const paths = resolveGlobalSettingsPaths(agentDir, "pi-example");
        mkdirSync(join(agentDir, "extension-settings"), { recursive: true });
        writeFileSync(paths.configPath, "{ malformed");

        const loaded = loadExtensionSettingsSync(testDefinition(), {
            agentDir,
            bundledSchema: bundledSchema(),
        });

        expect(loaded.settings.enabled).toBe(true);
        expect(loaded.diagnostics).toContainEqual(
            expect.objectContaining({ code: "config-malformed" }),
        );
        expect(readFileSync(paths.configPath, "utf8")).toBe("{ malformed");
    });

    it("reports synchronous schema installation and config read failures", () => {
        const schemaRoot = temporaryDirectory();
        mkdirSync(join(schemaRoot, "extension-settings"), { recursive: true });
        writeFileSync(join(schemaRoot, "extension-settings", "schemas"), "blocked");
        const schemaFailure = loadExtensionSettingsSync(testDefinition(), {
            agentDir: schemaRoot,
            bundledSchema: bundledSchema(),
        });
        expect(schemaFailure.diagnostics).toContainEqual(
            expect.objectContaining({ code: "schema-install-failed" }),
        );

        const configRoot = temporaryDirectory();
        const configPaths = resolveGlobalSettingsPaths(configRoot, "pi-example");
        mkdirSync(configPaths.configPath, { recursive: true });
        const configFailure = loadExtensionSettingsSync(testDefinition(), {
            agentDir: configRoot,
            bundledSchema: bundledSchema(),
        });
        expect(configFailure.diagnostics).toContainEqual(
            expect.objectContaining({ code: "config-read-failed" }),
        );
    });

    it("reports stale and unreadable bundled schemas", () => {
        const stale = loadExtensionSettingsSync(testDefinition(), {
            agentDir: temporaryDirectory(),
            bundledSchema: { kind: "content", content: "{}\n" },
        });
        expect(stale.diagnostics).toContainEqual(
            expect.objectContaining({ code: "bundled-schema-stale" }),
        );

        const missing = loadExtensionSettingsSync(testDefinition(), {
            agentDir: temporaryDirectory(),
            bundledSchema: { kind: "url", url: new URL("file:///missing/schema.json") },
        });
        expect(missing.diagnostics).toContainEqual(
            expect.objectContaining({ code: "bundled-schema-read-failed" }),
        );
    });
});
