import { readFileSync } from "node:fs";
import ts from "typescript";
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
            const source = ts.createSourceFile(
                normalizedPath,
                content,
                ts.ScriptTarget.Latest,
                true,
            );
            function visitNode(node: ts.Node): void {
                let specifier: string | undefined;
                if (
                    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
                    node.moduleSpecifier &&
                    ts.isStringLiteralLike(node.moduleSpecifier)
                ) {
                    specifier = node.moduleSpecifier.text;
                } else if (
                    ts.isImportTypeNode(node) &&
                    ts.isLiteralTypeNode(node.argument) &&
                    ts.isStringLiteralLike(node.argument.literal)
                ) {
                    specifier = node.argument.literal.text;
                } else if (
                    ts.isCallExpression(node) &&
                    node.expression.kind === ts.SyntaxKind.ImportKeyword
                ) {
                    const argument = node.arguments[0];
                    expect(
                        argument && ts.isStringLiteralLike(argument),
                        "dynamic protocol dependency must be statically resolvable",
                    ).toBe(true);
                    if (argument && ts.isStringLiteralLike(argument)) specifier = argument.text;
                } else if (
                    ts.isExternalModuleReference(node) &&
                    ts.isStringLiteralLike(node.expression)
                ) {
                    specifier = node.expression.text;
                }
                if (specifier !== undefined) {
                    if (specifier.startsWith(".")) {
                        let dependency = resolve(dirname(normalizedPath), specifier);
                        if (dependency.endsWith(".js"))
                            dependency = `${dependency.slice(0, -3)}.ts`;
                        if (!dependency.endsWith(".ts")) dependency = `${dependency}.ts`;
                        visit(dependency);
                    } else {
                        externalImports.add(specifier);
                    }
                }
                ts.forEachChild(node, visitNode);
            }
            visitNode(source);
        }

        const entry = Value.Parse(Type.String(), readPackageJson().exports?.["./protocol"]);
        visit(entry);

        for (const external of externalImports) {
            expect(external.startsWith("@earendil-works")).toBe(false);
        }
        for (const file of visitedFiles) {
            expect(file).not.toMatch(
                /\/src\/(?:rendering|third-party-tools|diffs|patches|syntax|script-preview|mutations|config|diagnostics|themes)(?:\/|\.ts$)/,
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
