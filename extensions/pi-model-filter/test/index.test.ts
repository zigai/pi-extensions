import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, test } from "vitest";
import { PHYSICAL_MODEL_ID } from "@zigai/pi-extension-internals";

import type { ModelLike } from "../src/model-filter.ts";
import type { PatchedModelRegistry } from "../src/model-registry-patch.ts";
import type { PatchedModelRuntime } from "../src/model-runtime-patch.ts";
import type { LoadedModelFilterSettings, ModelFilterSettingsLoadState } from "../src/settings.ts";

type RuntimeState = ModelFilterSettingsLoadState & { loadSettings(): LoadedModelFilterSettings };

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "pi-model-filter-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

// Settings paths are resolved at module initialization, so the test must set
// PI_CODING_AGENT_DIR before loading the assigned modules.

const modelFilter = {
    ...(await import("../src/model-filter.ts")),
    ...(await import("../src/model-registry-patch.ts")),
    ...(await import("../src/model-runtime-patch.ts")),
    ...(await import("../src/settings.ts")),
};
const configPath = join(agentDir, "extension-settings", "pi-model-filter.json");
const schemaPath = join(agentDir, "extension-settings", "schemas", "pi-model-filter.schema.json");

afterAll(async () => {
    await rm(agentDir, { recursive: true, force: true });

    if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
    } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
});

await mkdir(join(agentDir, "extension-settings"), { recursive: true });

const models: ModelLike[] = [
    { provider: "openai", id: "gpt-5" },
    { provider: "openai", id: "gpt-5-mini" },
    { provider: "anthropic", id: "claude-opus" },
    { provider: "local.v1", id: "llama" },
];

function loadedConfig(
    include: LoadedModelFilterSettings["settings"]["includeRules"],
    exclude: LoadedModelFilterSettings["settings"]["excludeRules"],
): LoadedModelFilterSettings {
    return {
        path: configPath,
        mtimeMs: 1,
        settings: {
            includeRules: include,
            excludeRules: exclude,
        },
    };
}

test("glob patterns match complete provider and model ids", () => {
    assert.equal(modelFilter.globToRegex("gpt-*").test("gpt-5"), true);
    assert.equal(modelFilter.globToRegex("gpt-?").test("gpt-55"), false);
    assert.equal(modelFilter.globToRegex("local.v1").test("local-v1"), false);
    assert.equal(modelFilter.globToRegex("local.v1").test("local.v1"), true);
});

test("include rules constrain matching providers while excludes always hide models", () => {
    const includeRules = modelFilter.normalizeRules([{ provider: "openai", models: ["gpt-*"] }]);
    const excludeRules = modelFilter.normalizeRules([{ provider: "*", models: ["*-mini"] }]);
    const visible = modelFilter.filterModels(
        models,
        loadedConfig(includeRules, excludeRules).settings,
    );

    assert.deepEqual(
        visible.map((model) => `${model.provider}/${model.id}`),
        ["openai/gpt-5", "anthropic/claude-opus", "local.v1/llama"],
    );
});

test("filter rules use the physical model identity for aliased models", () => {
    const settings = loadedConfig(
        modelFilter.normalizeRules([{ provider: "openai", models: ["gpt-5*"] }]),
        modelFilter.normalizeRules([{ provider: "openai", models: ["*-mini"] }]),
    ).settings;
    const visibleAlias = { provider: "openai", id: "quick", [PHYSICAL_MODEL_ID]: "gpt-5" };
    const hiddenAlias = { provider: "openai", id: "compact", [PHYSICAL_MODEL_ID]: "gpt-5-mini" };
    const registry: PatchedModelRegistry = {
        getAll: () => [visibleAlias, hiddenAlias],
        getAvailable: () => [visibleAlias, hiddenAlias],
        find: (_provider, modelId) =>
            [visibleAlias, hiddenAlias].find(
                (model) => model.id === modelId || model[PHYSICAL_MODEL_ID] === modelId,
            ),
    };
    modelFilter.installRegistryPatch(registry, () => settings);
    assert.deepEqual(registry.getAll(), [visibleAlias]);
    assert.deepEqual(registry.getAvailable(), [visibleAlias]);
    assert.equal(registry.find("openai", "gpt-5"), visibleAlias);
    assert.equal(registry.find("openai", "quick"), visibleAlias);
    assert.equal(registry.find("openai", "compact"), undefined);
});

