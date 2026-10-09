import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import { loadFooterSettings, resolveFooterConfig } from "../src/settings.ts";

test("loadFooterSettings scaffolds missing global config and schema", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-footer-agent-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-footer-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
        const configPath = path.join(agentDir, "extension-settings", "pi-footer.json");
        const schemaPath = path.join(
            agentDir,
            "extension-settings",
            "schemas",
            "pi-footer.schema.json",
        );
        const loaded = loadFooterSettings(cwd, false);
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.config.separator, "·");
        assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
            $schema: "./schemas/pi-footer.schema.json",
            separator: "·",
            showGitAheadBehind: false,
            layout: {
                left: ["path", "branch", "provider", "model", "thinking"],
                right: ["context"],
                hidden: [],
            },
        });
        assert.match(await readFile(schemaPath, "utf8"), /Pi Footer settings/);
        const customConfig = JSON.stringify({ separator: "/" });
        await writeFile(configPath, customConfig, "utf8");
        await writeFile(schemaPath, "stale schema", "utf8");
        const loadedAgain = loadFooterSettings(cwd, false);
        assert.equal(loadedAgain.config.separator, "/");
        assert.equal(await readFile(configPath, "utf8"), customConfig);
        assert.match(await readFile(schemaPath, "utf8"), /Pi Footer settings/);
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

test("resolveFooterConfig defaults to middle-dot separator", () => {
    const loaded = resolveFooterConfig([]);
    assert.equal(loaded.config.separator, "·");
    assert.equal(loaded.config.showGitAheadBehind, false);
    assert.deepEqual(loaded.config.layout, {
        left: ["path", "branch", "provider", "model", "thinking"],
        right: ["context"],
        hidden: [],
    });
    assert.deepEqual(loaded.errors, []);
});

test("resolveFooterConfig reads and sanitizes separator setting", () => {
    const loaded = resolveFooterConfig([
        {
            label: "global settings",
            settings: {
                separator: "  ·\n",
            },
        },
    ]);

    assert.equal(loaded.config.separator, "·");
    assert.deepEqual(loaded.errors, []);
});

test("resolveFooterConfig reads the git ahead/behind setting", () => {
    const loaded = resolveFooterConfig([
        {
            label: "global settings",
            settings: {
                showGitAheadBehind: true,
            },
        },
    ]);

    assert.equal(loaded.config.showGitAheadBehind, true);
    assert.deepEqual(loaded.errors, []);
});

test("resolveFooterConfig lets later sources override earlier sources", () => {
    const loaded = resolveFooterConfig([
        {
            label: "global settings",
            settings: {
                separator: "·",
            },
        },
        {
            label: "project settings",
            settings: {
                separator: "/",
            },
        },
    ]);

    assert.equal(loaded.config.separator, "/");
});

test("resolveFooterConfig reads configured layout slots", () => {
    const loaded = resolveFooterConfig([
        {
            label: "global settings",
            settings: {
                layout: {
                    left: ["model", "provider", "my-extension.status"],
                    right: ["context"],
                    hidden: ["thinking"],
                },
            },
        },
    ]);

    assert.deepEqual(loaded.config.layout, {
        left: ["model", "provider", "my-extension.status"],
        right: ["context"],
        hidden: ["thinking"],
    });
    assert.deepEqual(loaded.errors, []);
});

test("resolveFooterConfig merges partial layout overrides", () => {
    const loaded = resolveFooterConfig([
        {
            label: "global settings",
            settings: {
                layout: {
                    left: ["model", "provider"],
                },
            },
        },
        {
            label: "project settings",
            settings: {
                layout: {
                    hidden: ["provider"],
                },
            },
        },
    ]);

    assert.deepEqual(loaded.config.layout, {
        left: ["model", "provider"],
        right: ["context"],
        hidden: ["provider"],
    });
    assert.deepEqual(loaded.errors, []);
});

test("resolveFooterConfig reports invalid separator settings", () => {
    const loaded = resolveFooterConfig([
        {
            label: "global settings",
            settings: {
                separator: "   ",
            },
        },
    ]);

    assert.equal(loaded.config.separator, "·");
    assert.deepEqual(loaded.errors, [
        "global settings.separator must contain a visible character.",
    ]);
});

test("resolveFooterConfig rejects unknown config keys", () => {
    const loaded = resolveFooterConfig([
        {
            label: "global settings",
            settings: {
                seperator: "/",
            },
        },
    ]);

    assert.equal(loaded.config.separator, "·");
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0] ?? "", /global settings is invalid:/);
    assert.match(loaded.errors[0] ?? "", /additional properties/);
});

test("resolveFooterConfig rejects misspelled builtin layout slots", () => {
    const loaded = resolveFooterConfig([
        {
            label: "global settings",
            settings: {
                layout: {
                    left: ["mdoel"],
                },
            },
        },
    ]);

    assert.deepEqual(loaded.config.layout.left, [
        "path",
        "branch",
        "provider",
        "model",
        "thinking",
    ]);
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0] ?? "", /global settings is invalid:/);
});

test("resolveFooterConfig rejects slots placed on both sides", () => {
    const loaded = resolveFooterConfig([
        {
            label: "global settings",
            settings: {
                layout: {
                    left: ["model"],
                    right: ["model"],
                },
            },
        },
    ]);

    assert.deepEqual(loaded.config.layout, {
        left: ["path", "branch", "provider", "model", "thinking"],
        right: ["context"],
        hidden: [],
    });
    assert.deepEqual(loaded.errors, [
        'global settings.layout cannot place "model" on both left and right.',
    ]);
});

test("resolveFooterConfig rejects partial layout overrides that conflict with defaults", () => {
    const loaded = resolveFooterConfig([
        {
            label: "global settings",
            settings: {
                layout: {
                    right: ["model"],
                },
            },
        },
    ]);

    assert.deepEqual(loaded.config.layout, {
        left: ["path", "branch", "provider", "model", "thinking"],
        right: ["context"],
        hidden: [],
    });
    assert.deepEqual(loaded.errors, ['footer layout cannot place "model" on both left and right.']);
});

test("resolveFooterConfig lets hidden slots appear in both configured sides", () => {
    const loaded = resolveFooterConfig([
        {
            label: "global settings",
            settings: {
                layout: {
                    left: ["model"],
                    right: ["model"],
                    hidden: ["model"],
                },
            },
        },
    ]);

    assert.deepEqual(loaded.config.layout, {
        left: ["model"],
        right: ["model"],
        hidden: ["model"],
    });
    assert.deepEqual(loaded.errors, []);
});
