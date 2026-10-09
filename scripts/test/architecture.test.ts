import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { checkArchitecture } from "../architecture.ts";
import { loadWorkspacePackages } from "../workspace-packages.ts";

const roots: string[] = [];

function write(root: string, relative: string, text: string): void {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
}

function fixture(): string {
    const root = mkdtempSync(path.join(tmpdir(), "pi-tweaks-architecture-"));
    roots.push(root);
    write(
        root,
        "tsconfig.architecture.json",
        JSON.stringify({
            compilerOptions: { allowJs: true, noEmit: true },
            include: ["packages/**/*.ts", "packages/**/*.js"],
        }),
    );

    write(
        root,
        "package.json",
        JSON.stringify({
            workspaces: ["packages/*"],
            pi: { extensions: ["./packages/b/src/index.ts", "./packages/a/src/index.ts"] },
        }),
    );

    for (const name of ["a", "b"]) {
        write(
            root,
            `packages/${name}/package.json`,
            JSON.stringify({
                name: `@test/${name}`,
                exports: { ".": "./src/index.ts", "./api": "./src/api.ts" },
                dependencies: { "@test/b": "1.0.0", typebox: "1.0.0" },
                peerDependencies: { "@earendil-works/pi-ai": "*" },
                pi: { extensions: ["./src/index.ts"] },
            }),
        );

        write(root, `packages/${name}/src/index.ts`, "export default function extension() {}\n");
        write(root, `packages/${name}/src/api.ts`, "export const value = 1;\n");
    }

    return root;
}

function settings(root: string, source: string): void {
    write(
        root,
        "packages/a/package.json",
        JSON.stringify({
            name: "@test/a",
            exports: { ".": "./src/index.ts" },
            dependencies: { typebox: "1.0.0", "@zigai/pi-extension-settings": "1.0.0" },
            peerDependencies: { "@earendil-works/pi-ai": "*" },
            pi: { extensions: ["./src/index.ts"] },
            piExtensionSettings: {
                definition: "./src/schema-input.ts",
                prevalidation: "./src/schema.prevalidated.ts",
                schema: "./config.schema.json",
                readme: "./README.md",
            },
        }),
    );

    write(root, "packages/a/src/schema-input.ts", source);
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("discovers workspaces while preserving the root extension load order", () => {
    const root = fixture();
    write(
        root,
        "packages/library/package.json",
        JSON.stringify({
            name: "@test/library",
            exports: { ".": "./src/api.ts" },
        }),
    );
    const inventory = loadWorkspacePackages(root);
    expect(inventory.packages.map((workspace) => workspace.manifest.name)).toEqual([
        "@test/a",
        "@test/b",
        "@test/library",
    ]);

    expect(inventory.extensions.map((extension) => extension.workspace.manifest.name)).toEqual([
        "@test/b",
        "@test/a",
    ]);

    expect(checkArchitecture(inventory)).toEqual([]);
});

test.each([
    [[], "missing workspace extensions"],
    [["./packages/a/src/index.ts", "./packages/a/src/index.ts"], "undeclared or duplicated"],
    [["./packages/ghost/src/index.ts"], "undeclared or duplicated"],
])("rejects inconsistent root extension inventory %j", (extensions, message) => {
    const root = fixture();
    write(root, "package.json", JSON.stringify({ workspaces: ["packages/*"], pi: { extensions } }));
    expect(() => loadWorkspacePackages(root)).toThrow(message);
});

test.each([
    'import { value } from "../../b/src/api.ts";',
    'export { value } from "../../b/src/api.ts";',
    'const load = () => import("../../b/src/api.ts");',
    'const value = require("../../b/src/api.ts");',
    'import type { Value } from "../../b/src/api.ts";',
])("rejects cross-package source access: %s", (source) => {
    const root = fixture();
    write(root, "packages/a/src/index.ts", source);
    expect(checkArchitecture(loadWorkspacePackages(root))).toEqual([
        expect.stringContaining("Cross-package source import"),
    ]);
});

test("allows published imports and host peers but rejects hidden workspace subpaths", () => {
    const root = fixture();
    write(
        root,
        "packages/a/src/index.ts",
        [
            'import { value } from "@test/b/api";',
            'import { model } from "@earendil-works/pi-ai";',
            'import { hidden } from "@test/b/src/api.ts";',
        ].join("\n"),
    );

    expect(checkArchitecture(loadWorkspacePackages(root))).toEqual([
        expect.stringContaining("@test/b/src/api.ts is not a published export"),
    ]);
});

test("rejects undeclared runtime imports and reexports, including dynamic imports", () => {
    const root = fixture();
    write(
        root,
        "packages/a/src/index.ts",
        [
            'import "missing-side-effect";',
            'export { value } from "missing-export";',
            'const load = () => import("missing-dynamic");',
            'import { type TypeOnly } from "types-only";',
            'export type { TypeOnly } from "export-types-only";',
            'type Inline = import("inline-types-only").Value;',
        ].join("\n"),
    );
    const diagnostics = checkArchitecture(loadWorkspacePackages(root));
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.join("\n")).toContain("Undeclared runtime dependency missing-side-effect");
    expect(diagnostics.join("\n")).toContain("Undeclared runtime dependency missing-export");
    expect(diagnostics.join("\n")).toContain("Undeclared runtime dependency missing-dynamic");
});

