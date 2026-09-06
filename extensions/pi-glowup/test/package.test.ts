import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { readModuleGraph } from "./support/module-graph.ts";
import { describe, expect, it } from "vitest";
import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import { jsonValueSchema } from "../src/json-value.js";
import { GLOWUP_RENDERING_VERSION } from "../src/tools/protocol/contract.ts";

const packageJsonSchema = Type.Object({
    files: Type.Array(Type.String()),
    exports: Type.Optional(Type.Record(Type.String(), jsonValueSchema)),
    dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
    devDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
    peerDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
    peerDependenciesMeta: Type.Optional(
        Type.Record(
            Type.String(),
            Type.Object({
                optional: Type.Optional(Type.Boolean()),
            }),
        ),
    ),
});

type PackageJson = Static<typeof packageJsonSchema>;

function readPackageJson(): PackageJson {
    const raw: unknown = JSON.parse(readFileSync("package.json", "utf8"));
    return Value.Parse(packageJsonSchema, raw);
}

describe("package manifest", () => {
    it("exports the Glowup tool-rendering protocol for extension authors", () => {
        const manifest = readPackageJson();

        expect(manifest.exports?.["./protocol"]).toBe("./src/tools/protocol/contract.ts");
    });

    it("keeps the public protocol independent from Pi and internal renderer types", () => {
        expect(GLOWUP_RENDERING_VERSION).toBe(3);

        const entry = Value.Parse(Type.String(), readPackageJson().exports?.["./protocol"]);
        const { files: visitedFiles, externalImports } = readModuleGraph([entry]);

        for (const external of externalImports) {
            expect(external.startsWith("@earendil-works")).toBe(false);
        }
        const publishedFiles = readPackageJson().files;
        for (const file of visitedFiles) {
            expect(publishedFiles, `Public dependency must be shipped: ${file}`).toContain(
                relative(process.cwd(), file),
            );
            expect(file).not.toMatch(
                /\/src\/(?:rendering|pi|config|diagnostics|themes)(?:\/|\.ts$)/,
            );
            expect(file).not.toMatch(/\/src\/index\.ts$/);
        }
    });

    it("keeps Pi core packages as peers instead of bundled runtime dependencies", () => {
        const manifest = readPackageJson();
        const piCorePackages = [
            "@earendil-works/pi-coding-agent",
            "@earendil-works/pi-tui",
            "typebox",
        ];

        for (const packageName of piCorePackages) {
            expect(manifest.dependencies?.[packageName]).toBeUndefined();
            expect(manifest.peerDependencies?.[packageName]).toBe("*");
            expect(manifest.peerDependenciesMeta?.[packageName]?.optional).toBe(true);
        }
        expect(manifest.devDependencies?.typebox).toBeDefined();
    });
});
