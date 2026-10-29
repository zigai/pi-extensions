import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
    createStableBundledSchemaSource,
    formatModelModesSettingsDiagnostic,
    getConfiguredModeShortcuts,
    setUseThinkingBorderColors,
} from "../src/settings.ts";
import { cloneModesFile, type ModesFile } from "../src/modes.ts";
import { ModesStore, getProjectModesPath, scaffoldGlobalModesConfig } from "../src/modes-store.ts";

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

test("ModesStore refreshes shared settings while resolving and loading a mode file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-model-modes-prepared-"));
    const globalConfigPath = path.join(dir, "pi-model-modes.json");
    const projectConfigPath = path.join(dir, "project", "pi-model-modes.json");
    let settingsLoads = 0;
    const store = new ModesStore(() => {
        settingsLoads += 1;

        return {
            globalConfigPath,
            projectConfigPath,
            diagnostics: [],
            projectSettingsLayer: undefined,
            settings: {
                version: 1,
                currentMode: "default",
                modeUseThinkingBorderColors: false,
                modeShowThinkingLevelStatus: false,
                modes: { default: { provider: "openai", modelId: "gpt-5" } },
            },
        };
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
        assert.equal(settingsLoads, 2);
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

async function readModesDocument(filePath: string) {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));

    return Value.Parse(
        Type.Object(
            {
                modes: Type.Record(Type.String(), Type.Unknown()),
                defaultModel: Type.Optional(Type.Unknown()),
                hasConfiguredModes: Type.Optional(Type.Boolean()),
                modeShowThinkingLevelStatus: Type.Optional(Type.Boolean()),
            },
            { additionalProperties: true },
        ),
        parsed,
    );
}

const fallbackMode = { provider: "active", modelId: "active-model" };