test("loadModelFilterSettings falls back for missing and malformed config files", async () => {
    await rm(configPath, { force: true });
    const state: RuntimeState = {
        loadSettings() {
            return modelFilter.loadModelFilterSettings(state);
        },
    };

    const missing = modelFilter.loadModelFilterSettings(state);
    assert.deepEqual(missing.settings.includeRules, []);
    assert.deepEqual(missing.settings.excludeRules, []);
    assert.equal(missing.diagnostic, undefined);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
        $schema: "./schemas/pi-model-filter.schema.json",
        include: [],
        exclude: [],
    });
    assert.match(await readFile(schemaPath, "utf8"), /Pi Model Filter settings/);
    await writeFile(schemaPath, "stale schema", "utf8");
    state.configCache = undefined;
    modelFilter.loadModelFilterSettings(state);
    assert.match(await readFile(schemaPath, "utf8"), /Pi Model Filter settings/);
    await writeFile(configPath, "{ not json", "utf8");
    state.configCache = undefined;
    const malformed = modelFilter.loadModelFilterSettings(state);
    assert.match(malformed.diagnostic ?? "", /Failed to load/);
    assert.deepEqual(malformed.settings.includeRules, []);
    assert.deepEqual(malformed.settings.excludeRules, []);
    assert.equal(await readFile(configPath, "utf8"), "{ not json");
    await writeFile(schemaPath, "stale schema", "utf8");
    state.configCache = undefined;
    modelFilter.loadModelFilterSettings(state);
    assert.equal(await readFile(configPath, "utf8"), "{ not json");
    assert.match(await readFile(schemaPath, "utf8"), /Pi Model Filter settings/);
});

test("loadModelFilterSettings reuses an unchanged config without reloading settings artifacts", async () => {
    await writeFile(
        configPath,
        JSON.stringify({
            include: [],
            exclude: [],
        }),
        "utf8",
    );
    const state: RuntimeState = {
        loadSettings() {
            return modelFilter.loadModelFilterSettings(state);
        },
    };
    const loaded = modelFilter.loadModelFilterSettings(state);

    await writeFile(schemaPath, "stale after scaffold", "utf8");
    const loadedAgain = modelFilter.loadModelFilterSettings(state);
    assert.equal(loadedAgain, loaded);
    assert.equal(await readFile(schemaPath, "utf8"), "stale after scaffold");
    state.configCache = undefined;
    modelFilter.loadModelFilterSettings(state);
    assert.match(await readFile(schemaPath, "utf8"), /Pi Model Filter settings/);
});

test("loadModelFilterSettings parses and trims valid config rules", async () => {
    await writeFile(
        configPath,
        JSON.stringify({
            include: [{ provider: " openai ", models: [" gpt-* "] }],
            exclude: [{ provider: " * ", models: [" *-mini "] }],
        }),
        "utf8",
    );
    const state: RuntimeState = {
        loadSettings() {
            return modelFilter.loadModelFilterSettings(state);
        },
    };

    const loaded = modelFilter.loadModelFilterSettings(state);
    assert.equal(loaded.diagnostic, undefined);
    assert.deepEqual(loaded.settings.includeRules[0]?.providerPattern, "openai");
    assert.deepEqual(loaded.settings.includeRules[0]?.modelPatterns, ["gpt-*"]);
    assert.deepEqual(loaded.settings.excludeRules[0]?.providerPattern, "*");
    assert.deepEqual(loaded.settings.excludeRules[0]?.modelPatterns, ["*-mini"]);
});

test("loadModelFilterSettings rejects unknown config keys", async () => {
    await writeFile(
        configPath,
        JSON.stringify({
            include: [{ provider: "openai", models: ["gpt-*"], note: "typo" }],
        }),
        "utf8",
    );
    const state: RuntimeState = {
        loadSettings() {
            return modelFilter.loadModelFilterSettings(state);
        },
    };

    const loaded = modelFilter.loadModelFilterSettings(state);
    assert.deepEqual(loaded.settings.includeRules, []);
    assert.deepEqual(loaded.settings.excludeRules, []);
    assert.match(loaded.diagnostic ?? "", /schema|property|ignored/);
});

