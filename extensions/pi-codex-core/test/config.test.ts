import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "vitest";
import extension from "../src/index.ts";
import {
    CODEX_CURRENT_MODEL_SELECTION,
    DEFAULT_CODEX_CORE_CONFIG,
    DEFAULT_CODEX_CORE_CONFIG_JSON,
    codexCoreConfigJsonSchema,
    getCodexCoreConfigPath,
    getCodexCoreGlobalConfigSchemaPath,
    getCodexCoreProjectConfigPath,
    parseCodexCoreConfig,
    parseCodexCoreConfigWithDiagnostics,
    readCodexCoreConfig,
    readCodexCoreConfigWithDiagnostics,
    writeCodexCoreConfig,
} from "../src/config/config.ts";
import { makeExtensionHarness, makeExtensionContext } from "./helpers.ts";

test("parses codex config with safe defaults", () => {
    const config = parseCodexCoreConfig({
        scope: { tools: "all" },
        tools: { webSearch: false, webSearchMode: "indexed", viewImageDescriptions: true },
        prompt: { mode: "codex", personality: "friendly" },
        compaction: { enabled: true, auto: false, thresholdPercent: 90 },
        recovery: { enabled: true, maxAttempts: 5, baseDelayMs: 15_000 },
        openai: { verbosity: "high", compactionReasoning: "low" },
    });

    assert.equal(config.scope.tools, "all");
    assert.equal(config.tools.webSearch, false);
    assert.equal(config.tools.webSearchMode, "indexed");
    assert.equal(config.tools.imageGeneration, DEFAULT_CODEX_CORE_CONFIG.tools.imageGeneration);
    assert.equal(config.tools.viewImageDescriptions, true);
    assert.equal(config.tools.applyPatch, "off");
    assert.equal(config.prompt.mode, "codex");
    assert.equal(config.prompt.personality, "friendly");
    assert.equal(config.compaction.enabled, true);
    assert.equal(config.compaction.auto, false);
    assert.equal(config.compaction.thresholdPercent, 90);
    assert.equal(config.recovery.enabled, true);
    assert.equal(config.recovery.batchFollowUps, false);
    assert.equal(config.recovery.maxAttempts, 5);
    assert.equal(config.recovery.baseDelayMs, 15_000);
    assert.equal(config.recovery.maxDelayMs, 120_000);
    assert.equal(parseCodexCoreConfig({}).tools.webSearchMode, "live");
    assert.equal(
        parseCodexCoreConfig({ tools: { webSearchMode: "offline" } }).tools.webSearchMode,
        "live",
    );
    assert.equal(parseCodexCoreConfig({}).compaction.enabled, true);
    assert.equal(parseCodexCoreConfig({}).compaction.thresholdPercent, 80);
    assert.equal(parseCodexCoreConfig({}).prompt.mode, "codex");
    assert.equal(parseCodexCoreConfig({}).prompt.personality, "pragmatic");
    assert.equal(
        parseCodexCoreConfig({ prompt: { personality: "verbose" } }).prompt.personality,
        "pragmatic",
    );
    assert.equal(parseCodexCoreConfig({}).openai.compactionReasoning, "medium");
    assert.equal(parseCodexCoreConfig({}).openai.showReasoningTraces, true);
    assert.equal(
        parseCodexCoreConfig({ openai: { showReasoningTraces: false } }).openai.showReasoningTraces,
        false,
    );
    assert.equal(
        parseCodexCoreConfig({ openai: { showReasoningTraces: "no" } }).openai.showReasoningTraces,
        true,
    );
    assert.equal(
        parseCodexCoreConfig({ openai: { verbosity: "high" } }).openai.compactionModel,
        CODEX_CURRENT_MODEL_SELECTION,
    );
    assert.equal(config.openai.webSearchModel, CODEX_CURRENT_MODEL_SELECTION);
    assert.equal(config.openai.imageDescriptionModel, CODEX_CURRENT_MODEL_SELECTION);
    assert.equal(config.openai.compactionModel, CODEX_CURRENT_MODEL_SELECTION);
    assert.equal(config.openai.verbosity, "high");
    assert.equal(config.openai.compactionReasoning, "low");
    assert.equal(
        parseCodexCoreConfig({ openai: { compactionReasoning: "future-effort" } }).openai
            .compactionReasoning,
        "future-effort",
    );
    assert.equal(
        parseCodexCoreConfig({ openai: { compactionReasoning: " " } }).openai.compactionReasoning,
        "medium",
    );
});

