import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { planWorkspaceBuild, runWorkspaceTask } from "../workspace-tasks.ts";
import type { WorkspacePackage } from "../workspace-packages.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkWorkspace(exitCode: number) {
    const cache = path.join(homedir(), ".cache", "pi-tweaks", "workspace-tests");
    mkdirSync(cache, { recursive: true });
    const root = mkdtempSync(path.join(cache, "run-"));
    temporaryRoots.push(root);
    const directory = path.join(root, "extensions", "pi-branch");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ workspaces: ["extensions/*"], pi: { extensions: [] } }),
    );

    writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({
            name: "fixture-extension",
            version: "1.0.0",
            exports: { ".": "./index.js" },
            scripts: {
                check: 'node -e "process.exit(1)"',
                "check:code": "node check.mjs",
            },
        }),
    );

    writeFileSync(
        path.join(directory, "check.mjs"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync("verified", process.cwd());\nprocess.exit(${exitCode});\n`,
    );

    return { root, directory };
}

test("runs workspace code checks without repeating the complete gate", () => {
    const { root, directory } = checkWorkspace(0);
    runWorkspaceTask(root, "check:code:workspaces");
    expect(readFileSync(path.join(directory, "verified"), "utf8")).toBe(directory);
});

test("reports a failed workspace code check instead of accepting partial verification", () => {
    const { root, directory } = checkWorkspace(1);
    expect(() => runWorkspaceTask(root, "check:code:workspaces")).toThrow(Error);
    expect(readFileSync(path.join(directory, "verified"), "utf8")).toBe(directory);
});

test("makes built workspace executables available after a clean install", () => {
    const { root, directory } = checkWorkspace(0);
    const library = path.join(root, "packages", "cli-library");
    mkdirSync(library, { recursive: true });
    writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
            private: true,
            workspaces: ["extensions/*", "packages/*"],
            pi: { extensions: [] },
        }),
    );
    writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({
            name: "fixture-extension",
            version: "1.0.0",
            exports: { ".": "./index.js" },
            dependencies: { "fixture-cli": "1.0.0" },
            scripts: { "check:code": "fixture-command" },
        }),
    );
    writeFileSync(
        path.join(library, "package.json"),
        JSON.stringify({
            name: "fixture-cli",
            version: "1.0.0",
            type: "module",
            exports: { ".": "./dist/cli.js" },
            bin: { "fixture-command": "dist/cli.js" },
            scripts: { build: "node build.mjs" },
        }),
    );
    const cli =
        '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync("verified", process.cwd());\n';
    writeFileSync(
        path.join(library, "build.mjs"),
        `import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("dist", { recursive: true });\nwriteFileSync("dist/cli.js", ${JSON.stringify(cli)});\n`,
    );
    writeFileSync(
        path.join(root, "package-lock.json"),
        JSON.stringify({
            lockfileVersion: 3,
            requires: true,
            packages: {
                "": { workspaces: ["extensions/*", "packages/*"] },
                "extensions/pi-branch": {
                    name: "fixture-extension",
                    version: "1.0.0",
                    dependencies: { "fixture-cli": "1.0.0" },
                },
                "packages/cli-library": {
                    name: "fixture-cli",
                    version: "1.0.0",
                    bin: { "fixture-command": "dist/cli.js" },
                },
                "node_modules/fixture-cli": { resolved: "packages/cli-library", link: true },
                "node_modules/fixture-extension": { resolved: "extensions/pi-branch", link: true },
            },
        }),
    );
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: root });

    runWorkspaceTask(root, "build");
    runWorkspaceTask(root, "check:code:workspaces");

    expect(readFileSync(path.join(directory, "verified"), "utf8")).toBe(directory);
});

function workspace(
    name: string,
    dependencies: Record<string, string> = {},
    build = true,
): WorkspacePackage {
    let scripts = {};
    if (build) scripts = { build: "node build.js" };

    return {
        directory: path.resolve(name),
        manifest: {
            name,
            version: "1.0.0",
            exports: { ".": "./dist/index.js" },
            dependencies,
            scripts,
        },
    };
}

test("builds settings CLI first and compiled dependencies before consumers", () => {
    const consumer = workspace("extension", { library: "1.0.0" });
    const library = workspace("library");
    const settings = workspace("@zigai/pi-extension-settings");
    const sourceOnly = workspace("source-only", {}, false);
    expect(
        planWorkspaceBuild([consumer, sourceOnly, library, settings]).map(
            ({ manifest }) => manifest.name,
        ),
    ).toEqual(["@zigai/pi-extension-settings", "library", "extension"]);
});

test("historical pins do not select a newer workspace build as their dependency", () => {
    const consumer = workspace("extension", { library: "0.9.0" });
    const library = workspace("library");
    expect(planWorkspaceBuild([consumer, library]).map(({ manifest }) => manifest.name)).toEqual([
        "extension",
        "library",
    ]);
});

test("rejects build cycles before executing any workspace task", () => {
    expect(() =>
        planWorkspaceBuild([workspace("a", { b: "1.0.0" }), workspace("b", { a: "1.0.0" })]),
    ).toThrow("dependency cycle");
});