test("workspace runtime dependencies cannot be supplied only as peers", () => {
    const root = fixture();
    write(
        root,
        "packages/a/package.json",
        JSON.stringify({
            name: "@test/a",
            exports: { ".": "./src/index.ts" },
            peerDependencies: { "@test/b": "*" },
            pi: { extensions: ["./src/index.ts"] },
        }),
    );

    write(root, "packages/a/src/index.ts", 'import "@test/b/api";');
    expect(checkArchitecture(loadWorkspacePackages(root))).toEqual([
        expect.stringContaining("Workspace runtime dependency @test/b must be in dependencies"),
    ]);
});

test("settings may depend on pure leaves, schema libraries, and erased host types", () => {
    const root = fixture();
    settings(
        root,
        [
            'import { Type } from "typebox";',
            'import { defineExtensionSettings } from "@zigai/pi-extension-settings";',
            'import { levels } from "./thinking-levels.ts";',
            'import { type Model } from "@earendil-works/pi-ai";',
        ].join("\n"),
    );

    write(root, "packages/a/src/thinking-levels.ts", 'export const levels = ["off", "high"];');
    expect(checkArchitecture(loadWorkspacePackages(root))).toEqual([]);
});

test.each([
    ['import "./index.ts";', "feature initialization"],
    ['import "./schema.prevalidated.ts";', "feature initialization"],
    ['import "./settings.ts";', "settings hydration"],
    ['import "@earendil-works/pi-ai";', "not build-safe"],
    ['import "@zigai/pi-extension-settings/pi";', "not build-safe"],
    ['import "node:fs";', "not build-safe"],
    ["const load = (name: string) => import(name);", "Unverifiable dynamic runtime import"],
])("rejects transitive settings runtime dependency: %s", (source, message) => {
    const root = fixture();
    settings(root, 'import { levels } from "./thinking-levels.ts";');
    write(root, "packages/a/src/thinking-levels.ts", source);
    write(root, "packages/a/src/schema.prevalidated.ts", "export const schema = {};\n");
    write(root, "packages/a/src/settings.ts", "export const config = {};\n");
    const diagnostics = checkArchitecture(loadWorkspacePackages(root));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(message);
    expect(diagnostics[0]).toContain("schema-input.ts -> src/thinking-levels.ts");
});

test("discovers mixed workspace roots and conditional exports without flattening contracts", () => {
    const root = fixture();
    write(
        root,
        "package.json",
        JSON.stringify({
            workspaces: ["extensions/*", "packages/*"],
            pi: { extensions: ["./packages/b/src/index.ts", "./packages/a/src/index.ts"] },
        }),
    );
    write(
        root,
        "extensions/library/package.json",
        JSON.stringify({
            name: "@test/library",
            exports: { ".": { types: "./dist/index.d.ts", import: ["./dist/index.js", null] } },
        }),
    );
    const inventory = loadWorkspacePackages(root);
    expect(inventory.packages.map((workspace) => workspace.manifest.name)).toEqual([
        "@test/library",
        "@test/a",
        "@test/b",
    ]);
    expect(inventory.packages[0]?.manifest.exports).toEqual({
        ".": { types: "./dist/index.d.ts", import: ["./dist/index.js", null] },
    });
    expect(checkArchitecture(inventory)).toEqual([]);
});

test("collection is an alternative resource inventory, not another root activation", () => {
    const root = fixture();
    for (const name of ["a", "b"]) {
        write(
            root,
            `packages/${name}/package.json`,
            JSON.stringify({
                name: `@test/${name}`,
                version: "1.0.0",
                exports: { ".": "./src/index.ts" },
                pi: { extensions: ["./src/index.ts"] },
            }),
        );
    }
    write(
        root,
        "packages/collection/package.json",
        JSON.stringify({
            name: "@test/collection",
            exports: { ".": "./package.json" },
            dependencies: { "@test/b": "1.0.0", "@test/a": "1.0.0" },
            bundleDependencies: ["@test/b", "@test/a"],
            piCollection: ["@test/b", "@test/a"],
            pi: {
                extensions: [
                    "./node_modules/@test/b/src/index.ts",
                    "./node_modules/@test/a/src/index.ts",
                ],
            },
        }),
    );
    const inventory = loadWorkspacePackages(root);
    expect(inventory.extensions.map(({ workspace }) => workspace.manifest.name)).toEqual([
        "@test/b",
        "@test/a",
    ]);
    write(
        root,
        "packages/collection/package.json",
        JSON.stringify({
            name: "@test/collection",
            exports: { ".": "./package.json" },
            piCollection: ["@test/a", "@test/b"],
        }),
    );
    expect(() => loadWorkspacePackages(root)).toThrow("ordered root extension inventory");
});
