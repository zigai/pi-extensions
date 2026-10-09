import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
    getPersistedMaxVisibleLines,
    getPersistedMode,
    getPersistedPreviewEnabled,
    getPersistedPreviewFullHeight,
    setSettingsContext,
} from "../src/settings.ts";

test("tree settings scaffold missing global config and schema", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-tree-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
        const configPath = path.join(agentDir, "extension-settings", "pi-tree.json");
        const schemaPath = path.join(
            agentDir,
            "extension-settings",
            "schemas",
            "pi-tree.schema.json",
        );
        const context = {
            cwd: path.join(agentDir, "project"),
            isProjectTrusted: () => false,
        };
        setSettingsContext(context);
        assert.equal(getPersistedMode(), "relative");
        assert.equal(getPersistedPreviewEnabled(), false);
        assert.equal(getPersistedPreviewFullHeight(), true);
        assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
            $schema: "./schemas/pi-tree.schema.json",
            treeTimestampMode: "relative",
            treeSelectedPreview: false,
            treePreviewFullHeight: true,
        });
        assert.match(await readFile(schemaPath, "utf8"), /Pi Tree settings/);
        const customConfig = JSON.stringify({ treeTimestampMode: "off", treeMaxVisibleLines: 7 });
        await writeFile(configPath, customConfig, "utf8");
        await writeFile(schemaPath, "stale schema", "utf8");
        setSettingsContext(context);
        assert.equal(getPersistedMaxVisibleLines(), 7);
        assert.equal(await readFile(configPath, "utf8"), customConfig);
        assert.match(await readFile(schemaPath, "utf8"), /Pi Tree settings/);
    } finally {
        await rm(agentDir, { recursive: true, force: true });

        if (originalAgentDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        }
    }
});

test("tree settings reject unknown config keys", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-tree-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
        const configPath = path.join(agentDir, "extension-settings", "pi-tree.json");
        await mkdir(path.dirname(configPath), { recursive: true });
        await writeFile(
            configPath,
            JSON.stringify({ treeTimestampMode: "off", treeTimestampModeTypo: "absolute" }),
            "utf8",
        );
        setSettingsContext({
            cwd: path.join(agentDir, "project"),
            isProjectTrusted() {
                return false;
            },
        });

        assert.equal(getPersistedMode(), "relative");
    } finally {
        await rm(agentDir, { recursive: true, force: true });

        if (originalAgentDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        }
    }
});
