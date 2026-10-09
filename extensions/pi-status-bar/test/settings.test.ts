import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { loadStatusBarSettings, resolveStatusBarResolvedConfig } from "../src/settings.ts";

test("loadStatusBarSettings scaffolds missing global config and schema", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = mkdtempSync(join(tmpdir(), "pi-status-bar-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-status-bar-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
        const configPath = join(agentDir, "extension-settings", "pi-status-bar.json");
        const schemaPath = join(
            agentDir,
            "extension-settings",
            "schemas",
            "pi-status-bar.schema.json",
        );
        const loaded = loadStatusBarSettings(cwd, false);
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.config.rightMessages.enabled, false);
        assert.deepEqual(loaded.config.statusBar, {
            active: {
                timer: {
                    visible: true,
                    paused: false,
                },
            },
            idle: {
                visible: true,
                showLastRunSummary: true,
                showTokensPerSecond: true,
            },
        });
        assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
            $schema: "./schemas/pi-status-bar.schema.json",
            statusBar: {
                active: {
                    timer: {
                        visible: true,
                        paused: false,
                    },
                },
                idle: {
                    visible: true,
                    showLastRunSummary: true,
                    showTokensPerSecond: true,
                },
            },
            rightMessages: {
                enabled: false,
                intervalMs: 10000,
                minGap: 4,
                minScrollCycles: 1,
                scrollColumnIntervalMs: 120,
                dimmed: true,
                italic: true,
                messages: [],
            },
        });
        assert.match(await readFile(schemaPath, "utf8"), /Pi Status Bar settings/);
        const customConfig = JSON.stringify({ rightMessages: { messages: ["hello"] } });
        writeFileSync(configPath, customConfig, "utf8");
        writeFileSync(schemaPath, "stale schema", "utf8");
        const loadedAgain = loadStatusBarSettings(cwd, false);
        assert.deepEqual(loadedAgain.config.rightMessages.messages, ["hello"]);
        assert.equal(await readFile(configPath, "utf8"), customConfig);
        assert.match(await readFile(schemaPath, "utf8"), /Pi Status Bar settings/);
    } finally {
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });

        if (originalAgentDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        }
    }
});

test("status bar right messages default to disabled", () => {
    const loaded = resolveStatusBarResolvedConfig([]);
    assert.equal(loaded.config.rightMessages.enabled, false);
    assert.equal(loaded.config.statusBar.active?.timer?.visible, true);
    assert.equal(loaded.config.statusBar.idle?.showLastRunSummary, true);
    assert.equal(loaded.config.statusBar.idle.showTokensPerSecond, true);
    assert.equal(loaded.config.rightMessages.dimmed, true);
    assert.equal(loaded.config.rightMessages.italic, true);
    assert.deepEqual(loaded.config.rightMessages.messages, []);
    assert.deepEqual(loaded.errors, []);
});

test("status bar status bar parses active and idle config", () => {
    const loaded = resolveStatusBarResolvedConfig([
        {
            label: "global",
            baseDir: ".",
            settings: {
                statusBar: {
                    active: {
                        text: " Working\nnow ",
                        spinner: {
                            frames: [" ◐ ", "", "◓"],
                        },
                        timer: {
                            visible: false,
                            paused: true,
                        },
                    },
                    idle: {
                        text: " Ready\tnow ",
                        visible: true,
                        showLastRunSummary: false,
                        showTokensPerSecond: false,
                    },
                },
            },
        },
    ]);

    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.config.statusBar, {
        active: {
            text: "Working now",
            spinner: {
                frames: ["◐", "◓"],
            },
            timer: {
                visible: false,
                paused: true,
            },
        },
        idle: {
            text: "Ready now",
            visible: true,
            showLastRunSummary: false,
            showTokensPerSecond: false,
        },
    });
});

