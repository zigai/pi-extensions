import path from "node:path";
import { expect, test } from "vitest";
import { planWorkspaceBuild } from "../workspace-tasks.ts";
import type { WorkspacePackage } from "../workspace-packages.ts";

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
