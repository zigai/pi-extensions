import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "./settings-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe("SettingsStore", () => {
    it("atomically updates global policy and refuses to overwrite malformed settings", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-settings-"));
        temporaryDirectories.push(root);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = join(root, "agent");

        try {
            const store = new SettingsStore({
                cwd: join(root, "project"),
                isProjectTrusted: () => true,
            });
            const result = await store.saveOverrides("global", [
                {
                    target: { kind: "tool", source: "builtin", name: "write" },
                    state: "off",
                },
            ]);
            expect(result.status).toBe("saved");
            const path = store.snapshot.loaded.globalConfigPath;
            const saved = await readFile(path, "utf8");
            expect(saved).toContain('"state": "off"');
            expect(saved).toContain('"$schema": "./schemas/pi-toggles.schema.json"');

            const policyResult = await store.savePolicy(
                "global",
                [
                    {
                        target: { kind: "tool", source: "builtin", name: "read" },
                        state: "on",
                    },
                ],
                "review",
            );
            expect(policyResult.status).toBe("saved");
            const policyText = await readFile(path, "utf8");
            expect(policyText).toContain('"activeProfile": "review"');
            expect(policyText).toContain('"name": "write"');
            expect(policyText).toContain('"name": "read"');

            await writeFile(
                path,
                `${JSON.stringify({
                    enabled: true,
                    overrides: [
                        {
                            target: { kind: "tool", source: "builtin", name: "read" },
                            state: "on",
                        },
                    ],
                })}\n`,
                "utf8",
            );
            const merged = await store.saveOverrides("global", [
                {
                    target: { kind: "tool", source: "builtin", name: "write" },
                    state: "off",
                },
            ]);
            expect(merged.status).toBe("saved");
            const mergedText = await readFile(path, "utf8");
            expect(mergedText).toContain('"name": "read"');
            expect(mergedText).toContain('"name": "write"');

            await writeFile(path, "{ invalid json\n", "utf8");
            const rejected = await store.saveOverrides("global", [
                {
                    target: { kind: "tool", source: "builtin", name: "read" },
                    state: "off",
                },
            ]);
            expect(rejected.status).toBe("invalid");
            expect(await readFile(path, "utf8")).toBe("{ invalid json\n");
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        }
    });

    it("blocks untrusted project writes without creating a project file", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-untrusted-"));
        temporaryDirectories.push(root);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = join(root, "agent");
        try {
            const store = new SettingsStore({
                cwd: join(root, "project"),
                isProjectTrusted: () => false,
            });
            const result = await store.saveOverrides("project", [
                {
                    target: { kind: "tool", source: "builtin", name: "write" },
                    state: "off",
                },
            ]);
            expect(result).toEqual({
                status: "blocked",
                message: "Project settings require a trusted project.",
            });
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        }
    });
});