async function withStore(
    run: (fixture: {
        store: ModesStore;
        cwd: string;
        filePath: string;
        baseline: ModesFile;
    }) => Promise<void>,
): Promise<void> {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-model-modes-order-"));
    process.env.PI_CODING_AGENT_DIR = cwd;
    try {
        await scaffoldGlobalModesConfig();
        const store = new ModesStore();
        const filePath = await store.resolvePath({ cwd, projectTrusted: false });
        await writeFile(
            filePath,
            JSON.stringify({
                version: 1,
                currentMode: "first",
                modes: {
                    first: { provider: "one", modelId: "one", thinkingLevel: "high" },
                    second: { provider: "two", modelId: "two" },
                },
            }),
        );

        // Resolve again after the test fixture changes the file.
        await store.resolvePath({ cwd, projectTrusted: false });
        const baseline = await store.load(filePath, fallbackMode);
        await run({ store, cwd, filePath, baseline });
    } finally {
        await rm(cwd, { recursive: true, force: true });

        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
}

test("ModesStore persists order-only edits on disk and reload", async () => {
    await withStore(async ({ store, filePath, baseline }) => {
        const next = cloneModesFile(baseline);
        next.modes = { second: next.modes.second, first: next.modes.first };
        const saved = await store.saveChanges(filePath, baseline, next, fallbackMode);
        assert.ok(saved);
        assert.deepEqual(Object.keys(saved.data.modes), ["second", "first"]);
        const persisted = await readModesDocument(filePath);
        assert.deepEqual(Object.keys(persisted.modes), ["second", "first"]);
        assert.equal(persisted.hasConfiguredModes, undefined);
    });
});

test("ModesStore preserves a renamed mode's position", async () => {
    await withStore(async ({ store, filePath, baseline }) => {
        const next = cloneModesFile(baseline);
        next.modes = { renamed: next.modes.first, second: next.modes.second };
        const saved = await store.saveChanges(filePath, baseline, next, fallbackMode);
        assert.deepEqual(Object.keys(saved?.data.modes ?? {}), ["renamed", "second"]);
        assert.deepEqual(Object.keys((await readModesDocument(filePath)).modes), [
            "renamed",
            "second",
        ]);
    });
});

test("ModesStore rejects concurrent order changes without touching the latest file", async () => {
    await withStore(async ({ store, filePath, baseline }) => {
        const next = cloneModesFile(baseline);
        next.modes = { renamed: next.modes.first, second: next.modes.second };
        const concurrent = JSON.stringify({
            modes: { second: baseline.modes.second, first: baseline.modes.first },
        });
        await writeFile(filePath, concurrent);
        await assert.rejects(
            store.saveChanges(filePath, baseline, next, fallbackMode),
            /order changed.*reload/i,
        );
        assert.equal(await readFile(filePath, "utf8"), concurrent);
    });
});

test("ModesStore non-order edits preserve latest order and unrelated fields", async () => {
    await withStore(async ({ store, filePath, baseline }) => {
        const next = cloneModesFile(baseline);
        next.modes.first.thinkingLevel = "low";
        await writeFile(
            filePath,
            JSON.stringify({
                modeShowThinkingLevelStatus: true,
                modes: { second: baseline.modes.second, remote: {}, first: baseline.modes.first },
            }),
        );
        const saved = await store.saveChanges(filePath, baseline, next, fallbackMode);
        assert.deepEqual(Object.keys(saved?.data.modes ?? {}), ["second", "remote", "first"]);
        assert.equal(saved?.data.modes.first.thinkingLevel, "low");
        assert.equal((await readModesDocument(filePath)).modeShowThinkingLevelStatus, true);
    });
});

test("ModesStore explicit no-op save removes legacy defaultModel", async () => {
    await withStore(async ({ store, cwd, filePath, baseline }) => {
        const config = {
            defaultModel: { provider: "legacy", modelId: "old", thinkingLevel: "low" },
            modes: baseline.modes,
        };
        await writeFile(filePath, JSON.stringify(config));
        await store.resolvePath({ cwd, projectTrusted: false });
        const loaded = await store.load(filePath, fallbackMode);
        assert.deepEqual(loaded.defaultModel, config.defaultModel);
        assert.equal(loaded.hasConfiguredModes, true);
        const saved = await store.saveChanges(
            filePath,
            loaded,
            cloneModesFile(loaded),
            fallbackMode,
        );
        assert.ok(saved);
        assert.equal(saved.data.defaultModel, undefined);
        assert.equal((await readModesDocument(filePath)).defaultModel, undefined);
        assert.deepEqual(Object.keys(saved.data.modes), ["first", "second"]);
    });
});

test("ModesStore leaves invalid settings untouched on load and save", async () => {
    await withStore(async ({ store, cwd, filePath, baseline }) => {
        const invalid = '{"modes":{"first":{"modelId":42}},"defaultModel":{"provider":"legacy"}}';
        await writeFile(filePath, invalid);
        await store.resolvePath({ cwd, projectTrusted: false });
        const loaded = await store.load(filePath, fallbackMode);
        assert.equal(loaded.hasConfiguredModes, false);
        assert.equal(await readFile(filePath, "utf8"), invalid);
        await assert.rejects(
            store.load(filePath, fallbackMode, { throwOnInvalid: true }),
            /invalid|ignored/i,
        );
        const next = cloneModesFile(baseline);
        next.modes.first.thinkingLevel = "low";
        await assert.rejects(
            store.saveChanges(filePath, baseline, next, fallbackMode),
            /invalid|ignored/i,
        );
        assert.equal(await readFile(filePath, "utf8"), invalid);
    });
});

test("ModesStore distinguishes fallback and custom-only configurations from actual modes", async () => {
    await withStore(async ({ store, cwd, filePath }) => {
        for (const modes of [{}, { custom: { modelId: "not-a-cycle-mode" } }]) {
            await writeFile(filePath, JSON.stringify({ modes }));
            await store.resolvePath({ cwd, projectTrusted: false });
            const loaded = await store.load(filePath, fallbackMode);
            assert.equal(loaded.hasConfiguredModes, false);
            assert.deepEqual(loaded.modes.default, fallbackMode);
        }
    });
});

test("ModesStore loads trusted-project modes with shared recursive merge semantics", async () => {
    await withStore(async ({ store, cwd, filePath, baseline }) => {
        const projectPath = getProjectModesPath(cwd);
        await mkdir(path.dirname(projectPath), { recursive: true });
        await writeFile(
            projectPath,
            JSON.stringify({
                modes: { first: { thinkingLevel: "low" }, project: { modelId: "project" } },
            }),
        );
        const resolved = await store.resolvePath({ cwd, projectTrusted: true });
        assert.equal(resolved, projectPath);
        const loaded = await store.load(resolved, fallbackMode);
        assert.equal(loaded.hasConfiguredModes, true);
        assert.deepEqual(loaded.modes.first, { ...baseline.modes.first, thinkingLevel: "low" });
        assert.deepEqual(loaded.modes.second, baseline.modes.second);
        assert.deepEqual(Object.keys(loaded.modes), ["first", "project", "second"]);
        const revision = await store.getRevision(resolved);
        await writeFile(filePath, JSON.stringify({ modes: { ...baseline.modes, added: {} } }));
        assert.notEqual(await store.getRevision(resolved), revision);
        assert.deepEqual(Object.keys((await store.load(resolved, fallbackMode)).modes), [
            "first",
            "project",
            "second",
            "added",
        ]);
        const globalPath = await store.resolvePath({ cwd, projectTrusted: false });
        assert.equal(globalPath, filePath);
        assert.equal((await store.load(globalPath, fallbackMode)).modes.project, undefined);
    });
});

test("ModesStore revision notices creation of a previously missing trusted-project file", async () => {
    await withStore(async ({ store, cwd, filePath }) => {
        assert.equal(await store.resolvePath({ cwd, projectTrusted: true }), filePath);
        const before = await store.getRevision(filePath);
        const projectPath = getProjectModesPath(cwd);
        await mkdir(path.dirname(projectPath), { recursive: true });
        await writeFile(
            projectPath,
            JSON.stringify({ modes: { project: { modelId: "project" } } }),
        );
        assert.notEqual(await store.getRevision(filePath), before);
        assert.equal(await store.resolvePath({ cwd, projectTrusted: true }), projectPath);
    });
});

test("ModesStore round-trips project cycle order ahead of inherited keys", async () => {
    await withStore(async ({ store, cwd, baseline }) => {
        const projectPath = getProjectModesPath(cwd);
        await mkdir(path.dirname(projectPath), { recursive: true });
        await writeFile(projectPath, JSON.stringify({ modes: { second: { color: "accent" } } }));
        await store.resolvePath({ cwd, projectTrusted: true });
        const loaded = await store.load(projectPath, fallbackMode);
        assert.deepEqual(Object.keys(loaded.modes), ["second", "first"]);
        assert.deepEqual(loaded.modes.second, { ...baseline.modes.second, color: "accent" });
        const next = cloneModesFile(loaded);
        next.modes = { first: next.modes.first, second: next.modes.second };
        const saved = await store.saveChanges(projectPath, loaded, next, fallbackMode);
        assert.deepEqual(Object.keys(saved?.data.modes ?? {}), ["first", "second"]);
        assert.deepEqual(Object.keys((await store.load(projectPath, fallbackMode)).modes), [
            "first",
            "second",
        ]);
    });
});

test("ModesStore deleting the final mode persists empty modes, not generated fallback", async () => {
    await withStore(async ({ store, cwd, filePath }) => {
        await writeFile(filePath, JSON.stringify({ modes: { only: { modelId: "only" } } }));
        await store.resolvePath({ cwd, projectTrusted: false });
        const loaded = await store.load(filePath, fallbackMode);
        const next = cloneModesFile(loaded);
        next.modes = {};
        const saved = await store.saveChanges(filePath, loaded, next, fallbackMode);
        assert.equal(saved?.data.hasConfiguredModes, false);
        assert.deepEqual((await readModesDocument(filePath)).modes, {});
        const freshStore = new ModesStore();
        await freshStore.resolvePath({ cwd, projectTrusted: false });
        const fresh = await freshStore.load(filePath, fallbackMode);
        assert.equal(fresh.hasConfiguredModes, false);
        assert.deepEqual(fresh.modes.default, fallbackMode);
    });
});

test("ModesStore deliberate edits to generated modes make them configured", async () => {
    await withStore(async ({ store, cwd, filePath }) => {
        for (const edit of ["edit", "add", "reorder"]) {
            await writeFile(filePath, JSON.stringify({ modes: {} }));
            await store.resolvePath({ cwd, projectTrusted: false });
            const loaded = await store.load(filePath, fallbackMode);
            assert.equal(loaded.hasConfiguredModes, false);
            const next = cloneModesFile(loaded);
            if (edit === "edit") next.modes.default.thinkingLevel = "high";
            else if (edit === "add") next.modes.deliberate = { modelId: "deliberate" };
            else next.modes = { fast: next.modes.fast, default: next.modes.default };

            const saved = await store.saveChanges(filePath, loaded, next, fallbackMode);
            assert.equal(saved?.data.hasConfiguredModes, true);
            assert.ok(Object.keys((await readModesDocument(filePath)).modes).length > 0);
        }
    });
});

test("project saves retain inheritance and persist inherited deletions", async () => {
    await withStore(async ({ store, cwd, filePath }) => {
        const projectPath = getProjectModesPath(cwd);
        await mkdir(path.dirname(projectPath), { recursive: true });
        await writeFile(
            projectPath,
            JSON.stringify({ modes: { first: { thinkingLevel: "low" } } }),
        );
        await store.resolvePath({ cwd, projectTrusted: true });
        const loaded = await store.load(projectPath, fallbackMode);
        const next = cloneModesFile(loaded);
        delete next.modes.second;
        await store.saveChanges(projectPath, loaded, next, fallbackMode);
        assert.deepEqual(Object.keys((await store.load(projectPath, fallbackMode)).modes), [
            "first",
        ]);
        await writeFile(
            filePath,
            JSON.stringify({
                modes: {
                    first: { provider: "updated", modelId: "new" },
                    second: { modelId: "second" },
                },
            }),
        );
        assert.deepEqual((await store.load(projectPath, fallbackMode)).modes.first, {
            provider: "updated",
            modelId: "new",
            thinkingLevel: "low",
        });
        assert.deepEqual(Object.keys((await store.load(projectPath, fallbackMode)).modes), [
            "first",
        ]);
    });
});

test("project can delete its last inherited mode", async () => {
    await withStore(async ({ store, cwd, filePath }) => {
        await writeFile(filePath, JSON.stringify({ modes: { only: { modelId: "only" } } }));
        const projectPath = getProjectModesPath(cwd);
        await mkdir(path.dirname(projectPath), { recursive: true });
        await writeFile(projectPath, JSON.stringify({ modes: {} }));
        await store.resolvePath({ cwd, projectTrusted: true });
        const loaded = await store.load(projectPath, fallbackMode);
        const next = cloneModesFile(loaded);
        next.modes = {};
        const saved = await store.saveChanges(projectPath, loaded, next, fallbackMode);
        assert.equal(saved?.data.hasConfiguredModes, false);
    });
});

test("project edit does not pin unrelated inherited values", async () => {
    await withStore(async ({ store, cwd, filePath }) => {
        const projectPath = getProjectModesPath(cwd);
        await mkdir(path.dirname(projectPath), { recursive: true });
        await writeFile(
            projectPath,
            JSON.stringify({ modes: { first: { thinkingLevel: "low" } } }),
        );
        await store.resolvePath({ cwd, projectTrusted: true });
        const loaded = await store.load(projectPath, fallbackMode);
        const next = cloneModesFile(loaded);
        next.modes.first.thinkingLevel = "medium";
        await store.saveChanges(projectPath, loaded, next, fallbackMode);
        await writeFile(
            filePath,
            JSON.stringify({
                modes: {
                    first: { provider: "updated", modelId: "new" },
                    second: { modelId: "new-second" },
                },
            }),
        );
        const updated = await store.load(projectPath, fallbackMode);
        assert.deepEqual(updated.modes.first, {
            provider: "updated",
            modelId: "new",
            thinkingLevel: "medium",
        });
        assert.deepEqual(updated.modes.second, { modelId: "new-second" });
    });
});

test("project can clear inherited thinking and retain the clear across edits", async () => {
    await withStore(async ({ store, cwd, filePath }) => {
        const projectPath = getProjectModesPath(cwd);
        await mkdir(path.dirname(projectPath), { recursive: true });
        await writeFile(projectPath, JSON.stringify({ modes: { first: { color: "accent" } } }));
        await store.resolvePath({ cwd, projectTrusted: true });
        const loaded = await store.load(projectPath, fallbackMode);
        const next = cloneModesFile(loaded);
        delete next.modes.first.thinkingLevel;
        const saved = await store.saveChanges(projectPath, loaded, next, fallbackMode);
        assert.deepEqual(saved?.data.modes.first, {
            provider: "one",
            modelId: "one",
            color: "accent",
        });
        assert.deepEqual((await readModesDocument(projectPath)).modes.first, {
            color: "accent",
            thinkingLevel: null,
        });
        await writeFile(
            filePath,
            JSON.stringify({
                modes: {
                    first: { provider: "updated", modelId: "new", thinkingLevel: "medium" },
                    second: { modelId: "two" },
                },
            }),
        );
        const changed = await store.load(projectPath, fallbackMode);
        assert.deepEqual(changed.modes.first, {
            provider: "updated",
            modelId: "new",
            color: "accent",
        });
        const reordered = cloneModesFile(changed);
        reordered.modes = { second: reordered.modes.second, first: reordered.modes.first };
        reordered.modes.second.color = "warning";
        const again = await store.saveChanges(projectPath, changed, reordered, fallbackMode);
        assert.deepEqual(again?.data.modes.first, {
            provider: "updated",
            modelId: "new",
            color: "accent",
        });
        assert.deepEqual((await readModesDocument(projectPath)).modes.first, {
            color: "accent",
            thinkingLevel: null,
        });
        const restored = cloneModesFile(again.data);
        restored.modes.first.thinkingLevel = "high";
        const final = await store.saveChanges(projectPath, again.data, restored, fallbackMode);
        assert.equal(final?.data.modes.first.thinkingLevel, "high");
        assert.deepEqual((await readModesDocument(projectPath)).modes.first, {
            color: "accent",
            thinkingLevel: "high",
        });
        const global = await store.load(
            await store.resolvePath({ cwd, projectTrusted: false }),
            fallbackMode,
        );
        assert.equal(global.modes.first.thinkingLevel, "medium");
    });
});
