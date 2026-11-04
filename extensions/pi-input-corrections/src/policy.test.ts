import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCorrectionPolicy, policySchema } from "./policy-loader.ts";

let root: string;
let configFile: string;
let policyFile: string;
const prompt = "can you help'";

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "correction-policy-"));
    configFile = join(root, "settings.json");
    policyFile = join(root, "policy.json");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("shared correction policy boundary", () => {
    it("keeps the canonical JSON schema synchronized with TypeBox", () => {
        expect(
            JSON.parse(readFileSync(new URL("../policy.schema.json", import.meta.url), "utf8")),
        ).toEqual(policySchema);
    });

    it("silently disables an empty path without reading a file", () => {
        const loaded = loadCorrectionPolicy("", configFile);
        expect(loaded.diagnostics).toEqual([]);
        expect(loaded.engine.correct(prompt)).toBe(prompt);
    });

    it.each(["missing", "directory"])(
        "disables the whole policy on %s without exposing values",
        (failure) => {
            let path = policyFile;

            if (failure === "directory") path = root;

            const loaded = loadCorrectionPolicy(path, configFile);

            expect(loaded.engine.correct(prompt)).toBe(prompt);
            expect(loaded.diagnostics).toHaveLength(1);
            expect(loaded.diagnostics[0]?.severity).toBe("error");
            expect(loaded.diagnostics[0]?.message).not.toContain("secret-value");
        },
    );

    it.each([
        { name: "malformed", content: '{"secret-value":' },
        {
            name: "wrong-type",
            content: '{"version":1,"rules":[],"trailingQuestionMark":"secret-value"}',
        },
        { name: "unknown-field", content: '{"version":1,"rules":[],"secret-value":true}' },
        {
            name: "invalid-rule",
            content:
                '{"version":1,"rules":[{"name":"secret-value","find":7,"replacement":"secret-value"}]}',
        },
    ])("disables the whole policy on $name without exposing values", ({ content }) => {
        writeFileSync(policyFile, content);
        const loaded = loadCorrectionPolicy(policyFile, configFile);

        expect(loaded.engine.correct(prompt)).toBe(prompt);
        expect(loaded.diagnostics).toHaveLength(1);
        expect(loaded.diagnostics[0]?.severity).toBe("error");
        expect(loaded.diagnostics[0]?.message).not.toContain("secret-value");
        expect(readFileSync(policyFile, "utf8")).toBe(content);
    });

    it("resolves relative policy paths beside config, not the process cwd", () => {
        writeFileSync(policyFile, '{"version":1,"rules":[]}');
        expect(loadCorrectionPolicy("./policy.json", configFile).engine.correct(prompt)).toBe(
            "can you help?",
        );

        expect(loadCorrectionPolicy(policyFile, configFile).engine.correct(prompt)).toBe(
            "can you help?",
        );
    });

    it("expands ~/ in policy and config paths using the OS home without writing there", () => {
        writeFileSync(policyFile, '{"version":1,"rules":[]}');
        const homePolicy = `~/${relative(homedir(), policyFile)}`;
        const homeConfig = `~/${relative(homedir(), configFile)}`;
        expect(loadCorrectionPolicy(homePolicy, configFile).engine.correct(prompt)).toBe(
            "can you help?",
        );

        expect(loadCorrectionPolicy("./policy.json", homeConfig).engine.correct(prompt)).toBe(
            "can you help?",
        );
    });

    it("rejects a relative config base rather than consulting cwd", () => {
        writeFileSync(policyFile, '{"version":1,"rules":[]}');
        const loaded = loadCorrectionPolicy(policyFile, "settings.json");
        expect(loaded.engine.correct(prompt)).toBe(prompt);
        expect(loaded.diagnostics[0]?.severity).toBe("error");
    });

    it("accepts schema metadata/defaults and skips semantic failures without leaking policy", () => {
        writeFileSync(
            policyFile,
            JSON.stringify({
                $schema: "/local/policy.schema.json",
                version: 1,
                rules: [
                    { name: "secret-name", kind: "regex", find: "(", replacement: "secret-value" },
                    { name: "valid", find: "help", replacement: "assist" },
                ],
            }),
        );
        const loaded = loadCorrectionPolicy(policyFile, configFile);
        expect(loaded.engine.correct(prompt)).toBe("can you assist?");
        expect(loaded.diagnostics).toHaveLength(1);
        expect(loaded.diagnostics[0]?.severity).toBe("warning");
        expect(loaded.diagnostics[0]?.message).not.toContain("secret");
    });

    it("does not globally cache a load; adapter sessions own cache lifetime", () => {
        writeFileSync(policyFile, '{"version":1,"rules":[]}');
        const first = loadCorrectionPolicy(policyFile, configFile);
        writeFileSync(policyFile, '{"version":1,"rules":[],"trailingQuestionMark":false}');
        expect(first.engine.correct(prompt)).toBe("can you help?");
        expect(loadCorrectionPolicy(policyFile, configFile).engine.correct(prompt)).toBe(prompt);
    });
});
