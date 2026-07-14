import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { formatJson } from "../src/json-value.ts";
import { resolveProjectSettingsPaths } from "../src/paths.ts";
import {
    getPiGlobalSettingsPath,
    getPiProjectSettingsPath,
    loadPiExtensionSettings,
} from "../src/pi.ts";
import { createSettingsFileSchema } from "../src/schema-document.ts";
import { testDefinition } from "./fixture.ts";

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "pi-settings-adapter-"));
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

describe("Pi settings adapter", () => {
    it("uses Pi paths and project trust", async () => {
        const root = await temporaryDirectory();
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        process.env.PI_CODING_AGENT_DIR = agentDir;

        const projectPaths = resolveProjectSettingsPaths(cwd, CONFIG_DIR_NAME, "pi-example");
        await mkdir(join(cwd, CONFIG_DIR_NAME, "extension-settings"), { recursive: true });
        await writeFile(projectPaths.configPath, JSON.stringify({ enabled: false }));
        const definition = testDefinition();

        const loaded = loadPiExtensionSettings(
            definition,
            { cwd, isProjectTrusted: () => true },
            {
                bundledSchema: {
                    kind: "content",
                    content: formatJson(createSettingsFileSchema(definition)),
                },
            },
        );

        expect(loaded.settings.enabled).toBe(false);
        expect(loaded.usedProjectConfig).toBe(true);
        expect(loaded.globalConfigPath).toBe(getPiGlobalSettingsPath(definition.id));
        expect(loaded.projectConfigPath).toBe(getPiProjectSettingsPath(definition.id, cwd));
    });

    it("does not read project settings when Pi marks the project untrusted", async () => {
        const root = await temporaryDirectory();
        process.env.PI_CODING_AGENT_DIR = join(root, "agent");
        const definition = testDefinition();

        const loaded = loadPiExtensionSettings(
            definition,
            { cwd: root, isProjectTrusted: () => false },
            {
                bundledSchema: {
                    kind: "content",
                    content: formatJson(createSettingsFileSchema(definition)),
                },
            },
        );

        expect(loaded.settings).toEqual(definition.defaultSettings);
        expect(loaded.usedProjectConfig).toBe(false);
    });
});
