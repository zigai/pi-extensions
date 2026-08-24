import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Decode, Type, type TObject } from "typebox";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { defineExtensionSettings, type ExtensionSettingsDefinition } from "../src/definition.ts";
import { formatJson } from "../src/json-value.ts";
import { resolveGlobalSettingsPaths, resolveProjectSettingsPaths } from "../src/paths.ts";
import {
    getPiProjectSettingsPath,
    loadPiExtensionSettings,
    updatePiExtensionSettings,
    type PiSettingsContext,
} from "../src/pi.ts";
import { createSettingsFileSchema } from "../src/schema-document.ts";
import { updateSettingsTransaction } from "../src/settings-transaction.ts";
import { testDefinition } from "./fixture.ts";

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "pi-settings-transaction-"));
    temporaryDirectories.push(path);
    return path;
}

function restoreAgentDir(): void {
    if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
    } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
}

afterEach(async () => {
    restoreAgentDir();
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function definitionSetup<Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
    projectTrusted = true,
) {
    const root = await temporaryDirectory();
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    const context: PiSettingsContext = {
        cwd: join(root, "project"),
        isProjectTrusted: () => projectTrusted,
    };
    const bundledSchema = {
        kind: "content" as const,
        content: formatJson(createSettingsFileSchema(definition)),
    };
    const loaded = loadPiExtensionSettings(definition, context, { bundledSchema });
    return { root, definition, context, bundledSchema, loaded };
}

async function testSetup(projectTrusted = true) {
    return definitionSetup(testDefinition(), projectTrusted);
}

function dependentDefinition() {
    return defineExtensionSettings({
        id: "pi-dependent",
        title: "Dependent",
        description: "Settings with dependent values.",
        schema: Type.Object(
            {
                mode: Type.Union([Type.Literal("a"), Type.Literal("b")], {
                    default: "a",
                    description: "Coupled mode.",
                }),
                value: Type.Integer({ default: 1, description: "Coupled value." }),
            },
            {
                additionalProperties: false,
                not: {
                    required: ["mode", "value"],
                    properties: { mode: { const: "b" }, value: { const: 1 } },
                },
            },
        ),
    });
}

describe("settings transactions", () => {
    it("updates the latest global layer and preserves its mode and unrelated changes", async () => {
        const setup = await testSetup();
        const external = formatJson({
            $schema: "./schemas/pi-example.schema.json",
            ...setup.definition.defaultSettings,
            mode: "expanded",
        });
        await writeFile(setup.loaded.globalConfigPath, external);
        await chmod(setup.loaded.globalConfigPath, 0o640);

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => ({ ...current, enabled: false }),
        });

        expect(result.status).toBe("updated");
        if (result.status !== "updated") throw new Error("Expected updated settings");
        const reloaded = loadPiExtensionSettings(setup.definition, setup.context, {
            bundledSchema: setup.bundledSchema,
        });
        expect(reloaded.globalRevision).toBe(result.revision);
        expect(reloaded.settings).toMatchObject({ enabled: false, mode: "expanded" });
        expect((await stat(setup.loaded.globalConfigPath)).mode & 0o777).toBe(0o640);
        const directoryEntries = await readdir(dirname(setup.loaded.globalConfigPath));
        expect(directoryEntries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
        expect(directoryEntries.some((entry) => entry.endsWith(".lock"))).toBe(false);
    });

    it("creates a missing global file from the returned layer without materializing defaults", async () => {
        const setup = await testSetup();
        await rm(setup.loaded.globalConfigPath);

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => ({ ...current, enabled: false }),
        });

        expect(result.status).toBe("updated");
        const document: unknown = JSON.parse(await readFile(setup.loaded.globalConfigPath, "utf8"));
        expect(document).toEqual({
            $schema: "./schemas/pi-example.schema.json",
            enabled: false,
        });
        const reloaded = loadPiExtensionSettings(setup.definition, setup.context, {
            bundledSchema: setup.bundledSchema,
        });
        expect(reloaded.settings).toEqual({
            ...setup.definition.defaultSettings,
            enabled: false,
        });
    });

    it("rejects a stale snapshot without overwriting the newer file", async () => {
        const setup = await testSetup();
        expect(setup.loaded.globalRevision).toBeDefined();
        if (setup.loaded.globalRevision === undefined) throw new Error("Expected global revision");

        const external = formatJson({
            $schema: "./schemas/pi-example.schema.json",
            ...setup.definition.defaultSettings,
            mode: "expanded",
        });
        await writeFile(setup.loaded.globalConfigPath, external);
        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            expectedRevision: setup.loaded.globalRevision,
            update: (current) => ({ ...current, enabled: false }),
        });

        expect(result).toMatchObject({ status: "conflict", reason: "settings-changed" });
        expect(await readFile(setup.loaded.globalConfigPath, "utf8")).toBe(external);
    });

    it("refuses to overwrite malformed existing settings", async () => {
        const setup = await testSetup();
        await writeFile(setup.loaded.globalConfigPath, "{ malformed\n");

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => ({ ...current, enabled: false }),
        });

        expect(result.status).toBe("invalid-existing");
        expect(await readFile(setup.loaded.globalConfigPath, "utf8")).toBe("{ malformed\n");
    });

    it("rejects updates that violate the settings schema", async () => {
        const setup = await testSetup();
        const before = await readFile(setup.loaded.globalConfigPath, "utf8");

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => ({
                ...current,
                appearance: { ...current.appearance, opacity: 2 },
            }),
        });

        expect(result).toMatchObject({ status: "invalid-update" });
        expect(await readFile(setup.loaded.globalConfigPath, "utf8")).toBe(before);
    });

    it("rejects class instances even when their fields match the layer schema", async () => {
        const setup = await testSetup();
        const before = await readFile(setup.loaded.globalConfigPath, "utf8");

        class SettingsUpdate {
            readonly enabled = false;
        }

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: () => new SettingsUpdate(),
        });

        expect(result).toMatchObject({ status: "invalid-update" });
        expect(await readFile(setup.loaded.globalConfigPath, "utf8")).toBe(before);
    });

    it("rejects reserved metadata returned by an updater", async () => {
        const setup = await testSetup();
        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => ({ ...current, $schema: "different.schema.json" }),
        });

        expect(result).toMatchObject({ status: "invalid-update" });
    });

    it("does not expose rejected update values in diagnostics", async () => {
        const setup = await testSetup();
        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => ({ ...current, secretTypo: "do-not-report" }),
        });

        expect(result.status).toBe("invalid-update");
        expect(JSON.stringify(result)).not.toContain("do-not-report");
    });

    it("validates a partial update after merging it with the resolution base", async () => {
        const setup = await definitionSetup(dependentDefinition());
        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => ({
                ...current,
                mode: "b" as const,
            }),
        });

        expect(result).toMatchObject({ status: "invalid-update" });
    });

    it("rejects an existing global layer that conflicts after default resolution", async () => {
        const setup = await definitionSetup(dependentDefinition());
        await writeFile(
            setup.loaded.globalConfigPath,
            formatJson({ $schema: "./schemas/pi-dependent.schema.json", mode: "b" }),
        );

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => current,
        });

        expect(result.status).toBe("invalid-existing");
    });

    it("returns invalid-update when a settings codec rejects the resolved value", async () => {
        const definition = defineExtensionSettings({
            id: "pi-codec",
            title: "Codec",
            description: "Codec-backed settings.",
            schema: Type.Object(
                {
                    value: Decode(
                        Type.String({ default: "valid", description: "Encoded value." }),
                        (value) => {
                            if (value === "invalid") throw new Error("decode rejected value");
                            return value;
                        },
                    ),
                },
                { additionalProperties: false },
            ),
        });
        const setup = await definitionSetup(definition);

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => ({ ...current, value: "invalid" }),
        });

        expect(result).toMatchObject({ status: "invalid-update" });
    });

    it("returns unchanged without normalizing an equivalent document", async () => {
        const setup = await testSetup();
        const customFormatting = JSON.stringify({
            $schema: "./schemas/pi-example.schema.json",
            ...setup.definition.defaultSettings,
        });
        await writeFile(setup.loaded.globalConfigPath, customFormatting);

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => current,
        });

        expect(result.status).toBe("unchanged");
        expect(await readFile(setup.loaded.globalConfigPath, "utf8")).toBe(customFormatting);
    });

    it("supports mutating the supplied clone and deleting layer properties", async () => {
        const setup = await testSetup();
        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update(current) {
                delete current.enabled;
                current.mode = "expanded";
                return current;
            },
        });

        expect(result.status).toBe("updated");
        const document: unknown = JSON.parse(await readFile(setup.loaded.globalConfigPath, "utf8"));
        expect(document).toMatchObject({ mode: "expanded" });
        expect(document).not.toHaveProperty("enabled");
        const reloaded = loadPiExtensionSettings(setup.definition, setup.context, {
            bundledSchema: setup.bundledSchema,
        });
        expect(reloaded.settings.enabled).toBe(true);
        expect(reloaded.settings.mode).toBe("expanded");
    });

    it("serializes concurrent semantic updates over the latest layer", async () => {
        const setup = await testSetup();
        const appendTool = (tool: string) =>
            updatePiExtensionSettings(setup.definition, setup.context, {
                scope: "global" as const,
                update: (current) => ({
                    ...current,
                    tools: [...(current.tools ?? []), tool],
                }),
            });

        const results = await Promise.all([appendTool("bash"), appendTool("edit")]);

        expect(results.map((result) => result.status)).toEqual(["updated", "updated"]);
        const reloaded = loadPiExtensionSettings(setup.definition, setup.context, {
            bundledSchema: setup.bundledSchema,
        });
        expect(reloaded.settings.tools).toEqual(["read", "bash", "edit"]);
    });

    it("serializes cooperative transactions without Pi's in-process queue", async () => {
        const setup = await testSetup();
        const paths = {
            global: resolveGlobalSettingsPaths(join(setup.root, "agent"), setup.definition.id),
            project: resolveProjectSettingsPaths(
                setup.context.cwd,
                CONFIG_DIR_NAME,
                setup.definition.id,
            ),
        };
        const appendTool = (tool: string) =>
            updateSettingsTransaction(setup.definition, {
                scope: "global" as const,
                paths,
                projectTrusted: true,
                update: (current) => ({
                    ...current,
                    tools: [...(current.tools ?? []), tool],
                }),
            });

        const results = await Promise.all([appendTool("bash"), appendTool("edit")]);

        expect(results.map((result) => result.status).sort()).toEqual(["updated", "updated"]);
        const reloaded = loadPiExtensionSettings(setup.definition, setup.context, {
            bundledSchema: setup.bundledSchema,
        });
        expect(reloaded.settings.tools[0]).toBe("read");
        expect(reloaded.settings.tools.slice(1).sort()).toEqual(["bash", "edit"]);
    });

    it("creates explicit trusted-project settings without copying global values", async () => {
        const setup = await testSetup();
        expect(setup.loaded.projectRevision).toBeDefined();
        if (setup.loaded.projectRevision === undefined)
            throw new Error("Expected project revision");

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "project",
            expectedRevision: setup.loaded.projectRevision,
            update: (current) => ({ ...current, mode: "expanded" as const }),
        });

        expect(result.status).toBe("updated");
        if (result.status !== "updated") throw new Error("Expected updated settings");
        const projectPath = getPiProjectSettingsPath(setup.definition.id, setup.context.cwd);
        const projectDocument: unknown = JSON.parse(await readFile(projectPath, "utf8"));
        expect(projectDocument).toEqual({
            $schema: setup.definition.schemaId,
            mode: "expanded",
        });
        expect((await stat(projectPath)).mode & 0o777).toBe(0o600);
        const reloaded = loadPiExtensionSettings(setup.definition, setup.context, {
            bundledSchema: setup.bundledSchema,
        });
        expect(reloaded.projectRevision).toBe(result.revision);
        expect(reloaded.settings.mode).toBe("expanded");
        expect(reloaded.projectSettingsLayer).toEqual({ mode: "expanded" });
    });

    it("preserves an existing project schema reference", async () => {
        const setup = await testSetup();
        const projectPath = getPiProjectSettingsPath(setup.definition.id, setup.context.cwd);
        await mkdir(dirname(projectPath), { recursive: true });
        await writeFile(
            projectPath,
            formatJson({ $schema: "https://example.test/custom.schema.json", enabled: false }),
        );

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "project",
            update: (current) => ({ ...current, mode: "expanded" as const }),
        });

        expect(result.status).toBe("updated");
        const document: unknown = JSON.parse(await readFile(projectPath, "utf8"));
        expect(document).toMatchObject({
            $schema: "https://example.test/custom.schema.json",
            enabled: false,
            mode: "expanded",
        });
    });

    it("blocks untrusted project updates without creating a file", async () => {
        const setup = await testSetup(false);
        const projectPath = getPiProjectSettingsPath(setup.definition.id, setup.context.cwd);

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "project",
            update: (current) => ({ ...current, mode: "expanded" as const }),
        });

        expect(result).toMatchObject({ status: "blocked", reason: "project-untrusted" });
        await expect(readFile(projectPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses to overwrite malformed project settings", async () => {
        const setup = await testSetup();
        const projectPath = getPiProjectSettingsPath(setup.definition.id, setup.context.cwd);
        await mkdir(dirname(projectPath), { recursive: true });
        await writeFile(projectPath, "{ malformed project\n");

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "project",
            update: (current) => ({ ...current, mode: "expanded" as const }),
        });

        expect(result.status).toBe("invalid-existing");
        expect(await readFile(projectPath, "utf8")).toBe("{ malformed project\n");
    });

    it("rejects an existing project layer that conflicts with global settings", async () => {
        const setup = await definitionSetup(dependentDefinition());
        const projectPath = getPiProjectSettingsPath(setup.definition.id, setup.context.cwd);
        await mkdir(dirname(projectPath), { recursive: true });
        await writeFile(projectPath, formatJson({ mode: "b" }));

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "project",
            update: (current) => current,
        });

        expect(result.status).toBe("invalid-existing");
    });

    it("includes the global source in project snapshot conflicts", async () => {
        const setup = await testSetup();
        expect(setup.loaded.projectRevision).toBeDefined();
        if (setup.loaded.projectRevision === undefined)
            throw new Error("Expected project revision");
        await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => ({ ...current, enabled: false }),
        });

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "project",
            expectedRevision: setup.loaded.projectRevision,
            update: (current) => ({ ...current, mode: "expanded" as const }),
        });

        expect(result).toMatchObject({ status: "conflict", reason: "settings-changed" });
    });

    it("rejects writes after the installed schema changes", async () => {
        const setup = await testSetup();
        const schemaPath = join(
            dirname(setup.loaded.globalConfigPath),
            "schemas",
            "pi-example.schema.json",
        );
        const before = await readFile(setup.loaded.globalConfigPath, "utf8");
        await writeFile(schemaPath, "stale schema\n");

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => ({ ...current, enabled: false }),
        });

        expect(result).toMatchObject({ status: "conflict", reason: "schema-changed" });
        expect(await readFile(setup.loaded.globalConfigPath, "utf8")).toBe(before);
    });

    it("returns a safe failure when transaction files cannot be read", async () => {
        const setup = await testSetup();
        const schemaPath = join(
            dirname(setup.loaded.globalConfigPath),
            "schemas",
            "pi-example.schema.json",
        );
        await rm(schemaPath);
        await mkdir(schemaPath);

        const result = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => ({ ...current, enabled: false }),
        });

        expect(result).toEqual({
            status: "failed",
            message: "The global settings transaction failed.",
        });
    });

    it("releases locks and propagates updater errors", async () => {
        const setup = await testSetup();
        const updaterError = new Error("updater failed");

        await expect(
            updatePiExtensionSettings(setup.definition, setup.context, {
                scope: "global",
                update() {
                    throw updaterError;
                },
            }),
        ).rejects.toBe(updaterError);
        const retry = await updatePiExtensionSettings(setup.definition, setup.context, {
            scope: "global",
            update: (current) => ({ ...current, enabled: false }),
        });
        expect(retry.status).toBe("updated");
    });
});
