import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
    loadSettingsCatalog,
    saveSettingsLayers,
    type SettingsLocation,
} from "../src/settings-store.ts";
import { richSchemaText } from "./fixture.ts";

async function testLocation(): Promise<{
    readonly root: string;
    readonly location: SettingsLocation;
}> {
    const root = await mkdtemp(join(tmpdir(), "pi-settings-ui-"));
    const globalDirectory = join(root, "agent", "extension-settings");
    const projectDirectory = join(root, "project", ".pi", "extension-settings");

    return {
        root,
        location: {
            schemaDirectory: join(globalDirectory, "schemas"),
            globalConfigPath: (id) => join(globalDirectory, `${id}.json`),
            projectConfigPath: (id) => join(projectDirectory, `${id}.json`),
        },
    };
}

describe("settings catalog", () => {
    it("discovers generated schemas and does not read untrusted project settings", async () => {
        const { location } = await testLocation();
        await mkdir(location.schemaDirectory, { recursive: true });
        await writeFile(join(location.schemaDirectory, "pi-fixture.schema.json"), richSchemaText());
        await mkdir(join(location.projectConfigPath("pi-fixture"), ".."), { recursive: true });
        await writeFile(location.projectConfigPath("pi-fixture"), "{");

        const untrusted = await loadSettingsCatalog(location, { projectTrusted: false });
        expect(untrusted.extensions).toHaveLength(1);
        expect(untrusted.extensions[0]?.project).toMatchObject({ _tag: "UnavailableLayer" });

        const trusted = await loadSettingsCatalog(location, { projectTrusted: true });
        expect(trusted.extensions[0]?.project).toMatchObject({
            _tag: "BlockedLayer",
            message: "Settings contain malformed JSON.",
        });
    });

    it("blocks malformed global settings instead of replacing them", async () => {
        const { location } = await testLocation();
        await mkdir(location.schemaDirectory, { recursive: true });
        await writeFile(join(location.schemaDirectory, "pi-fixture.schema.json"), richSchemaText());
        await writeFile(location.globalConfigPath("pi-fixture"), "{");

        const catalog = await loadSettingsCatalog(location, { projectTrusted: false });
        expect(catalog.extensions[0]?.global).toMatchObject({
            _tag: "BlockedLayer",
            message: "Settings contain malformed JSON.",
        });

        expect(await readFile(location.globalConfigPath("pi-fixture"), "utf8")).toBe("{");
    });
});

describe("settings persistence", () => {
    it("writes atomically after checking both schema and config snapshots", async () => {
        const { location } = await testLocation();
        const schemaPath = join(location.schemaDirectory, "pi-fixture.schema.json");
        const configPath = location.globalConfigPath("pi-fixture");
        const schemaText = richSchemaText();
        const original = '{"$schema":"./schemas/pi-fixture.schema.json","enabled":true}\n';
        const changed = '{"$schema":"./schemas/pi-fixture.schema.json","enabled":false}\n';
        await mkdir(location.schemaDirectory, { recursive: true });
        await writeFile(schemaPath, schemaText);
        await writeFile(configPath, original);

        const outcomes = await saveSettingsLayers([
            {
                extensionId: "pi-fixture",
                scope: "global",
                schemaPath,
                expectedSchemaText: schemaText,
                configPath,
                expectedConfigText: original,
                content: changed,
            },
        ]);
        expect(outcomes).toEqual([
            {
                _tag: "SavedLayer",
                extensionId: "pi-fixture",
                scope: "global",
                content: changed,
                changed: true,
            },
        ]);

        expect(await readFile(configPath, "utf8")).toBe(changed);
    });

    it("reports a conflict and preserves concurrent user changes", async () => {
        const { location } = await testLocation();
        const schemaPath = join(location.schemaDirectory, "pi-fixture.schema.json");
        const configPath = location.globalConfigPath("pi-fixture");
        const schemaText = richSchemaText();
        await mkdir(location.schemaDirectory, { recursive: true });
        await writeFile(schemaPath, schemaText);
        await writeFile(configPath, '{"enabled":false}\n');

        const outcomes = await saveSettingsLayers([
            {
                extensionId: "pi-fixture",
                scope: "global",
                schemaPath,
                expectedSchemaText: schemaText,
                configPath,
                expectedConfigText: '{"enabled":true}\n',
                content: '{"enabled":true,"threshold":3}\n',
            },
        ]);
        expect(outcomes[0]).toMatchObject({ _tag: "SaveConflict" });
        expect(await readFile(configPath, "utf8")).toBe('{"enabled":false}\n');
    });
});
