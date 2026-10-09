import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import { createCachedSkillExpansionLoader } from "../src/skill-content.ts";
import { createSkillProvider, resolveSkillCandidate } from "../src/skill-provider.ts";
import type { SkillCommand } from "../src/skill-commands.ts";

function skillCommand(name: string, filePath: string, discoveryRoot: string): SkillCommand {
    return {
        source: "skill",
        name: `skill:${name}`,
        description: "test skill",
        sourceInfo: {
            path: filePath,
            source: "skill",
            scope: "project",
            origin: "top-level",
            baseDir: discoveryRoot,
        },
    };
}

function signal(): AbortSignal {
    return new AbortController().signal;
}

test("skill provider resolves manually and preserves selected snapshots across refresh", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-mention-skill-provider-"));
    const skillDir = path.join(dir, "skills", "python");
    const filePath = path.join(skillDir, "SKILL.md");
    let commands: SkillCommand[] = [skillCommand("python", filePath, dir)];

    try {
        await mkdir(skillDir, { recursive: true });
        await writeFile(filePath, "Initial body.\n", "utf8");
        const loadExpansion = createCachedSkillExpansionLoader();
        const provider = createSkillProvider(() => [...commands], loadExpansion, {
            projectSkillsFirst: false,
        });
        const discovery = await provider.discover({
            sourceId: "skill",
            cwd: dir,
            trusted: true,
            query: "python",
            path: [],
            limit: 20,
            signal: signal(),
        });
        const selected = discovery.items.at(0);
        if (selected === undefined) assert.fail("expected discovered skill candidate");

        const manual = await provider.resolve({
            sourceId: "skill",
            cwd: dir,
            trusted: true,
            segments: ["python"],
            signal: signal(),
        });
        assert.equal(manual.status, "resolved");
        assert.match(manual.replacement ?? "", /Initial body\./);
        assert.equal(manual.replacement?.split("\n")[1], `References are relative to ${skillDir}.`);
        commands = [];
        await writeFile(filePath, "Body loaded after selection.\n", "utf8");
        const refreshedTime = new Date("2030-01-01T00:00:00.000Z");
        await utimes(filePath, refreshedTime, refreshedTime);
        const selectedReplacement = await resolveSkillCandidate(
            [selected],
            loadExpansion,
            signal(),
        );
        assert.match(selectedReplacement, /Body loaded after selection\./);
        assert.equal(selectedReplacement.split("\n")[1], `References are relative to ${skillDir}.`);

        const refreshed = await provider.resolve({
            sourceId: "skill",
            cwd: dir,
            trusted: true,
            segments: ["python"],
            signal: signal(),
        });
        assert.deepEqual(refreshed, { status: "unresolved", reason: "missing" });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
