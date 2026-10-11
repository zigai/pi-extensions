import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Codec, Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { defineExtensionSettings } from "../src/definition.ts";
import { formatJson } from "../src/json-value.ts";
import { resolveGlobalSettingsPaths, resolveProjectSettingsPaths } from "../src/paths.ts";
import { loadSettings } from "../src/settings-loader.ts";
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
    await Promise.all(
        temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
    );
});

describe("loadSettings", () => {
    it("scaffolds defaults and the editor schema on first load", async () => {
        const agentDir = await temporaryDirectory();
        const definition = testDefinition();
        const loaded = loadSettings(definition, {
            agentDir,
            bundledSchema: bundledSchema(),
        });
        const paths = resolveGlobalSettingsPaths(agentDir, definition.id);

        expect(loaded.settings).toEqual(definition.defaultSettings);
        expect(loaded.diagnostics).toEqual([]);
        expect(loaded.scaffoldedGlobalConfig).toBe(true);
        expect(loaded.schemaStatus).toBe("created");
        expect(loaded.globalRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(loaded.projectRevision).toBeUndefined();
        expect(JSON.parse(await readFile(paths.configPath, "utf8"))).toEqual({
            $schema: "./schemas/pi-example.schema.json",
            ...definition.defaultSettings,
        });

        expect(await readFile(paths.schemaPath, "utf8")).toBe(bundledSchema().content);
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

        const loaded = loadSettings(definition, {
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

        const loaded = loadSettings(testDefinition(), {
            agentDir,
            bundledSchema: bundledSchema(),
            project: { cwd, configDirName: ".pi", trusted: true },
        });

        expect(loaded.settings).toMatchObject({
            appearance: { color: "blue", opacity: 0.25 },
            tools: ["bash"],
        });

        expect(loaded.usedProjectConfig).toBe(true);
        expect(loaded.projectRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
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

        const loaded = loadSettings(testDefinition(), {
            agentDir: join(root, "agent"),
            bundledSchema: bundledSchema(),
            project: { cwd, configDirName: ".pi", trusted: false },
        });

        expect(loaded.settings.enabled).toBe(true);
        expect(loaded.usedProjectConfig).toBe(false);
        expect(loaded.projectRevision).toBeUndefined();
    });

    it("preserves and ignores malformed user settings", async () => {
        const agentDir = await temporaryDirectory();
        const paths = resolveGlobalSettingsPaths(agentDir, "pi-example");
        await mkdir(join(agentDir, "extension-settings"), { recursive: true });
        await writeFile(paths.configPath, "{ malformed");

        const loaded = loadSettings(testDefinition(), {
            agentDir,
            bundledSchema: bundledSchema(),
        });

        expect(loaded.settings.enabled).toBe(true);
        expect(loaded.diagnostics).toContainEqual(
            expect.objectContaining({ code: "config-malformed", scope: "global" }),
        );

        expect(loaded.globalRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(await readFile(paths.configPath, "utf8")).toBe("{ malformed");
    });

    it("reports schema violations without exposing raw values", async () => {
        const agentDir = await temporaryDirectory();
        const paths = resolveGlobalSettingsPaths(agentDir, "pi-example");
        await mkdir(join(agentDir, "extension-settings"), { recursive: true });
        await writeFile(paths.configPath, JSON.stringify({ secretTypo: "do-not-report" }));

        const loaded = loadSettings(testDefinition(), {
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
        const loaded = loadSettings(testDefinition(), {
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
        const loaded = loadSettings(testDefinition(), {
            agentDir,
            bundledSchema: { kind: "url", url: new URL("file:///does/not/exist/schema.json") },
        });

        expect(loaded.diagnostics).toContainEqual(
            expect.objectContaining({ code: "bundled-schema-read-failed" }),
        );
    });

    it("decodes mixed unions without mutating the definition", async () => {
        const definition = defineExtensionSettings({
            id: "pi-union",
            title: "Union",
            description: "Mixed union settings.",
            schema: Type.Object(
                {
                    color: Type.Union([Type.Integer(), Type.String()], {
                        default: "blue",
                        description: "Color name or ANSI index.",
                    }),
                },
                { additionalProperties: false },
            ),
        });

        const loaded = loadSettings(definition, {
            agentDir: await temporaryDirectory(),
            bundledSchema: {
                kind: "content",
                content: formatJson(createSettingsFileSchema(definition)),
            },
        });

        expect(loaded.settings.color).toBe("blue");
    });

    it("keeps accepted layers encoded and decodes only resolved runtime settings", async () => {
        const definition = defineExtensionSettings({
            id: "pi-codec",
            title: "Codec",
            description: "Codec-backed settings.",
            schema: Type.Object(
                {
                    value: Codec(Type.String({ default: "default", description: "Encoded value." }))
                        .Decode((value) => `decoded:${value}`)
                        .Encode((value) => value.replace(/^decoded:/, "")),
                },
                { additionalProperties: false },
            ),
        });
        const agentDir = await temporaryDirectory();
        const paths = resolveGlobalSettingsPaths(agentDir, definition.id);
        await mkdir(join(agentDir, "extension-settings"), { recursive: true });
        await writeFile(paths.configPath, JSON.stringify({ value: "custom" }));

        const loaded = loadSettings(definition, {
            agentDir,
            bundledSchema: {
                kind: "content",
                content: formatJson(createSettingsFileSchema(definition)),
            },
        });

        expect(loaded.globalSettingsLayer).toEqual({ value: "custom" });
        expect(loaded.settings.value).toBe("decoded:custom");
    });

    it("ignores a validated layer when the resolved codec rejects it", async () => {
        const definition = defineExtensionSettings({
            id: "pi-rejecting-codec",
            title: "Rejecting codec",
            description: "Codec rejection settings.",
            schema: Type.Object(
                {
                    value: Codec(Type.String({ default: "default", description: "Encoded value." }))
                        .Decode((value) => {
                            if (value === "rejected-secret") throw new Error(value);
                            return `decoded:${value}`;
                        })
                        .Encode((value) => value.replace(/^decoded:/, "")),
                },
                { additionalProperties: false },
            ),
        });
        const agentDir = await temporaryDirectory();
        const paths = resolveGlobalSettingsPaths(agentDir, definition.id);
        await mkdir(join(agentDir, "extension-settings"), { recursive: true });
        await writeFile(paths.configPath, JSON.stringify({ value: "rejected-secret" }));

        const loaded = loadSettings(definition, {
            agentDir,
            bundledSchema: {
                kind: "content",
                content: formatJson(createSettingsFileSchema(definition)),
            },
        });

        expect(loaded.settings.value).toBe("decoded:default");
        expect(loaded.usedGlobalConfig).toBe(false);
        expect(loaded.globalSettingsLayer).toBeUndefined();
        expect(loaded.diagnostics).toContainEqual(
            expect.objectContaining({ code: "config-decode-failed", scope: "global" }),
        );

        expect(JSON.stringify(loaded.diagnostics)).not.toContain("rejected-secret");
        expect(await readFile(paths.configPath, "utf8")).toContain("rejected-secret");
    });

    it("drops only a project layer when its resolved codec rejects", async () => {
        const definition = defineExtensionSettings({
            id: "pi-project-codec",
            title: "Project codec",
            description: "Project codec rejection settings.",
            schema: Type.Object(
                {
                    value: Codec(Type.String({ default: "default", description: "Encoded value." }))
                        .Decode((value) => {
                            if (value === "rejected") throw new Error("rejected");
                            return `decoded:${value}`;
                        })
                        .Encode((value) => value.replace(/^decoded:/, "")),
                },
                { additionalProperties: false },
            ),
        });
        const agentDir = await temporaryDirectory();
        const project = join(agentDir, "project");
        const projectPaths = resolveProjectSettingsPaths(project, ".pi", definition.id);
        await mkdir(join(project, ".pi", "extension-settings"), { recursive: true });
        await writeFile(projectPaths.configPath, JSON.stringify({ value: "rejected" }));

        const loaded = loadSettings(definition, {
            agentDir,
            bundledSchema: {
                kind: "content",
                content: formatJson(createSettingsFileSchema(definition)),
            },
            project: { cwd: project, configDirName: ".pi", trusted: true },
        });

        expect(loaded.settings.value).toBe("decoded:default");
        expect(loaded.usedGlobalConfig).toBe(true);
        expect(loaded.usedProjectConfig).toBe(false);
        expect(loaded.diagnostics).toContainEqual(
            expect.objectContaining({ code: "config-decode-failed", scope: "project" }),
        );
    });

    it("treats a codec that rejects validated defaults as a definition defect", async () => {
        let decodeCalls = 0;
        const definition = defineExtensionSettings({
            id: "pi-default-codec-defect",
            title: "Default codec defect",
            description: "Stateful codec defect settings.",
            schema: Type.Object(
                {
                    value: Codec(Type.String({ default: "default", description: "Value." }))
                        .Decode((value) => {
                            decodeCalls += 1;
                            if (decodeCalls > 1) throw new Error("stateful failure");
                            return value;
                        })
                        .Encode((value) => value),
                },
                { additionalProperties: false },
            ),
        });
        const agentDir = await temporaryDirectory();

        expect(() =>
            loadSettings(definition, {
                agentDir,
                bundledSchema: {
                    kind: "content",
                    content: formatJson(createSettingsFileSchema(definition)),
                },
            }),
        ).toThrow("Validated default settings could not be decoded");
    });

    it("redacts private parent keys when rejecting unsupported properties on disk", async () => {
        const agentDir = await temporaryDirectory();
        const definition = defineExtensionSettings({
            id: "pi-private",
            title: "Private settings",
            description: "Settings for a private record.",
            schemaId: "urn:example:private",
            schema: Type.Object(
                {
                    profiles: Type.Record(
                        Type.String(),
                        Type.Object(
                            { enabled: Type.Boolean() },
                            { additionalProperties: false, title: "Profile" },
                        ),
                        { default: {}, description: "Named profiles." },
                    ),
                },
                { additionalProperties: false },
            ),
        });
        const paths = resolveGlobalSettingsPaths(agentDir, definition.id);
        const content = '{"profiles":{"private-token":{"constructor":true}}}';
        await mkdir(join(agentDir, "extension-settings"), { recursive: true });
        await writeFile(paths.configPath, content);

        const loaded = loadSettings(definition, {
            agentDir,
            bundledSchema: {
                kind: "content",
                content: formatJson(createSettingsFileSchema(definition)),
            },
        });

        expect(loaded.usedGlobalConfig).toBe(false);
        expect(loaded.settings).toEqual({ profiles: {} });
        expect(loaded.diagnostics).toEqual([
            expect.objectContaining({
                code: "config-invalid",
                scope: "global",
                issues: [
                    { path: "/profiles/<key>/constructor", message: "Unsupported property name" },
                ],
            }),
        ]);

        expect(JSON.stringify(loaded.diagnostics)).not.toContain("private-token");
        expect(await readFile(paths.configPath, "utf8")).toBe(content);
    });

    it("rejects unsupported property names without changing the file", async () => {
        const agentDir = await temporaryDirectory();
        const paths = resolveGlobalSettingsPaths(agentDir, "pi-example");
        await mkdir(join(agentDir, "extension-settings"), { recursive: true });
        const content = '{"constructor":{"secret":"kept"}}';
        await writeFile(paths.configPath, content);

        const loaded = loadSettings(testDefinition(), {
            agentDir,
            bundledSchema: bundledSchema(),
        });

        expect(loaded.usedGlobalConfig).toBe(false);
        expect(loaded.diagnostics).toContainEqual(
            expect.objectContaining({ code: "config-invalid", scope: "global" }),
        );

        expect(JSON.stringify(loaded.diagnostics)).not.toContain("kept");
        expect(await readFile(paths.configPath, "utf8")).toBe(content);
    });

    it("falls back safely when the config path cannot be read", async () => {
        const agentDir = await temporaryDirectory();
        const paths = resolveGlobalSettingsPaths(agentDir, "pi-example");
        await mkdir(paths.configPath, { recursive: true });

        const loaded = loadSettings(testDefinition(), {
            agentDir,
            bundledSchema: bundledSchema(),
        });

        expect(loaded.settings.enabled).toBe(true);
        expect(loaded.diagnostics).toContainEqual(
            expect.objectContaining({ code: "config-read-failed" }),
        );

        expect(loaded.globalRevision).toBeUndefined();
    });
});
