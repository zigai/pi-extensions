import assert from "node:assert/strict";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

import { AliasPolicy } from "../src/alias-policy.ts";
import { installRegistryPatch } from "../src/registry-patch.ts";
import { installModelRuntimeAliasPatch } from "../src/model-runtime-patch.ts";
import type { AliasConfig } from "../src/model-aliasing.ts";

async function createRuntime() {
    const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
    });
    runtime.registerProvider("alias-test-physical", {
        api: "openai-completions",
        apiKey: "alias-test-key",
        baseUrl: "https://example.invalid/v1",
        models: [
            {
                id: "native-chat",
                name: "Native Chat",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 4096,
                maxTokens: 1024,
            },
        ],
    });
    await runtime.refresh({ allowNetwork: false });

    return runtime;
}

function patchModels(runtime: ModelRuntime, registry: ModelRegistry, aliases: AliasConfig[]) {
    const policy = new AliasPolicy({
        loadSettings: () => ({
            path: "alias-test-settings.json",
            mtimeMs: 1,
            settings: { aliases, providerAliases: [], stableProviderColumn: true },
        }),
    });
    installRegistryPatch(registry, policy);
    const patch = installModelRuntimeAliasPatch(runtime, policy);
    assert.ok(patch);
    return patch;
}

test("virtual alias lookup dispatches with the registered virtual identity", async () => {
    const runtime = await createRuntime();
    const registry = new ModelRegistry(runtime);
    const routedSelections: string[] = [];
    runtime.registerVirtualModel({
        provider: "alias-test-router",
        id: "auto",
        name: "Automatic",
        route(request) {
            routedSelections.push(request.model.id);
            const physical = registry.find("alias-test-physical", "native-chat");
            assert.ok(physical);
            return { model: physical, thinkingLevel: "off", state: { routed: true } };
        },
    });

    const patch = patchModels(runtime, registry, [
        { provider: "alias-test-router", model: "auto", alias: "short", name: "Short Router" },
    ]);

    const selected = registry.find("alias-test-router", "short");
    assert.ok(selected);
    const route = await runtime.resolveModel(selected, [], {
        reason: "user",
        thinkingLevel: "off",
    });

    assert.equal(selected.id, "short");
    assert.equal(selected.name, "Short Router");
    assert.deepEqual(routedSelections, ["auto"]);
    assert.equal(route.model.provider, "alias-test-physical");
    assert.equal(route.model.id, "native-chat");
    assert.equal(route.thinkingLevel, "off");
    assert.deepEqual(route.state, { routed: true });
    assert.equal(selected.id, "short");
    assert.equal(selected.name, "Short Router");
    patch.dispose();
});

test.each(["fast", "native-chat"])(
    "router lookup %s returns an aliased physical model with native dispatch identity",
    async (lookup) => {
        const runtime = await createRuntime();
        const registry = new ModelRegistry(runtime);
        const routedTargets: { id: string; name: string }[] = [];
        runtime.registerVirtualModel({
            provider: "alias-test-router",
            id: "auto",
            name: "Automatic",
            route() {
                const physical = registry.find("alias-test-physical", lookup);
                assert.ok(physical);
                routedTargets.push({ id: physical.id, name: physical.name });

                return { model: physical, thinkingLevel: "off" };
            },
        });

        const patch = patchModels(runtime, registry, [
            {
                provider: "alias-test-physical",
                model: "native-chat",
                alias: "fast",
                name: "Fast Chat",
            },
        ]);

        const selected = registry.find("alias-test-router", "auto");
        assert.ok(selected);
        const route = await runtime.resolveModel(selected, [], {
            reason: "user",
            thinkingLevel: "off",
        });

        assert.deepEqual(routedTargets, [{ id: "fast", name: "Fast Chat" }]);
        assert.equal(route.model.provider, "alias-test-physical");
        assert.equal(route.model.id, "native-chat");
        assert.equal(route.thinkingLevel, "off");
        assert.equal(runtime.getPhysicalModel("alias-test-physical", "fast")?.id, "native-chat");
        assert.equal(registry.find("alias-test-physical", lookup)?.id, "fast");
        assert.equal(registry.find("alias-test-physical", lookup)?.name, "Fast Chat");
        patch.dispose();
    },
);

test("CLI provider-qualified virtual aliases dispatch with native routing identity", async () => {
    const runtime = await createRuntime();
    const registry = new ModelRegistry(runtime);
    runtime.registerVirtualModel({
        provider: "alias-test-router",
        id: "auto",
        name: "Automatic",
        route() {
            const model = runtime.getPhysicalModel("alias-test-physical", "native-chat");
            assert.ok(model);
            return { model, thinkingLevel: "off" };
        },
    });
    const patch = patchModels(runtime, registry, [
        { provider: "alias-test-router", model: "auto", alias: "short", name: "Short Router" },
    ]);

    const selected = resolveCliModel({
        cliModel: "alias-test-router/short",
        modelRuntime: runtime,
    });
    assert.equal(selected.error, undefined);
    assert.ok(selected.model);
    assert.equal(selected.model.id, "short");
    const route = await runtime.resolveModel(selected.model, [], {
        reason: "user",
        thinkingLevel: "off",
    });

    assert.equal(route.model.provider, "alias-test-physical");
    assert.equal(route.model.id, "native-chat");
    assert.equal(registry.find("alias-test-router", "short")?.name, "Short Router");
    patch.dispose();
});

test("runtime alias patches update without stacking and restore their predecessors", async () => {
    const runtime = await createRuntime();
    const originalResolve = Object.getOwnPropertyDescriptor(runtime, "resolveModel");
    const originalPhysical = Object.getOwnPropertyDescriptor(runtime, "getPhysicalModel");
    const patch = patchModels(runtime, new ModelRegistry(runtime), [
        { provider: "alias-test-physical", model: "native-chat", alias: "fast" },
    ]);
    const installedResolve = Object.getOwnPropertyDescriptor(runtime, "resolveModel");
    const installedPhysical = Object.getOwnPropertyDescriptor(runtime, "getPhysicalModel");
    const updated = patchModels(runtime, new ModelRegistry(runtime), [
        { provider: "alias-test-physical", model: "native-chat", alias: "quick" },
    ]);

    assert.deepEqual(Object.getOwnPropertyDescriptor(runtime, "resolveModel"), installedResolve);
    assert.deepEqual(
        Object.getOwnPropertyDescriptor(runtime, "getPhysicalModel"),
        installedPhysical,
    );
    assert.equal(runtime.getPhysicalModel("alias-test-physical", "fast"), undefined);
    assert.equal(runtime.getPhysicalModel("alias-test-physical", "quick")?.id, "native-chat");
    updated.dispose();
    patch.dispose();
    assert.deepEqual(Object.getOwnPropertyDescriptor(runtime, "resolveModel"), originalResolve);
    assert.deepEqual(
        Object.getOwnPropertyDescriptor(runtime, "getPhysicalModel"),
        originalPhysical,
    );
    assert.equal(runtime.getPhysicalModel("alias-test-physical", "quick"), undefined);
});
