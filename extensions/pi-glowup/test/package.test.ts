import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import { jsonValueSchema } from "../src/json-value.js";

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
        const protocol = readFileSync("src/tool-rendering/protocol.ts", "utf8");

        expect(protocol).toContain("GLOWUP_RENDERING_VERSION = 3");
        expect(protocol).not.toContain("@earendil-works");
        expect(protocol).not.toContain("Component");
        expect(protocol).not.toContain("GlowupRenderTheme");
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
