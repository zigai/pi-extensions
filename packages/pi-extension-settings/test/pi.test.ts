import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { formatJson } from "../src/json-value.ts";
import { resolveProjectSettingsPaths } from "../src/paths.ts";
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
});
