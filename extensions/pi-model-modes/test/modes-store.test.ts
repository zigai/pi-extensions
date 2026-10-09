import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

import {
    createStableBundledSchemaSource,
    formatModelModesSettingsDiagnostic,
    getConfiguredModeShortcuts,
    setUseThinkingBorderColors,
} from "../src/settings.ts";
import { ModesStore, scaffoldGlobalModesConfig } from "../src/modes-store.ts";

test("bundled schema stays aligned with the loaded module across session rebinding", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-model-modes-schema-"));
    const schemaPath = path.join(directory, "config.schema.json");

    try {
        await writeFile(schemaPath, "schema loaded with definition", "utf8");
        const source = createStableBundledSchemaSource(pathToFileURL(schemaPath));
        assert.deepEqual(source(), {
            kind: "content",
            content: "schema loaded with definition",
        });

        await writeFile(schemaPath, "newer schema on disk", "utf8");
        assert.deepEqual(source(), {
            kind: "content",
            content: "schema loaded with definition",
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("settings diagnostics identify the extension, artifact, and recovery action", () => {
    const message = formatModelModesSettingsDiagnostic({
        code: "bundled-schema-stale",
        severity: "error",
        scope: "schema",
        path: "/tmp/installed/pi-model-modes.schema.json",
        message: "The bundled settings schema is stale; run the artifact generator",
    });

    assert.match(message, /^\[pi-model-modes\]/);
    assert.match(message, /extensions\/pi-model-modes\/config\.schema\.json/);
    assert.match(message, /npm run config:generate/);
    assert.match(message, /reinstall or update the extension/);
});

test("scaffoldGlobalModesConfig creates missing global config and schema", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-model-modes-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
        const configPath = path.join(agentDir, "extension-settings", "pi-model-modes.json");
        const schemaPath = path.join(
            agentDir,
            "extension-settings",
            "schemas",
            "pi-model-modes.schema.json",
        );
        await scaffoldGlobalModesConfig();

        assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
            $schema: "./schemas/pi-model-modes.schema.json",
            version: 1,
            currentMode: "default",
            modeUseThinkingBorderColors: false,
            modeShowThinkingLevelStatus: false,
            modes: {},
        });
        assert.match(await readFile(schemaPath, "utf8"), /Pi Model Modes settings/);
        await writeFile(configPath, "{ not json", "utf8");
        await writeFile(schemaPath, "stale schema", "utf8");
        await scaffoldGlobalModesConfig();
        assert.equal(await readFile(configPath, "utf8"), "{ not json");
        assert.match(await readFile(schemaPath, "utf8"), /Pi Model Modes settings/);
    } finally {
        await rm(agentDir, { recursive: true, force: true });

        if (originalAgentDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        }
    }
});

test("mode cycle shortcuts are optional and read from global config", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-model-modes-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
        const configPath = path.join(agentDir, "extension-settings", "pi-model-modes.json");
        await scaffoldGlobalModesConfig();
        assert.deepEqual(
            getConfiguredModeShortcuts({ cwd: process.cwd(), projectTrusted: false }),
            {},
        );

        await writeFile(
            configPath,
            JSON.stringify({
                shortcuts: {
                    forward: "ctrl+space",
                    backward: "shift+ctrl+space",
                },
            }),
            "utf8",
        );
        assert.deepEqual(
            getConfiguredModeShortcuts({ cwd: process.cwd(), projectTrusted: false }),
            {
                forward: "ctrl+space",
                backward: "shift+ctrl+space",
            },
        );
    } finally {
        await rm(agentDir, { recursive: true, force: true });

        if (originalAgentDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        }
    }
});

test("mode config writes reject unknown config keys", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-model-modes-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
        const configPath = path.join(agentDir, "extension-settings", "pi-model-modes.json");
        await scaffoldGlobalModesConfig();
        const invalidConfig = JSON.stringify({
            version: 1,
            currentMode: "default",
            modes: {
                default: {
                    provider: "openai",
                    modelId: "gpt-5",
                    extra: "typo",
                },
            },
        });
        await writeFile(configPath, invalidConfig, "utf8");

        await assert.rejects(
            setUseThinkingBorderColors({ cwd: process.cwd(), projectTrusted: false }, true),
            /invalid|property|ignored/i,
        );
        assert.equal(await readFile(configPath, "utf8"), invalidConfig);
    } finally {
        await rm(agentDir, { recursive: true, force: true });

        if (originalAgentDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        }
    }
});

test("ModesStore prepares settings once while resolving and loading a mode file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-model-modes-prepared-"));
    const globalConfigPath = path.join(dir, "pi-model-modes.json");
    const projectConfigPath = path.join(dir, "project", "pi-model-modes.json");
    let settingsLoads = 0;
    const store = new ModesStore(() => {
        settingsLoads += 1;
        return { globalConfigPath, projectConfigPath };
    });

    try {
        await writeFile(
            globalConfigPath,
            JSON.stringify({
                version: 1,
                currentMode: "default",
                modes: { default: { provider: "openai", modelId: "gpt-5" } },
            }),
            "utf8",
        );

        const resolvedPath = await store.resolvePath({ cwd: dir, projectTrusted: false });
        const loaded = await store.load(resolvedPath, {
            provider: "openai",
            modelId: "gpt-5",
        });

        assert.equal(resolvedPath, globalConfigPath);
        assert.equal(loaded.currentMode, "default");
        assert.equal(settingsLoads, 1);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("ModesStore merges a local patch into the latest transactional layer", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const dir = await mkdtemp(path.join(tmpdir(), "pi-model-modes-store-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    const filePath = path.join(dir, "extension-settings", "pi-model-modes.json");
    const fallback = { provider: "openai", modelId: "gpt-5", thinkingLevel: "medium" as const };
    const store = new ModesStore();
    try {
        await scaffoldGlobalModesConfig();
        await writeFile(
            filePath,
            JSON.stringify({
                version: 1,
                currentMode: "default",
                modes: { default: fallback, remote: { provider: "remote", modelId: "new" } },
            }),
            "utf8",
        );
        const baseline = {
            version: 1 as const,
            currentMode: "default",
            modes: { default: fallback },
        };
        const next = {
            ...baseline,
            modes: { default: { ...fallback, thinkingLevel: "high" as const } },
        };

        await store.resolvePath({ cwd: dir, projectTrusted: false });
        const saved = await store.saveChanges(filePath, baseline, next, fallback);
        assert.equal(saved?.data.modes.default?.thinkingLevel, "high");
        assert.deepEqual(saved.data.modes.remote, { provider: "remote", modelId: "new" });
    } finally {
        await rm(dir, { recursive: true, force: true });

        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
});
