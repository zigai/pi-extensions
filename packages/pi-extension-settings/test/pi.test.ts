import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { formatJson } from "../src/json-value.ts";
import { resolveGlobalSettingsPaths, resolveProjectSettingsPaths } from "../src/paths.ts";
import { loadPiExtensionSettings, loadPiExtensionSettingsSync } from "../src/pi.ts";
import { createSettingsFileSchema } from "../src/schema-document.ts";
import { testDefinition } from "./fixture.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "pi-settings-adapter-"));
    temporaryDirectories.push(path);
    return path;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("loadPiExtensionSettings", () => {
    it("adapts Pi paths and project trust into the core loader", async () => {
        const root = await temporaryDirectory();
        const cwd = join(root, "project");
        const paths = resolveProjectSettingsPaths(cwd, CONFIG_DIR_NAME, "pi-example");
        await mkdir(join(cwd, CONFIG_DIR_NAME, "extension-settings"), { recursive: true });
        await writeFile(paths.configPath, JSON.stringify({ enabled: false }));
        const definition = testDefinition();

        const loaded = await loadPiExtensionSettings(
            definition,
            { cwd, isProjectTrusted: () => true },
            {
                agentDir: join(root, "agent"),
                bundledSchema: {
                    kind: "content",
                    content: formatJson(createSettingsFileSchema(definition)),
                },
            },
        );

        expect(loaded.settings.enabled).toBe(false);
        expect(loaded.usedProjectConfig).toBe(true);

        const synchronous = loadPiExtensionSettingsSync(
            definition,
            { cwd, isProjectTrusted: () => true },
            {
                agentDir: join(root, "sync-agent"),
                bundledSchema: {
                    kind: "content",
                    content: formatJson(createSettingsFileSchema(definition)),
                },
            },
        );
        expect(synchronous.settings.enabled).toBe(false);
        expect(synchronous.usedProjectConfig).toBe(true);
    });

    it("migrates historical per-extension config without overwriting central settings", async () => {
        const root = await temporaryDirectory();
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        const legacyGlobalPath = join(agentDir, "pi-example", "config.json");
        const legacyProjectPath = join(cwd, CONFIG_DIR_NAME, "pi-old-example", "config.json");
        await mkdir(join(agentDir, "pi-example"), { recursive: true });
        await mkdir(join(cwd, CONFIG_DIR_NAME, "pi-old-example"), { recursive: true });
        await writeFile(legacyGlobalPath, JSON.stringify({ enabled: false }));
        await writeFile(legacyProjectPath, JSON.stringify({ mode: "expanded" }));
        const definition = testDefinition();

        const loaded = await loadPiExtensionSettings(
            definition,
            { cwd, isProjectTrusted: () => true },
            {
                agentDir,
                legacySettingsIds: ["pi-old-example"],
                bundledSchema: {
                    kind: "content",
                    content: formatJson(createSettingsFileSchema(definition)),
                },
            },
        );

        expect(loaded.settings).toMatchObject({ enabled: false, mode: "expanded" });
        await expect(readFile(loaded.globalConfigPath, "utf8")).resolves.toBe(
            formatJson({
                $schema: "./schemas/pi-example.schema.json",
                enabled: false,
            }),
        );
        await expect(readFile(loaded.projectConfigPath!, "utf8")).resolves.toBe(
            formatJson({
                $schema: definition.schemaId,
                mode: "expanded",
            }),
        );

        await writeFile(loaded.globalConfigPath, JSON.stringify({ enabled: true }));
        const reloaded = loadPiExtensionSettingsSync(
            definition,
            { cwd, isProjectTrusted: () => false },
            {
                agentDir,
                bundledSchema: {
                    kind: "content",
                    content: formatJson(createSettingsFileSchema(definition)),
                },
            },
        );
        expect(reloaded.settings.enabled).toBe(true);
    });

    it("migrates legacy config through the synchronous adapter", async () => {
        const root = await temporaryDirectory();
        const agentDir = join(root, "agent");
        const legacyPath = join(agentDir, "pi-example", "config.json");
        await mkdir(join(agentDir, "pi-example"), { recursive: true });
        await writeFile(legacyPath, JSON.stringify({ enabled: false }));
        const definition = testDefinition();

        const loaded = loadPiExtensionSettingsSync(
            definition,
            { cwd: root, isProjectTrusted: () => false },
            {
                agentDir,
                bundledSchema: {
                    kind: "content",
                    content: formatJson(createSettingsFileSchema(definition)),
                },
            },
        );

        expect(loaded.settings.enabled).toBe(false);
        await expect(readFile(loaded.globalConfigPath, "utf8")).resolves.toBe(
            formatJson({
                $schema: "./schemas/pi-example.schema.json",
                enabled: false,
            }),
        );
    });

    it("preserves malformed legacy bytes while migrating to the central path", async () => {
        const root = await temporaryDirectory();
        const agentDir = join(root, "agent");
        const legacyPath = join(agentDir, "pi-example", "config.json");
        await mkdir(join(agentDir, "pi-example"), { recursive: true });
        await writeFile(legacyPath, "{ malformed");
        const definition = testDefinition();

        const loaded = loadPiExtensionSettingsSync(
            definition,
            { cwd: root, isProjectTrusted: () => false },
            {
                agentDir,
                bundledSchema: {
                    kind: "content",
                    content: formatJson(createSettingsFileSchema(definition)),
                },
            },
        );

        await expect(readFile(loaded.globalConfigPath, "utf8")).resolves.toBe("{ malformed");
        expect(loaded.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "config-malformed" })]),
        );
    });

    it("reports unreadable legacy config in async and synchronous adapters", async () => {
        const definition = testDefinition();
        const schema = formatJson(createSettingsFileSchema(definition));
        const asyncRoot = await temporaryDirectory();
        const asyncAgentDir = join(asyncRoot, "agent");
        await mkdir(join(asyncAgentDir, "pi-example", "config.json"), { recursive: true });

        const asynchronous = await loadPiExtensionSettings(
            definition,
            { cwd: asyncRoot, isProjectTrusted: () => false },
            {
                agentDir: asyncAgentDir,
                bundledSchema: { kind: "content", content: schema },
            },
        );
        expect(asynchronous.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "config-migration-failed" })]),
        );

        const syncRoot = await temporaryDirectory();
        const syncAgentDir = join(syncRoot, "agent");
        await mkdir(join(syncAgentDir, "pi-example", "config.json"), { recursive: true });
        const synchronous = loadPiExtensionSettingsSync(
            definition,
            { cwd: syncRoot, isProjectTrusted: () => false },
            {
                agentDir: syncAgentDir,
                bundledSchema: { kind: "content", content: schema },
            },
        );
        expect(synchronous.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "config-migration-failed" })]),
        );

        const occupiedRoot = await temporaryDirectory();
        const occupiedAgentDir = join(occupiedRoot, "agent");
        const occupiedConfigPath = resolveGlobalSettingsPaths(
            occupiedAgentDir,
            "pi-example",
        ).configPath;
        await mkdir(occupiedConfigPath, { recursive: true });
        const occupied = await loadPiExtensionSettings(
            definition,
            { cwd: occupiedRoot, isProjectTrusted: () => false },
            {
                agentDir: occupiedAgentDir,
                bundledSchema: { kind: "content", content: schema },
            },
        );
        expect(occupied.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "config-migration-failed" })]),
        );
    });

    it("uses Pi's configured agent directory when no override is supplied", async () => {
        const root = await temporaryDirectory();
        const agentDir = join(root, "configured-agent");
        const previous = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        try {
            const definition = testDefinition();
            const loaded = loadPiExtensionSettingsSync(
                definition,
                { cwd: root, isProjectTrusted: () => false },
                {
                    bundledSchema: {
                        kind: "content",
                        content: formatJson(createSettingsFileSchema(definition)),
                    },
                },
            );
            expect(loaded.globalConfigPath).toContain("configured-agent");
        } finally {
            if (previous === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previous;
            }
        }
    });
});
