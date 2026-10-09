import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packDirectory = mkdtempSync(path.join(tmpdir(), "pi-branch-pack-"));
const NpmPackResultSchema = Type.Object({ filename: Type.String() });
const NpmPackOutputSchema = Type.Object({ "@zigai/pi-branch": NpmPackResultSchema });
const PackageManifestSchema = Type.Object({
    name: Type.Literal("@zigai/pi-branch"),
    dependencies: Type.Object({ "pi-typed-args": Type.Literal("0.1.1") }),
    exports: Type.Object({ ".": Type.Literal("./index.ts") }),
    bundledDependencies: Type.Optional(Type.Array(Type.String())),
    bundleDependencies: Type.Optional(Type.Array(Type.String())),
});

type NpmPackOutput = Static<typeof NpmPackOutputSchema>;
type PackageManifest = Static<typeof PackageManifestSchema>;

function fail(message: string): never {
    throw new Error(`Package verification failed: ${message}`);
}

function parseNpmPackOutput(text: string): NpmPackOutput {
    const parsed: unknown = JSON.parse(text);
    return Value.Parse(NpmPackOutputSchema, parsed);
}

function parsePackageManifest(text: string): PackageManifest {
    const parsed: unknown = JSON.parse(text);
    return Value.Parse(PackageManifestSchema, parsed);
}

try {
    const output = execFileSync(
        "npm",
        ["pack", "--workspaces=false", "--json", "--pack-destination", packDirectory],
        {
            cwd: projectRoot,
            encoding: "utf8",
        },
    );
    const { filename } = parseNpmPackOutput(output)["@zigai/pi-branch"];
    const archive = path.join(packDirectory, filename);
    const files = new Set(
        execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n"),
    );
    for (const required of [
        "package/index.ts",
        "package/config.schema.json",
        "package/README.md",
        "package/LICENSE",
    ]) {
        if (!files.has(required)) fail(`missing ${required}`);
    }

    for (const excluded of [
        "package/AGENTS.md",
        "package/Justfile",
        "package/index.test.ts",
        "package/tsconfig.json",
        "package/oxlint.config.ts",
    ]) {
        if (files.has(excluded)) fail(`unexpectedly included ${excluded}`);
    }

    const manifest = parsePackageManifest(
        execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }),
    );
    if (manifest.bundleDependencies !== undefined || manifest.bundledDependencies !== undefined) {
        fail("runtime libraries must be independently installed, not bundled");
    }
    for (const file of files) {
        if (file.startsWith("package/node_modules/")) fail(`bundled dependency: ${file}`);
    }

    process.stdout.write("package verification passed\n");
} finally {
    rmSync(packDirectory, { recursive: true, force: true });
}
