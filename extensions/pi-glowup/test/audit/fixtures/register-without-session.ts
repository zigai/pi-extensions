import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ExtensionRegistrationFixture } from "../../support/sdk-extension-fixture.ts";

type FilesystemEntry = {
    readonly path: string;
    readonly content: string;
};

function snapshot(directory: string, prefix = ""): readonly FilesystemEntry[] {
    const entries: FilesystemEntry[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relativePath = join(prefix, entry.name);
        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) {
            entries.push({ path: relativePath, content: "<directory>" });
            entries.push(...snapshot(absolutePath, relativePath));
        } else {
            entries.push({ path: relativePath, content: readFileSync(absolutePath, "base64") });
        }
    }

    return entries.sort((left, right) => left.path.localeCompare(right.path));
}

const agentDir = process.env.PI_CODING_AGENT_DIR;
assert.ok(
    agentDir !== undefined && agentDir.length > 0,
    "fixture requires its own agent directory",
);
const before = snapshot(agentDir);
const { default: glowupExtension } = await import("../../../src/index.ts");
assert.deepEqual(snapshot(agentDir), before, "module import must not create or migrate settings");

if (process.argv[2] === "registration") {
    const api = new ExtensionRegistrationFixture();
    glowupExtension(api);
    assert.ok(api.registrations.length > 0, "the real extension factory must register handlers");
    assert.deepEqual(
        snapshot(agentDir),
        before,
        "synchronous registration must not create, migrate or modify settings before session_start",
    );
}

console.log("registration phase completed without settings writes");