test("rejects fractional compaction threshold percentages", () => {
    const result = parseCodexCoreConfigWithDiagnostics({
        compaction: { thresholdPercent: 80.9 },
    });

    assert.equal(result.config.compaction.thresholdPercent, 80);
    assert.deepEqual(result.diagnostics, [
        {
            _tag: "CodexConfigDiagnostic",
            path: "$.compaction.thresholdPercent",
            reason: "invalid",
            message: "Expected an integer from 1 to 99.",
        },
    ]);
});

test("rejects invalid recovery bounds", () => {
    const result = parseCodexCoreConfigWithDiagnostics({
        recovery: { maxAttempts: 11, baseDelayMs: 999, maxDelayMs: 900_001 },
    });

    assert.deepEqual(result.config.recovery, DEFAULT_CODEX_CORE_CONFIG.recovery);
    assert.deepEqual(
        result.diagnostics.map(({ path }) => path),
        ["$.recovery.maxAttempts", "$.recovery.baseDelayMs", "$.recovery.maxDelayMs"],
    );
});

test("reads codex config as optional defaults and scaffolds global files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-config-"));
    try {
        const agentDir = join(root, "agent");
        const config = readCodexCoreConfig({ agentDir });

        assert.deepEqual(config, DEFAULT_CODEX_CORE_CONFIG);
        assert.deepEqual(
            JSON.parse(await readFile(getCodexCoreConfigPath(agentDir), "utf8")),
            DEFAULT_CODEX_CORE_CONFIG_JSON,
        );
        assert.deepEqual(
            JSON.parse(await readFile(getCodexCoreGlobalConfigSchemaPath(agentDir), "utf8")),
            codexCoreConfigJsonSchema(),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("does not overwrite malformed existing codex config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-config-"));
    try {
        const agentDir = join(root, "agent");
        const configPath = getCodexCoreConfigPath(agentDir);
        await mkdir(join(configPath, ".."), { recursive: true });
        await writeFile(configPath, "{not json");

        const readResult = readCodexCoreConfigWithDiagnostics({ agentDir });

        assert.deepEqual(readResult.config, DEFAULT_CODEX_CORE_CONFIG);
        assert.equal(readResult.diagnostics.length, 1);
        assert.equal(readResult.diagnostics[0]?.reason, "malformed-json");
        assert.equal(readResult.diagnostics[0]?.path, configPath);
        const writeResult = writeCodexCoreConfig(DEFAULT_CODEX_CORE_CONFIG, configPath);
        assert.ok(!writeResult.ok);
        assert.match(writeResult.error, /Refusing to overwrite malformed config/);
        assert.equal(await readFile(configPath, "utf8"), "{not json");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("fails extension activation on malformed global config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-config-activation-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const configPath = getCodexCoreConfigPath(agentDir);
        await mkdir(join(configPath, ".."), { recursive: true });
        await writeFile(configPath, "{not json");

        assert.throws(
            () => extension(makeExtensionHarness().api),
            (cause) => {
                assert.ok(cause instanceof Error);
                assert.equal(cause.name, "CodexConfigStartupError");
                assert.match(cause.message, /\(malformed-json\)/);
                assert.match(cause.message, new RegExp(configPath.replaceAll("/", "\\/")));
                assert.doesNotMatch(cause.message, /\{not json/);
                return true;
            },
        );
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});

test("replaces user config atomically without leaving temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-config-"));
    try {
        const configPath = join(root, "config.json");
        await writeFile(configPath, "{}\n", { mode: 0o640 });
        const nextConfig = {
            ...DEFAULT_CODEX_CORE_CONFIG,
            tools: { ...DEFAULT_CODEX_CORE_CONFIG.tools, webSearch: false },
        };

        const result = writeCodexCoreConfig(nextConfig, configPath);

        assert.deepEqual(result, { ok: true });
        assert.equal(readCodexCoreConfig(configPath).tools.webSearch, false);
        assert.equal((await stat(configPath)).mode & 0o777, 0o640);
        assert.deepEqual(await readdir(root), ["config.json"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("refreshes stale codex config schema without rewriting user config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-config-"));
    try {
        const agentDir = join(root, "agent");
        const configPath = getCodexCoreConfigPath(agentDir);
        const schemaPath = getCodexCoreGlobalConfigSchemaPath(agentDir);
        await mkdir(join(configPath, ".."), { recursive: true });
        await writeFile(configPath, "{not json");
        await writeFile(schemaPath, "{}\n");

        const config = readCodexCoreConfig({ agentDir });

        assert.deepEqual(config, DEFAULT_CODEX_CORE_CONFIG);
        assert.equal(await readFile(configPath, "utf8"), "{not json");
        assert.deepEqual(
            JSON.parse(await readFile(schemaPath, "utf8")),
            codexCoreConfigJsonSchema(),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("keeps codex config schema file aligned with TypeBox source", async () => {
    const schema: unknown = JSON.parse(await readFile("config.schema.json", "utf8"));

    assert.deepEqual(schema, codexCoreConfigJsonSchema());
});

test("merges project codex config over global config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-config-"));
    try {
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        const globalConfigPath = getCodexCoreConfigPath(agentDir);
        const projectConfigPath = getCodexCoreProjectConfigPath(cwd);
        await mkdir(join(globalConfigPath, ".."), { recursive: true });
        await mkdir(join(projectConfigPath, ".."), { recursive: true });
        await writeFile(globalConfigPath, JSON.stringify({ prompt: { mode: "codex" } }));
        await writeFile(projectConfigPath, JSON.stringify({ tools: { webSearch: false } }));

        const config = readCodexCoreConfig({ agentDir, cwd });

        assert.equal(config.prompt.mode, "codex");
        assert.equal(config.tools.webSearch, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("ignores project codex config when session cwd is untrusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-config-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const globalConfigPath = getCodexCoreConfigPath(agentDir);
        const projectConfigPath = getCodexCoreProjectConfigPath(cwd);
        await mkdir(join(globalConfigPath, ".."), { recursive: true });
        await mkdir(join(projectConfigPath, ".."), { recursive: true });
        await writeFile(globalConfigPath, JSON.stringify({ tools: { webSearch: true } }));
        await writeFile(projectConfigPath, JSON.stringify({ tools: { webSearch: false } }));

        const harness = makeExtensionHarness();
        extension(harness.api);
        await harness.startSession(makeExtensionContext(cwd, false));

        assert.ok(harness.activeTools.includes("web_run"));
        assert.equal(harness.activeTools.includes("apply_patch"), false);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});

test("fails session startup on trusted project config diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-config-startup-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const harness = makeExtensionHarness();
        extension(harness.api);
        const projectConfigPath = getCodexCoreProjectConfigPath(cwd);
        await mkdir(join(projectConfigPath, ".."), { recursive: true });
        await writeFile(
            projectConfigPath,
            JSON.stringify({ compaction: { thresholdPercent: 1.5 } }),
        );

        await assert.rejects(harness.startSession(makeExtensionContext(cwd, true)), (cause) => {
            assert.ok(cause instanceof Error);
            assert.equal(cause.name, "CodexConfigStartupError");
            assert.match(cause.message, /\$\.compaction\.thresholdPercent \(invalid\)/);
            assert.doesNotMatch(cause.message, /1\.5/);
            return true;
        });
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});
