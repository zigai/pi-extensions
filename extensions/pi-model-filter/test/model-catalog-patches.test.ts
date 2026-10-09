import assert from "node:assert/strict";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AnyModel, Model, Provider } from "@earendil-works/pi-ai";
import { test } from "vitest";

import { normalizeRules, type ModelFilterSettings } from "../src/model-filter.ts";
import { installRegistryPatch } from "../src/model-registry-patch.ts";
import { installModelRuntimePatch } from "../src/model-runtime-patch.ts";

const providerId = "filter-catalog-test";
const chatModels: Model<"openai-completions">[] = ["keep-chat", "hide-chat"].map((id) => ({
    id,
    name: id,
    provider: providerId,
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    input: ["text"],
    reasoning: false,
    contextWindow: 4096,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

const allModels: AnyModel[] = [
    ...chatModels,
    {
        id: "keep-image",
        name: "Keep image",
        provider: providerId,
        type: "image",
        api: "openai-images",
        baseUrl: "https://example.invalid",
        input: ["text"],
        output: ["image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    {
        id: "hide-classifier",
        name: "Hide classifier",
        provider: providerId,
        type: "classifier",
        api: "typesafe-classifier",
        baseUrl: "https://example.invalid",
        input: ["text"],
        contextWindow: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
];

async function createRuntime(): Promise<ModelRuntime> {
    const runtime = await ModelRuntime.create({
        credentials: {
            async read() {
                return undefined;
            },
            async list() {
                return [];
            },
            async modify() {
                throw new Error("Test credential storage is read-only.");
            },
            async delete() {
                throw new Error("Test credential storage is read-only.");
            },
        },
        modelsPath: null,
        refreshOnCreate: false,
    });
    const provider: Provider = {
        id: providerId,
        name: "Filter catalog test",
        auth: {
            apiKey: {
                name: "Keyless test provider",
                async resolve({ signal }) {
                    signal.throwIfAborted();
                    return { auth: {} };
                },
            },
        },
        getModels() {
            return chatModels;
        },
        getAllModels() {
            return allModels;
        },
        stream() {
            throw new Error("Test provider must not send requests.");
        },
        streamSimple() {
            throw new Error("Test provider must not send requests.");
        },
    };
    runtime.registerNativeProvider(provider);
    await runtime.getAvailable(providerId);

    return runtime;
}

const settings: ModelFilterSettings = {
    includeRules: [],
    excludeRules: normalizeRules([{ provider: providerId, models: ["hide-*"] }]),
};

test("runtime policy covers chat and non-chat typed and all-model catalogs", async () => {
    const runtime = await createRuntime();
    installModelRuntimePatch(runtime, () => settings);
    assert.deepEqual(
        runtime.getModels(providerId).map((model) => model.id),
        ["keep-chat"],
    );
    assert.deepEqual(
        runtime.getModelsOfType("chat", providerId).map((model) => model.id),
        ["keep-chat"],
    );
    assert.deepEqual(
        runtime.getModelsOfType("image", providerId).map((model) => model.id),
        ["keep-image"],
    );
    assert.deepEqual(runtime.getModelsOfType("classifier", providerId), []);
    assert.deepEqual(
        runtime.getAllModels(providerId).map((model) => model.id),
        ["keep-chat", "keep-image"],
    );
    assert.deepEqual(
        runtime
            .getAllModels()
            .filter((model) => model.provider === providerId)
            .map((model) => model.id),
        ["keep-chat", "keep-image"],
    );
    assert.deepEqual(
        (await runtime.getAvailable(providerId)).map((model) => model.id),
        ["keep-chat"],
    );
    assert.deepEqual(
        (await runtime.getAvailableOfType("chat", providerId)).map((model) => model.id),
        ["keep-chat"],
    );
    assert.deepEqual(
        (await runtime.getAvailableOfType("image", providerId)).map((model) => model.id),
        ["keep-image"],
    );
    assert.deepEqual(await runtime.getAvailableOfType("classifier", providerId), []);
    assert.deepEqual(
        (await runtime.getAllAvailable(providerId)).map((model) => model.id),
        ["keep-chat", "keep-image"],
    );
    assert.equal(runtime.getModelOfType("chat", providerId, "hide-chat"), undefined);
    assert.equal(runtime.getModelOfType("classifier", providerId, "hide-classifier"), undefined);
    assert.equal(runtime.getModelOfType("image", providerId, "keep-image"), allModels[2]);
    assert.equal(runtime.getModelOfType("image", providerId, "missing"), undefined);
});

test("registry policy covers typed catalogs and lookups without a runtime patch", async () => {
    const runtime = await createRuntime();
    const registry = new ModelRegistry(runtime);
    let policy = settings;
    installRegistryPatch(registry, () => policy);
    assert.deepEqual(
        registry.getModelsOfType("chat", providerId).map((model) => model.id),
        ["keep-chat"],
    );
    assert.deepEqual(
        registry.getModelsOfType("image", providerId).map((model) => model.id),
        ["keep-image"],
    );
    assert.deepEqual(registry.getModelsOfType("classifier", providerId), []);
    assert.deepEqual(
        (await registry.getAvailableOfType("chat", providerId)).map((model) => model.id),
        ["keep-chat"],
    );
    assert.deepEqual(
        (await registry.getAvailableOfType("image", providerId)).map((model) => model.id),
        ["keep-image"],
    );
    assert.deepEqual(await registry.getAvailableOfType("classifier", providerId), []);
    assert.equal(registry.findOfType("chat", providerId, "hide-chat"), undefined);
    assert.equal(registry.findOfType("classifier", providerId, "hide-classifier"), undefined);
    assert.equal(registry.getModelOfType("classifier", providerId, "hide-classifier"), undefined);
    assert.equal(registry.getModelOfType("chat", providerId, "hide-chat"), undefined);
    assert.equal(registry.findOfType("image", providerId, "keep-image"), allModels[2]);
    policy = {
        includeRules: normalizeRules([{ provider: providerId, models: ["hide-*"] }]),
        excludeRules: normalizeRules([{ provider: providerId, models: ["hide-classifier"] }]),
    };
    assert.deepEqual(
        registry.getModelsOfType("chat", providerId).map((model) => model.id),
        ["hide-chat"],
    );
    assert.deepEqual(
        (await registry.getAvailableOfType("chat", providerId)).map((model) => model.id),
        ["hide-chat"],
    );
    assert.deepEqual(registry.getModelsOfType("image", providerId), []);
    assert.deepEqual(await registry.getAvailableOfType("classifier", providerId), []);
    assert.equal(registry.getModelOfType("image", providerId, "keep-image"), undefined);
    assert.equal(registry.findOfType("classifier", providerId, "hide-classifier"), undefined);
});

test("patched availability APIs preserve caller cancellation", async () => {
    const runtime = await createRuntime();
    const registry = new ModelRegistry(runtime);
    installModelRuntimePatch(runtime, () => settings);
    installRegistryPatch(registry, () => settings);
    const reason = new Error("Catalog request cancelled");
    const options = { signal: AbortSignal.abort(reason) };
    await assert.rejects(runtime.getAvailable(providerId, options), (cause) => cause === reason);
    await assert.rejects(
        runtime.getAvailableOfType("image", providerId, options),
        (cause) => cause === reason,
    );
    await assert.rejects(runtime.getAllAvailable(providerId, options), (cause) => cause === reason);
    await assert.rejects(
        registry.getAvailableOfType("image", providerId, options),
        (cause) => cause === reason,
    );
});

test("reinstalling typed catalog patches updates the policy without stacking wrappers", async () => {
    const runtime = await createRuntime();
    const registry = new ModelRegistry(runtime);
    installModelRuntimePatch(runtime, () => settings);
    installRegistryPatch(registry, () => settings);
    const runtimeCatalog = Object.getOwnPropertyDescriptor(runtime, "getAllModels");
    const registryCatalog = Object.getOwnPropertyDescriptor(registry, "getModelsOfType");
    const replacement: ModelFilterSettings = {
        includeRules: normalizeRules([{ provider: providerId, models: ["hide-*"] }]),
        excludeRules: normalizeRules([{ provider: providerId, models: ["hide-classifier"] }]),
    };

    installModelRuntimePatch(runtime, () => replacement);
    installRegistryPatch(registry, () => replacement);
    assert.deepEqual(Object.getOwnPropertyDescriptor(runtime, "getAllModels"), runtimeCatalog);
    assert.deepEqual(Object.getOwnPropertyDescriptor(registry, "getModelsOfType"), registryCatalog);
    assert.deepEqual(
        runtime.getAllModels(providerId).map((model) => model.id),
        ["hide-chat"],
    );
    assert.deepEqual(
        (await runtime.getAllAvailable(providerId)).map((model) => model.id),
        ["hide-chat"],
    );
    assert.deepEqual(
        registry.getModelsOfType("chat", providerId).map((model) => model.id),
        ["hide-chat"],
    );
    assert.deepEqual(await registry.getAvailableOfType("image", providerId), []);
    assert.equal(registry.findOfType("classifier", providerId, "hide-classifier"), undefined);
    assert.equal(runtime.getModelOfType("image", providerId, "keep-image"), undefined);
});

test("missing typed catalog targets reject installation without marking or changing policy state", async () => {
    const runtime = await createRuntime();
    const registry = new ModelRegistry(runtime);
    const runtimeSymbols = Object.getOwnPropertySymbols(runtime);
    const registrySymbols = Object.getOwnPropertySymbols(registry);
    Object.defineProperty(runtime, "getModelsOfType", { value: undefined, configurable: true });
    Object.defineProperty(registry, "findOfType", { value: undefined, configurable: true });
    assert.throws(() => installModelRuntimePatch(runtime, () => settings), /expected methods/);
    assert.throws(() => installRegistryPatch(registry, () => settings), /expected methods/);
    assert.deepEqual(Object.getOwnPropertySymbols(runtime), runtimeSymbols);
    assert.deepEqual(Object.getOwnPropertySymbols(registry), registrySymbols);
    Reflect.deleteProperty(runtime, "getModelsOfType");
    Reflect.deleteProperty(registry, "findOfType");
    installModelRuntimePatch(runtime, () => settings);
    installRegistryPatch(registry, () => settings);
    assert.deepEqual(runtime.getModelsOfType("classifier", providerId), []);
    assert.equal(registry.findOfType("classifier", providerId, "hide-classifier"), undefined);
});

test("complete legacy base catalogs remain filtered without adding typed APIs", async () => {
    // Structural boundary mirrors the installed 0.85.1 prototypes (also exercised
    // by legacy-host.test.ts using that host's own extension loader).
    let policy = settings;
    const runtime = {
        getModels() {
            return chatModels;
        },
        async getAvailable() {
            return chatModels;
        },
        getAvailableSnapshot() {
            return chatModels;
        },
        getModel(provider: string, id: string) {
            return chatModels.find((model) => model.provider === provider && model.id === id);
        },
    };
    const registry = {
        getAll() {
            return chatModels;
        },
        getAvailable() {
            return chatModels;
        },
        find(provider: string, id: string) {
            return chatModels.find((model) => model.provider === provider && model.id === id);
        },
    };
    installModelRuntimePatch(runtime, () => policy);
    installRegistryPatch(registry, () => policy);
    const runtimeList = runtime.getModels;
    const registryList = registry.getAll;
    const ids = (models: readonly { id: string }[]) => models.map((model) => model.id);
    assert.deepEqual(ids(runtime.getModels()), ["keep-chat"]);
    assert.deepEqual(ids(await runtime.getAvailable()), ["keep-chat"]);
    assert.deepEqual(ids(runtime.getAvailableSnapshot()), ["keep-chat"]);
    assert.equal(runtime.getModel(providerId, "hide-chat"), undefined);
    assert.deepEqual(ids(registry.getAll()), ["keep-chat"]);
    assert.deepEqual(ids(registry.getAvailable()), ["keep-chat"]);
    assert.equal(registry.find(providerId, "hide-chat"), undefined);
    assert.equal(runtime.getModel(providerId, "keep-chat"), chatModels[0]);
    assert.equal(registry.find(providerId, "keep-chat"), chatModels[0]);
    assert.equal(Reflect.has(runtime, "getModelsOfType"), false);
    assert.equal(Reflect.has(runtime, "getAllAvailable"), false);
    assert.equal(Reflect.has(registry, "findOfType"), false);
    policy = { includeRules: [], excludeRules: [] };
    installModelRuntimePatch(runtime, () => policy);
    installRegistryPatch(registry, () => policy);
    assert.equal(runtime.getModels, runtimeList);
    assert.equal(registry.getAll, registryList);
    assert.deepEqual(ids(runtime.getModels()), ["keep-chat", "hide-chat"]);
    assert.deepEqual(ids(registry.getAvailable()), ["keep-chat", "hide-chat"]);
});

test("every partial or malformed typed group rejects before base wrappers and markers", async () => {
    const runtimeTargets = [
        "getModelsOfType",
        "getModelOfType",
        "getAllModels",
        "getAvailableOfType",
        "getAllAvailable",
    ];

    const registryTargets = [
        "getModelsOfType",
        "getModelOfType",
        "getAvailableOfType",
        "findOfType",
    ];
    for (const invalid of [undefined, null, 42]) {
        for (const target of runtimeTargets) {
            const runtime = await createRuntime();
            const symbols = Object.getOwnPropertySymbols(runtime);
            const original = runtime.getModels;
            Object.defineProperty(runtime, target, { value: invalid });
            assert.throws(
                () => installModelRuntimePatch(runtime, () => settings),
                /expected methods/,
            );
            assert.deepEqual(Object.getOwnPropertySymbols(runtime), symbols);
            assert.equal(runtime.getModels, original);
        }

        for (const target of registryTargets) {
            const registry = new ModelRegistry(await createRuntime());
            const symbols = Object.getOwnPropertySymbols(registry);
            const original = registry.getAll;
            Object.defineProperty(registry, target, { value: invalid });
            assert.throws(() => installRegistryPatch(registry, () => settings), /expected methods/);
            assert.deepEqual(Object.getOwnPropertySymbols(registry), symbols);
            assert.equal(registry.getAll, original);
        }
    }
});