test("status bar right messages use inline configured messages", () => {
    const loaded = resolveStatusBarResolvedConfig([
        {
            label: "global",
            baseDir: ".",
            settings: {
                rightMessages: {
                    intervalMs: 5000,
                    minGap: 8,
                    minScrollCycles: 2,
                    scrollColumnIntervalMs: 80,
                    dimmed: false,
                    italic: false,
                    messages: ["Tip one", "", " Tip two "],
                },
            },
        },
    ]);

    assert.equal(loaded.config.rightMessages.enabled, true);
    assert.equal(loaded.config.rightMessages.intervalMs, 5000);
    assert.equal(loaded.config.rightMessages.minGap, 8);
    assert.equal(loaded.config.rightMessages.minScrollCycles, 2);
    assert.equal(loaded.config.rightMessages.scrollColumnIntervalMs, 80);
    assert.equal(loaded.config.rightMessages.dimmed, false);
    assert.equal(loaded.config.rightMessages.italic, false);
    assert.deepEqual(loaded.config.rightMessages.messages, ["Tip one", "Tip two"]);
});

test("status bar right messages load messages from a text file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-status-bar-"));
    try {
        writeFileSync(
            join(directory, "tips.txt"),
            "# comments are ignored\n\nFirst file tip\n  Second file tip  \n",
            "utf8",
        );

        const loaded = resolveStatusBarResolvedConfig([
            {
                label: "global",
                baseDir: directory,
                settings: {
                    rightMessages: {
                        messages: ["Inline tip"],
                        messagesFile: "tips.txt",
                    },
                },
            },
        ]);

        assert.equal(loaded.config.rightMessages.enabled, true);
        assert.deepEqual(loaded.config.rightMessages.messages, [
            "Inline tip",
            "First file tip",
            "Second file tip",
        ]);
        assert.deepEqual(loaded.errors, []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("status bar right messages merge sources in precedence order", () => {
    const loaded = resolveStatusBarResolvedConfig([
        {
            label: "global",
            baseDir: ".",
            settings: {
                rightMessages: {
                    intervalMs: 5000,
                    messages: ["global tip"],
                },
            },
        },
        {
            label: "project",
            baseDir: ".",
            settings: {
                rightMessages: {
                    intervalMs: 12_000,
                },
            },
        },
    ]);

    assert.equal(loaded.config.rightMessages.intervalMs, 12_000);
    assert.deepEqual(loaded.config.rightMessages.messages, ["global tip"]);
});

test("status bar right messages enabled false skips configured files", () => {
    const loaded = resolveStatusBarResolvedConfig([
        {
            label: "global",
            baseDir: ".",
            settings: {
                rightMessages: {
                    enabled: false,
                    messages: ["hidden tip"],
                    messagesFile: "missing.txt",
                },
            },
        },
    ]);

    assert.equal(loaded.config.rightMessages.enabled, false);
    assert.deepEqual(loaded.config.rightMessages.messages, []);
    assert.deepEqual(loaded.errors, []);
});

test("status bar right messages report invalid values", () => {
    const loaded = resolveStatusBarResolvedConfig([
        {
            label: "global",
            baseDir: ".",
            settings: {
                rightMessages: {
                    enabled: "yes",
                    intervalMs: 0,
                    minGap: -1,
                    minScrollCycles: 0,
                    scrollColumnIntervalMs: 0,
                    dimmed: "sometimes",
                    italic: "sure",
                    messages: ["ok", 123],
                    messagesFile: "",
                },
            },
        },
    ]);

    assert.equal(loaded.config.rightMessages.enabled, false);
    assert.deepEqual(loaded.config.rightMessages.messages, []);
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0] ?? "", /global is invalid:/);
    assert.match(loaded.errors[0] ?? "", /rightMessages/);
    assert.match(loaded.errors[0] ?? "", /messages/);
});

test("status bar right messages reject unknown config keys", () => {
    const loaded = resolveStatusBarResolvedConfig([
        {
            label: "global",
            baseDir: ".",
            settings: {
                rightMessages: {
                    mesages: ["typo"],
                },
            },
        },
    ]);

    assert.equal(loaded.config.rightMessages.enabled, false);
    assert.deepEqual(loaded.config.rightMessages.messages, []);
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0] ?? "", /global is invalid:/);
    assert.match(loaded.errors[0] ?? "", /additional properties/);
});
