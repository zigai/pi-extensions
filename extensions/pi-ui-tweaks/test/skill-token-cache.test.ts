import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { getSkillPromptSection, SkillTokenCache } from "../src/skill-token-cache.ts";

const section = "<skills>\n<available_skills>catalog</available_skills>\n</skills>";

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "pi-skill-tokens-"));

    return {
        path: join(directory, "tokens.json"),
        cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
}

test("only the effective skill catalog contributes; absent or malformed sections contribute zero", () => {
    assert.equal(getSkillPromptSection(`preamble\n\n${section}\n\n<cwd>/test</cwd>`), section);
    assert.equal(getSkillPromptSection("<context>Other instructions</context>"), "");
    assert.equal(getSkillPromptSection("<skills>\nUnrelated user text\n</skills>"), "");
    assert.equal(getSkillPromptSection("<skills>\n<available_skills>unterminated"), "");
});

test("persistent content cache skips estimation and writes on memory and process cache hits", () => {
    const f = fixture();
    let calls = 0;
    const estimate = (text: string) => {
        calls += 1;
        return Math.ceil(text.length / 4);
    };
    try {
        const first = new SkillTokenCache(f.path, estimate);
        assert.equal(first.count(""), 0);
        assert.equal(calls, 0);
        const tokens = first.count(section);
        const modified = statSync(f.path).mtimeMs;
        assert.equal(first.count(section), tokens);
        assert.equal(new SkillTokenCache(f.path, estimate).count(section), tokens);
        assert.equal(calls, 1);
        assert.equal(statSync(f.path).mtimeMs, modified);
        assert.equal(first.count(`${section} changed`), Math.ceil(`${section} changed`.length / 4));
        assert.equal(calls, 2);
        const document = readFileSync(f.path, "utf8");
        assert.ok(!document.includes("catalog"));
        assert.ok(!document.includes("available_skills"));
    } finally {
        f.cleanup();
    }
});

test("unrelated context changes reuse the same skill-section key", () => {
    const f = fixture();
    let calls = 0;
    const cache = new SkillTokenCache(f.path, () => {
        calls += 1;
        return 42;
    });
    try {
        assert.equal(cache.count(getSkillPromptSection(`context one\n${section}`)), 42);
        assert.equal(cache.count(getSkillPromptSection(`context two\n${section}`)), 42);
        assert.equal(calls, 1);
    } finally {
        f.cleanup();
    }
});

test("corrupt and unsupported cache documents are replaced; unavailable storage is non-fatal", () => {
    const f = fixture();
    try {
        for (const data of [
            "{",
            '{"version":2,"entries":[]}',
            '{"version":1,"entries":[["bad",-1]]}',
        ]) {
            writeFileSync(f.path, data);
            assert.equal(new SkillTokenCache(f.path).count(section), Math.ceil(section.length / 4));
        }

        writeFileSync(f.path, "blocking file");
        assert.equal(
            new SkillTokenCache(join(f.path, "child.json")).count(section),
            Math.ceil(section.length / 4),
        );
    } finally {
        f.cleanup();
    }
});

test("persistent cache is bounded even across many distinct skill catalogs", () => {
    const f = fixture();
    let calls = 0;
    const estimate = () => {
        calls += 1;
        return 5;
    };
    try {
        const cache = new SkillTokenCache(f.path, estimate);
        for (let index = 0; index < 40; index += 1) cache.count(`${section}${index}`);
        const restored = new SkillTokenCache(f.path, estimate);
        for (let index = 8; index < 40; index += 1) restored.count(`${section}${index}`);
        assert.equal(calls, 40);
        restored.count(`${section}0`);
        assert.equal(calls, 41);
    } finally {
        f.cleanup();
    }
});

test("native estimation includes skill catalog framing, not other context or full skill bodies", () => {
    const f = fixture();
    const hugeOtherContext = "Unrelated instructions ".repeat(10000);
    try {
        const prompt = `${hugeOtherContext}\n\n${section}\n\n<cwd>/test</cwd>`;
        assert.equal(
            new SkillTokenCache(f.path).count(getSkillPromptSection(prompt)),
            Math.ceil(section.length / 4),
        );
        assert.equal(new SkillTokenCache(f.path).count(getSkillPromptSection(hugeOtherContext)), 0);
    } finally {
        f.cleanup();
    }
});
