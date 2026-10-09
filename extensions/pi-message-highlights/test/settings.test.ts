import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import { loadMessageHighlightsSettings, resolveMessageHighlightsConfig } from "../src/settings.ts";

test("loadMessageHighlightsSettings scaffolds missing global config and schema", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-message-highlights-agent-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-message-highlights-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
        const configPath = path.join(agentDir, "extension-settings", "pi-message-highlights.json");
        const schemaPath = path.join(
            agentDir,
            "extension-settings",
            "schemas",
            "pi-message-highlights.schema.json",
        );
        const loaded = loadMessageHighlightsSettings(cwd, false);
        assert.deepEqual(loaded.errors, []);
        assert.deepEqual(loaded.config.urlColor, { kind: "hex", color: "#87d7ff" });
        assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
            $schema: "./schemas/pi-message-highlights.schema.json",
            urlColor: "#87d7ff",
        });
        assert.match(await readFile(schemaPath, "utf8"), /Pi Message Highlights settings/);
        const customConfig = JSON.stringify({ urlColor: "mdLink" });
        await writeFile(configPath, customConfig, "utf8");
        await writeFile(schemaPath, "stale schema", "utf8");
        const loadedAgain = loadMessageHighlightsSettings(cwd, false);
        assert.deepEqual(loadedAgain.config.urlColor, { kind: "theme", color: "mdLink" });
        assert.equal(await readFile(configPath, "utf8"), customConfig);
        assert.match(await readFile(schemaPath, "utf8"), /Pi Message Highlights settings/);
    } finally {
        await rm(agentDir, { recursive: true, force: true });
        await rm(cwd, { recursive: true, force: true });

        if (originalAgentDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        }
    }
});

test("resolveMessageHighlightsConfig defaults URL color to the original blue hex", () => {
    const loaded = resolveMessageHighlightsConfig([]);
    assert.deepEqual(loaded.config.urlColor, { kind: "hex", color: "#87d7ff" });
    assert.deepEqual(loaded.errors, []);
});

test("resolveMessageHighlightsConfig accepts supported URL color settings", () => {
    assert.deepEqual(
        resolveMessageHighlightsConfig([{ label: "settings", settings: { urlColor: 81 } }]).config
            .urlColor,
        { kind: "ansi256", color: 81 },
    );
    assert.deepEqual(
        resolveMessageHighlightsConfig([{ label: "settings", settings: { urlColor: "#87d7ff" } }])
            .config.urlColor,
        { kind: "hex", color: "#87d7ff" },
    );
    assert.deepEqual(
        resolveMessageHighlightsConfig([{ label: "settings", settings: { urlColor: "mdLink" } }])
            .config.urlColor,
        { kind: "theme", color: "mdLink" },
    );
    assert.deepEqual(
        resolveMessageHighlightsConfig([
            { label: "settings", settings: { urlColor: "thinkingMax" } },
        ]).config.urlColor,
        { kind: "theme", color: "thinkingMax" },
    );
    assert.deepEqual(
        resolveMessageHighlightsConfig([{ label: "settings", settings: { urlColor: "" } }]).config
            .urlColor,
        { kind: "none" },
    );
});

test("resolveMessageHighlightsConfig lets later sources override earlier sources", () => {
    const loaded = resolveMessageHighlightsConfig([
        { label: "global settings", settings: { urlColor: 117 } },
        { label: "project settings", settings: { urlColor: "accent" } },
    ]);

    assert.deepEqual(loaded.config.urlColor, { kind: "theme", color: "accent" });
    assert.deepEqual(loaded.errors, []);
});

test("resolveMessageHighlightsConfig rejects invalid URL colors", () => {
    const loaded = resolveMessageHighlightsConfig([
        { label: "settings", settings: { urlColor: 300 } },
    ]);

    assert.deepEqual(loaded.config.urlColor, { kind: "hex", color: "#87d7ff" });
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0] ?? "", /settings is invalid:/);
});

test("resolveMessageHighlightsConfig rejects unknown config keys", () => {
    const loaded = resolveMessageHighlightsConfig([
        { label: "settings", settings: { urlColour: 117 } },
    ]);

    assert.deepEqual(loaded.config.urlColor, { kind: "hex", color: "#87d7ff" });
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0] ?? "", /settings is invalid:/);
    assert.match(loaded.errors[0] ?? "", /additional properties/);
});
