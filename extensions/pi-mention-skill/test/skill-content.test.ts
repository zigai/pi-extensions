import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
    createCachedSkillExpansionLoader,
    formatSkillBlock,
    stripFrontmatter,
} from "../src/skill-content.ts";

test("skill content preserves ordinary markdown and strips LF and CRLF frontmatter", () => {
    assert.equal(stripFrontmatter("# Heading\nBody"), "# Heading\nBody");
    assert.equal(stripFrontmatter("---\nname: demo\n---\nBody"), "Body");
    assert.equal(stripFrontmatter("---\r\nname: demo\r\n---\r\nBody"), "Body");
    assert.equal(stripFrontmatter("---\nUnclosed"), "---\nUnclosed");
});

test("skill content cache reuses unchanged files and reloads changed mtime", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "pi-skill-content-"));
    const location = path.join(baseDir, "SKILL.md");
    const target = { name: "demo", location, baseDir };
    try {
        await writeFile(location, "---\nname: demo\n---\n  Original body.\n");
        const initialTime = new Date("2025-01-01T00:00:00Z");
        await utimes(location, initialTime, initialTime);
        const originalStats = await stat(location);
        const load = createCachedSkillExpansionLoader();
        const first = await load(target);
        assert.equal(
            formatSkillBlock(first),
            `<skill name="demo" location="${location}">\nReferences are relative to ${baseDir}.\n\nOriginal body.\n</skill>`,
        );
        await writeFile(location, "Updated body.\n");
        await utimes(location, originalStats.atime, originalStats.mtime);
        assert.equal(await load(target), first);
        const updatedTime = new Date("2030-01-01T00:00:00Z");
        await utimes(location, updatedTime, updatedTime);
        assert.deepEqual(await load(target), { ...target, body: "Updated body." });
    } finally {
        await rm(baseDir, { recursive: true, force: true });
    }
});
