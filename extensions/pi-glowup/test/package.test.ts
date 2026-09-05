import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import { jsonValueSchema } from "../src/json-value.js";
import { GLOWUP_RENDERING_VERSION } from "../src/tool-rendering/protocol.ts";

const packageJsonSchema = Type.Object({
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

        expect(manifest.exports?.["./protocol"]).toBe("./src/tool-rendering/protocol.ts");
    });

    it("keeps the public protocol independent from Pi and internal renderer types", () => {
        expect(GLOWUP_RENDERING_VERSION).toBe(3);

        const visitedFiles = new Set<string>();
        const externalImports = new Set<string>();

        function visit(filePath: string) {
            const normalizedPath = resolve(filePath);
            if (visitedFiles.has(normalizedPath)) return;
            visitedFiles.add(normalizedPath);
            const content = readFileSync(normalizedPath, "utf8");
            const importMatches = content.matchAll(
                /(?:import|export)\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g,
            );
            for (const match of importMatches) {
                const specifier = match[1];
                if (specifier !== undefined) {
                    if (specifier.startsWith(".")) {
                        let resolved = resolve(dirname(normalizedPath), specifier);
                        if (resolved.endsWith(".js")) resolved = `${resolved.slice(0, -3)}.ts`;
                        if (!resolved.endsWith(".ts")) resolved = `${resolved}.ts`;
                        visit(resolved);
                    } else {
                        externalImports.add(specifier);
                    }
                }
            }
        }

        visit("src/tool-rendering/protocol.ts");

        for (const external of externalImports) {
            expect(external.startsWith("@earendil-works")).toBe(false);
        }
        for (const file of visitedFiles) {
            expect(file).not.toMatch(
                /\/src\/(?:rendering|third-party-tools|diffs|patches|syntax|script-preview|mutations|config|diagnostics)\//,
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
