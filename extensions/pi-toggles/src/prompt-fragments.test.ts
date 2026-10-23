import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendActivePromptFragments } from "./prompt-fragments.ts";
import type { ActivePromptFragment } from "./resolve-capability-policy.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe("appendActivePromptFragments", () => {
    it("selects a full project replacement before global replacements and appends each owned fragment once", async () => {
        const fragments: readonly ActivePromptFragment[] = [
            {
                scope: "global",
                fragment: {
                    id: "global",
                    priority: 100,
                    operation: "replace",
                    content: { kind: "inline", text: "Global replacement" },
                },
                activatedBy: ["condition"],
            },
            {
                scope: "project",
                fragment: {
                    id: "project",
                    priority: 0,
                    operation: "replace",
                    content: { kind: "inline", text: "Project replacement" },
                },
                activatedBy: ["profile"],
            },
            {
                scope: "global",
                fragment: {
                    id: "guide",
                    priority: 0,
                    content: { kind: "inline", text: "Owned guidance" },
                },
                activatedBy: ["condition", "profile"],
            },
        ];
        const context = {
            cwd: process.cwd(),
            projectTrusted: true,
            globalConfigPath: "/agent/settings.json",
            projectConfigPath: "/project/settings.json",
        };
        expect(
            (await appendActivePromptFragments("Generated tools and context", fragments, context))
                .prompt,
        ).toBe("Project replacement\n\n## Pi Toggles: guide\n\nOwned guidance");
        expect((await appendActivePromptFragments("Fresh base", [], context)).prompt).toBe(
            "Fresh base",
        );
    });

    it("appends owned inline and file fragments in resolved order", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-prompts-"));
        temporaryDirectories.push(root);
        const configPath = join(root, "extension-settings", "pi-toggles.json");
        await mkdir(join(root, "extension-settings", "fragments"), { recursive: true });
        await writeFile(
            join(root, "extension-settings", "fragments", "review.md"),
            "File guidance.",
            "utf8",
        );
        const fragments: readonly ActivePromptFragment[] = [
            {
                scope: "global",
                fragment: {
                    id: "inline",
                    priority: 100,
                    content: { kind: "inline", text: "Inline guidance." },
                },
                activatedBy: ["test"],
            },
            {
                scope: "global",
                fragment: {
                    id: "file",
                    priority: 50,
                    content: { kind: "file", path: "fragments/review.md" },
                },
                activatedBy: ["test"],
            },
        ];

        const result = await appendActivePromptFragments("Base prompt", fragments, {
            cwd: root,
            projectTrusted: true,
            globalConfigPath: configPath,
        });

        expect(result.diagnostics).toEqual([]);
        expect(result.prompt).toBe(
            "Base prompt\n\n## Pi Toggles: inline\n\nInline guidance.\n\n## Pi Toggles: file\n\nFile guidance.",
        );
    });

    it("rejects oversized and escaping project fragments", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-project-prompts-"));
        temporaryDirectories.push(root);
        const fragments: readonly ActivePromptFragment[] = [
            {
                scope: "global",
                fragment: {
                    id: "oversized",
                    priority: 100,
                    content: { kind: "inline", text: "x".repeat(50_001) },
                },
                activatedBy: ["test"],
            },
            {
                scope: "project",
                fragment: {
                    id: "escape",
                    priority: 50,
                    content: { kind: "file", path: "../../../../outside.md" },
                },
                activatedBy: ["test"],
            },
        ];

        const result = await appendActivePromptFragments("Base", fragments, {
            cwd: join(root, "project"),
            projectTrusted: true,
            globalConfigPath: join(root, "agent", "extension-settings", "pi-toggles.json"),
            projectConfigPath: join(
                root,
                "project",
                ".pi",
                "extension-settings",
                "pi-toggles.json",
            ),
        });

        expect(result.prompt).toBe("Base");
        expect(result.diagnostics).toHaveLength(2);
        expect(result.diagnostics[0]).toContain("limited to 50KB");
        expect(result.diagnostics[1]).toContain("escapes the trusted project");
    });
});
