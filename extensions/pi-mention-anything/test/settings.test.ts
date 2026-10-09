import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, test } from "vitest";

import { loadMentionAnythingSettings } from "../src/settings.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(path.join(tmpdir(), "pi-mention-anything-settings-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const settingsPath = path.join(agentDir, "extension-settings", "pi-mention-anything.json");

beforeEach(async () => {
    await rm(path.join(agentDir, "extension-settings"), { recursive: true, force: true });
});

afterAll(async () => {
    await rm(agentDir, { recursive: true, force: true });

    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

const context = {
    cwd: process.cwd(),
    isProjectTrusted() {
        return true;
    },
};

test("uses an empty set of mentions by default", () => {
    assert.deepEqual(loadMentionAnythingSettings(context), { mentions: [] });
});

test("decodes static and command mention definitions", async () => {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
        settingsPath,
        JSON.stringify({
            mentions: [
                {
                    id: "environments",
                    trigger: "%",
                    completionSuffix: " ",
                    source: {
                        type: "static",
                        items: [
                            { name: "staging" },
                            { name: "production", replacement: "environment:production" },
                        ],
                    },
                    initialSuggestions: {
                        strategy: "frecency",
                        pinned: [],
                    },
                },
                {
                    id: "tickets",
                    trigger: "&",
                    completionSuffix: "",
                    source: {
                        type: "command",
                        command: "list-tickets",
                        args: [],
                        debounceMs: 75,
                        timeoutMs: 2_000,
                        cache: true,
                        refreshOnStartup: true,
                        cacheTtlMs: 300_000,
                    },
                    initialSuggestions: {
                        strategy: "alphabetical",
                        pinned: [],
                    },
                },
            ],
        }),
        "utf8",
    );

    assert.deepEqual(loadMentionAnythingSettings(context), {
        mentions: [
            {
                id: "environments",
                trigger: "%",
                completionSuffix: " ",
                expansionPolicy: "selected-or-resolved",
                source: {
                    type: "static",
                    items: [
                        { name: "staging" },
                        { name: "production", replacement: "environment:production" },
                    ],
                },
                initialSuggestions: { strategy: "frecency", pinned: [] },
            },
            {
                id: "tickets",
                trigger: "&",
                completionSuffix: "",
                expansionPolicy: "selected-or-resolved",
                source: {
                    type: "command",
                    mode: "array",
                    filtering: "provider",
                    maxOutputBytes: 1048576,
                    command: "list-tickets",
                    args: [],
                    debounceMs: 75,
                    timeoutMs: 2_000,
                    cache: true,
                    refreshOnStartup: true,
                    cacheTtlMs: 300_000,
                },
                initialSuggestions: { strategy: "alphabetical", pinned: [] },
            },
        ],
    });
});
