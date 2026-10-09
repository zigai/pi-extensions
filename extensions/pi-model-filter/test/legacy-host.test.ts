import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const legacyHostAssertions = String.raw`
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const host = process.env.PI_MODEL_FILTER_LEGACY_HOST;
assert.ok(
    host !== undefined && host.length > 0,
    "Set PI_MODEL_FILTER_LEGACY_HOST to the 0.85.1 pi-coding-agent package directory",
);
const manifest = JSON.parse(await readFile(join(host, "package.json"), "utf8"));
assert.ok(manifest !== null && Object.hasOwn(manifest, "version"));
assert.equal(manifest.version, "0.85.1");
const agentDir = await mkdtemp(join(tmpdir(), "pi-filter-legacy-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";

try {
    const { ModelRuntime, ModelRegistry } = await import(
        pathToFileURL(join(host, "dist/index.js")).href
    );
    const { loadExtensions } =
        (
            await import(pathToFileURL(join(host, "dist/core/extensions/loader.js")).href)
        );
    const runtimeTyped = [
        "getModelsOfType",
        "getModelOfType",
        "getAllModels",
        "getAvailableOfType",
        "getAllAvailable",
    ];
    const registryTyped = ["getModelsOfType", "getModelOfType", "getAvailableOfType", "findOfType"];
    for (const key of runtimeTyped)
        assert.equal(Reflect.get(ModelRuntime.prototype, key), undefined);
    for (const key of registryTyped)
        assert.equal(Reflect.get(ModelRegistry.prototype, key), undefined);
    const extensionPath = process.argv[1];
    const loaded = await loadExtensions([extensionPath], agentDir);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.deepEqual(await readdir(agentDir), [], "factory must not read/write settings artifacts");
    for (const key of runtimeTyped)
        assert.equal(Reflect.get(ModelRuntime.prototype, key), undefined);
    for (const key of registryTyped)
        assert.equal(Reflect.get(ModelRegistry.prototype, key), undefined);
    assert.equal(
        Reflect.get(
            ModelRuntime.prototype,
            Symbol.for("@zigai/pi-model-filter/model-runtime-patched"),
        ),
        true,
    );
    assert.equal(
        Reflect.get(ModelRegistry.prototype, Symbol.for("@zigai/pi-model-filter/registry-patched")),
        true,
    );

    const providerId = "legacy-filter-test";
    const models = ["keep-chat", "hide-chat"].map((id) => ({
        id,
        name: id,
        provider: providerId,
        api: ("openai-completions"),
        baseUrl: "https://example.invalid",
        input: (["text"]),
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    const runtime = await ModelRuntime.create({
        credentials: {
            async read() {
                return undefined;
            },
            async list() {
                return [];
            },
            async modify() {
                throw new Error("No credential writes");
            },
            async delete() {
                throw new Error("No credential writes");
            },
        },
        modelsPath: null,
        refreshOnCreate: false,
    });
    runtime.registerNativeProvider({
        id: providerId,
        name: "Legacy filter test",
        auth: {
            apiKey: {
                name: "Keyless",
                async resolve({ signal }) {
                    signal.throwIfAborted();
                    return { auth: {} };
                },
            },
        },
        getModels() {
            return models;
        },
        stream() {
            throw new Error("No network requests");
        },
        streamSimple() {
            throw new Error("No network requests");
        },
    });
    await runtime.getAvailable();
    const registry = new ModelRegistry(runtime);
    const configDir = join(agentDir, "extension-settings");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "pi-model-filter.json");
    const config = JSON.stringify({
        include: [],
        exclude: [{ provider: providerId, models: ["hide-*"] }],
    });
    await writeFile(configPath, config);
    const extension = loaded.extensions[0];
    assert.ok(extension !== undefined);
    const handlers = extension.handlers.get("session_start");
    assert.ok(handlers !== undefined && handlers.length > 0);
    const diagnostics = [];
    for (const handler of handlers)
        await handler(
            { type: "session_start" },
            {
                cwd: agentDir,
                isProjectTrusted: () => false,
                modelRegistry: registry,
                hasUI: true,
                ui: {
                    notify(message) {
                        diagnostics.push(message);
                    },
                },
            },
        );
    assert.deepEqual(diagnostics, []);
    const ids = (catalog) =>
        catalog.filter((model) => model.provider === providerId).map((model) => model.id);
    assert.deepEqual(ids(runtime.getModels(providerId)), ["keep-chat"]);
    assert.deepEqual(ids(runtime.getModels()), ["keep-chat"]);
    assert.deepEqual(ids(await runtime.getAvailable(providerId)), ["keep-chat"]);
    assert.deepEqual(ids(await runtime.getAvailable()), ["keep-chat"]);
    assert.deepEqual(ids(runtime.getAvailableSnapshot()), ["keep-chat"]);
    assert.equal(runtime.getModel(providerId, "hide-chat"), undefined);
    assert.equal(runtime.getModel(providerId, "keep-chat"), models[0]);
    assert.deepEqual(ids(registry.getAll()), ["keep-chat"]);
    assert.deepEqual(ids(registry.getAvailable()), ["keep-chat"]);
    assert.equal(registry.find(providerId, "hide-chat"), undefined);
    assert.equal(registry.find(providerId, "keep-chat"), models[0]);
    const reason = new Error("Legacy cancellation");
    await assert.rejects(
        runtime.getAvailable(providerId, { signal: AbortSignal.abort(reason) }),
        (error) => error === reason,
    );
    assert.equal(await readFile(configPath, "utf8"), config, "settings must remain untouched");
    const originalRuntimeList = ModelRuntime.prototype.getModels;
    const stateKey = Symbol.for("@zigai/pi-model-filter/model-runtime-state");
    const originalState = Reflect.get(ModelRuntime.prototype, stateKey);
    Object.defineProperty(ModelRuntime.prototype, "getAllModels", {
        value: null,
        configurable: true,
    });
    const rejected = await loadExtensions([extensionPath], agentDir);
    assert.equal(rejected.extensions.length, 0);
    assert.equal(rejected.errors.length, 1);
    assert.match(
        rejected.errors[0].error,
        /Failed to load extension: Pi model runtime does not expose the expected methods/,
    );
    assert.equal(ModelRuntime.prototype.getModels, originalRuntimeList);
    assert.equal(Reflect.get(ModelRuntime.prototype, stateKey), originalState);
    Reflect.deleteProperty(ModelRuntime.prototype, "getAllModels");
    console.log("0.85.1 base catalogs and factory verified");
} finally {
    await rm(agentDir, { recursive: true, force: true });
}
`;

const host = process.env.PI_MODEL_FILTER_LEGACY_HOST;
test.skipIf(host === undefined)(
    "0.85.1 host loads the factory and filters every base catalog",
    () => {
        const output = execFileSync(
            process.execPath,
            [
                "--input-type=module",
                "--eval",
                legacyHostAssertions,
                fileURLToPath(new URL("../src/index.ts", import.meta.url)),
            ],
            { encoding: "utf8", timeout: 60_000 },
        );
        assert.match(output, /0\.85\.1 base catalogs and factory verified/);
    },
);
