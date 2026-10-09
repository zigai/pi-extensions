import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

import type { ModelAliasSettingsLoadState } from "../src/settings.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "pi-model-alias-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const settings = await import("../src/settings.ts");
const configPath = settings.getGlobalConfigPath();
const schemaPath = join(agentDir, "extension-settings", "schemas", "pi-model-alias.schema.json");
await mkdir(join(configPath, ".."), { recursive: true });

afterAll(async () => {
    await rm(agentDir, { recursive: true, force: true });

    if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
    } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
});

function runtimeState(): ModelAliasSettingsLoadState {
    return {};
}

test("loadModelAliasSettings scaffolds defaults for a missing aliases file", async () => {
    await rm(configPath, { force: true });
    const loaded = settings.loadModelAliasSettings(runtimeState());
    assert.equal(loaded.path, configPath);
    assert.equal(loaded.diagnostic, undefined);
    assert.deepEqual(loaded.settings.aliases, []);
    assert.deepEqual(loaded.settings.providerAliases, []);
    assert.equal(loaded.settings.stableProviderColumn, true);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
        $schema: "./schemas/pi-model-alias.schema.json",
        aliases: [],
        providerAliases: [],
        stableProviderColumn: true,
    });
    assert.match(await readFile(schemaPath, "utf8"), /Pi Model Alias settings/);
    await writeFile(schemaPath, "stale schema", "utf8");
    await writeFile(configPath, "{ not json", "utf8");
    const loadedAgain = settings.loadModelAliasSettings(runtimeState());
    assert.match(loadedAgain.diagnostic ?? "", /Failed to load/);
    assert.equal(await readFile(configPath, "utf8"), "{ not json");
    assert.match(await readFile(schemaPath, "utf8"), /Pi Model Alias settings/);
});

test("loadModelAliasSettings reuses an unchanged config without reloading settings artifacts", async () => {
    await writeFile(
        configPath,
        JSON.stringify({
            aliases: [],
            providerAliases: [],
            stableProviderColumn: true,
        }),
        "utf8",
    );
    const state = runtimeState();
    const loaded = settings.loadModelAliasSettings(state);

    await writeFile(schemaPath, "stale after scaffold", "utf8");
    const loadedAgain = settings.loadModelAliasSettings(state);
    assert.equal(loadedAgain, loaded);
    assert.equal(await readFile(schemaPath, "utf8"), "stale after scaffold");
    state.configCache = undefined;
    settings.loadModelAliasSettings(state);
    assert.match(await readFile(schemaPath, "utf8"), /Pi Model Alias settings/);
});

test("loadModelAliasSettings parses and trims valid aliases", async () => {
    await writeFile(
        configPath,
        JSON.stringify({
            aliases: [
                {
                    provider: " openai ",
                    model: " gpt-5 ",
                    alias: " fast ",
                    name: " Fast Model ",
                },
            ],
            providerAliases: [{ provider: " anthropic ", name: " Claude Work " }],
            stableProviderColumn: false,
        }),
        "utf8",
    );

    const loaded = settings.loadModelAliasSettings(runtimeState());
    assert.equal(loaded.diagnostic, undefined);
    assert.deepEqual(loaded.settings.aliases, [
        { provider: "openai", model: "gpt-5", alias: "fast", name: "Fast Model" },
    ]);
    assert.deepEqual(loaded.settings.providerAliases, [
        { provider: "anthropic", name: "Claude Work" },
    ]);
    assert.equal(loaded.settings.stableProviderColumn, false);
});

test("loadModelAliasSettings rejects duplicate aliases without throwing", async () => {
    await writeFile(
        configPath,
        JSON.stringify({
            aliases: [
                { provider: "openai", model: "gpt-5", alias: "fast" },
                { provider: "openai", model: "gpt-4", alias: "fast" },
            ],
        }),
        "utf8",
    );

    const loaded = settings.loadModelAliasSettings(runtimeState());
    assert.deepEqual(loaded.settings.aliases, []);
    assert.deepEqual(loaded.settings.providerAliases, []);
    assert.match(loaded.diagnostic ?? "", /duplicates aliases\[0\]/);
});

test("loadModelAliasSettings rejects unknown config keys", async () => {
    await writeFile(
        configPath,
        JSON.stringify({
            aliases: [{ provider: "openai", model: "gpt-5", alias: "fast", note: "typo" }],
        }),
        "utf8",
    );

    const loaded = settings.loadModelAliasSettings(runtimeState());
    assert.deepEqual(loaded.settings.aliases, []);
    assert.deepEqual(loaded.settings.providerAliases, []);
    assert.match(loaded.diagnostic ?? "", /schema|property|ignored/);
});

test("loadModelAliasSettings rejects duplicate provider aliases without throwing", async () => {
    await writeFile(
        configPath,
        JSON.stringify({
            providerAliases: [
                { provider: "openai", name: "OpenAI Work" },
                { provider: "openai", name: "OpenAI Personal" },
            ],
        }),
        "utf8",
    );

    const loaded = settings.loadModelAliasSettings(runtimeState());
    assert.deepEqual(loaded.settings.aliases, []);
    assert.deepEqual(loaded.settings.providerAliases, []);
    assert.match(loaded.diagnostic ?? "", /duplicates providerAliases\[0\]/);
});

test("loadModelAliasSettings returns a readable error for malformed JSON", async () => {
    await writeFile(configPath, "{ not json", "utf8");

    const loaded = settings.loadModelAliasSettings(runtimeState());
    assert.deepEqual(loaded.settings.aliases, []);
    assert.deepEqual(loaded.settings.providerAliases, []);
    assert.match(loaded.diagnostic ?? "", /Failed to load/);
    assert.equal(await readFile(configPath, "utf8"), "{ not json");
});
