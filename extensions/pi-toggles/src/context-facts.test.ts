import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextFacts } from "./context-facts.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe("ContextFacts", () => {
    it("gates project file facts on trust and project-relative paths", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "pi-toggles-facts-"));
        temporaryDirectories.push(cwd);
        await mkdir(join(cwd, "src"));
        await writeFile(join(cwd, "src", "index.ts"), "export {};\n", "utf8");
        const facts = new ContextFacts(cwd, false);

        expect(facts.resolve("project.fileExists", { path: "src/index.ts" }).status).toBe(
            "unknown",
        );
        facts.updateProject(cwd, true);
        expect(facts.resolve("project.fileExists", { path: "src/index.ts" })).toEqual({
            status: "known",
            value: true,
        });
        expect(facts.resolve("project.fileExists", { path: "../secret" }).status).toBe("unknown");
        expect(facts.resolve("project.hasAnyFile", { patterns: "**/*.ts" })).toEqual({
            status: "known",
            value: true,
        });
    });

    it("accepts typed extension context values and rejects owner/type drift", () => {
        const facts = new ContextFacts("/workspace", true);
        facts.registerContextKey({
            key: "acme.connected",
            type: "boolean",
            description: "Whether Acme is connected",
            owner: "acme-extension",
        });
        facts.setContext({ key: "acme.connected", value: true, owner: "acme-extension" });
        expect(facts.resolve("acme.connected", undefined)).toEqual({
            status: "known",
            value: true,
        });

        facts.setContext({ key: "acme.connected", value: "yes", owner: "acme-extension" });
        facts.setContext({ key: "acme.connected", value: false, owner: "other-extension" });
        facts.registerContextKey({
            key: "env.present",
            type: "boolean",
            description: "Attempted built-in override",
            owner: "acme-extension",
        });
        expect(facts.resolve("acme.connected", undefined)).toEqual({
            status: "known",
            value: true,
        });
        expect(facts.diagnostics).toHaveLength(3);

        facts.clearContext({ owner: "acme-extension", key: "acme.connected" });
        expect(facts.resolve("acme.connected", undefined).status).toBe("missing");
    });
});