test("registry patch filters list and lookup results and remains idempotent", () => {
    let loaded = loadedConfig(
        modelFilter.normalizeRules([{ provider: "openai", models: ["gpt-5"] }]),
        modelFilter.normalizeRules([{ provider: "*", models: ["*-mini"] }]),
    );
    const state: RuntimeState = {
        loadSettings() {
            return loaded;
        },
    };
    const registry: PatchedModelRegistry = {
        getModelsOfType(type, providerId) {
            if (type !== "chat") return [];
            if (providerId === undefined) return models;
            return models.filter((model) => model.provider === providerId);
        },
        getModelOfType(type, providerId, modelId) {
            if (type !== "chat") return undefined;
            return models.find((model) => model.provider === providerId && model.id === modelId);
        },
        async getAvailableOfType(type, providerId) {
            return this.getModelsOfType?.(type, providerId) ?? [];
        },
        findOfType(type, providerId, modelId) {
            return this.getModelOfType?.(type, providerId, modelId);
        },
        getAll() {
            return models;
        },
        getAvailable() {
            return [models[0], models[1]];
        },
        find(provider: string, modelId: string) {
            return models.find((model) => model.provider === provider && model.id === modelId);
        },
    };

    modelFilter.installRegistryPatch(registry, () => state.loadSettings().settings);
    modelFilter.installRegistryPatch(registry, () => state.loadSettings().settings);

    assert.deepEqual(
        registry.getAll().map((model) => model.id),
        ["gpt-5", "claude-opus", "llama"],
    );
    assert.deepEqual(
        registry.getAvailable().map((model) => model.id),
        ["gpt-5"],
    );
    assert.equal(registry.find("openai", "gpt-5-mini"), undefined);
    assert.deepEqual(registry.find("openai", "gpt-5"), models[0]);
    loaded = loadedConfig([], []);
    assert.deepEqual(
        registry.getAll().map((model) => model.id),
        ["gpt-5", "gpt-5-mini", "claude-opus", "llama"],
    );
});

test("model runtime patch filters synchronous and asynchronous model views", async () => {
    let loaded = loadedConfig(
        modelFilter.normalizeRules([{ provider: "openai", models: ["gpt-5"] }]),
        modelFilter.normalizeRules([{ provider: "*", models: ["*-mini"] }]),
    );
    const state: RuntimeState = {
        loadSettings() {
            return loaded;
        },
    };
    const runtime: PatchedModelRuntime = {
        getModelsOfType(type, providerId) {
            if (type !== "chat") return [];
            return this.getModels(providerId);
        },
        getModelOfType(type, providerId, modelId) {
            if (type !== "chat") return undefined;
            return this.getModel(providerId, modelId);
        },
        getAllModels(providerId) {
            return this.getModels(providerId);
        },
        async getAvailableOfType(type, providerId, options) {
            if (type !== "chat") return [];
            return this.getAvailable(providerId, options);
        },
        async getAllAvailable(providerId, options) {
            return this.getAvailable(providerId, options);
        },
        getModels(providerId?: string) {
            if (providerId === undefined) return models;
            return models.filter((model) => model.provider === providerId);
        },
        async getAvailable(providerId?: string) {
            if (providerId === undefined) return models;
            return models.filter((model) => model.provider === providerId);
        },
        getAvailableSnapshot() {
            return models;
        },
        getModel(providerId: string, modelId: string) {
            return models.find((model) => model.provider === providerId && model.id === modelId);
        },
    };

    modelFilter.installModelRuntimePatch(runtime, () => state.loadSettings().settings);
    modelFilter.installModelRuntimePatch(runtime, () => state.loadSettings().settings);

    assert.deepEqual(
        runtime.getModels().map((model) => model.id),
        ["gpt-5", "claude-opus", "llama"],
    );
    assert.deepEqual(
        runtime.getAvailableSnapshot().map((model) => model.id),
        ["gpt-5", "claude-opus", "llama"],
    );
    assert.deepEqual(
        (await runtime.getAvailable("openai")).map((model) => model.id),
        ["gpt-5"],
    );
    assert.equal(runtime.getModel("openai", "gpt-5-mini"), undefined);
    assert.deepEqual(runtime.getModel("openai", "gpt-5"), models[0]);
    loaded = loadedConfig([], []);
    assert.deepEqual(
        (await runtime.getAvailable()).map((model) => model.id),
        ["gpt-5", "gpt-5-mini", "claude-opus", "llama"],
    );
});
