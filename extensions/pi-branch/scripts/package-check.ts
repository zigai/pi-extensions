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
const NpmPackOutputSchema = Type.Union([
    Type.Array(NpmPackResultSchema),
    Type.Record(Type.String(), NpmPackResultSchema),
]);
const DependencyManifestSchema = Type.Object({ name: Type.String() });

type NpmPackOutput = Static<typeof NpmPackOutputSchema>;
type DependencyManifest = Static<typeof DependencyManifestSchema>;

function fail(message: string): never {
    throw new Error(`Package verification failed: ${message}`);
}

function parseNpmPackOutput(text: string): NpmPackOutput {
    const parsed: unknown = JSON.parse(text);
    return Value.Parse(NpmPackOutputSchema, parsed);
}

function parseDependencyManifest(text: string): DependencyManifest {
    const parsed: unknown = JSON.parse(text);
    return Value.Parse(DependencyManifestSchema, parsed);
}

try {
    const output = execFileSync("npm", ["pack", "--json", "--pack-destination", packDirectory], {
        cwd: projectRoot,
        encoding: "utf8",
    });
    const parsed = parseNpmPackOutput(output);
    let result;
    if (Array.isArray(parsed)) {
        result = parsed[0];
    } else {
        result = Object.values(parsed)[0];
    }

    if (result === undefined) {
        fail("npm pack returned no result");
    }

    const { filename } = result;
    const archive = path.join(packDirectory, filename);
    const files = new Set(
        execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n"),
    );
    for (const required of [
        "package/index.ts",
        "package/config.schema.json",
        "package/README.md",
        "package/LICENSE",
        "package/node_modules/pi-typed-args/package.json",
        "package/node_modules/yaml/package.json",
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

    const dependencyManifest = parseDependencyManifest(
        execFileSync("tar", ["-xOf", archive, "package/node_modules/pi-typed-args/package.json"], {
            encoding: "utf8",
        }),
    );
    if (dependencyManifest.name !== "pi-typed-args") {
        fail("bundled dependency has the wrong package name");
    }

    process.stdout.write("package verification passed\n");
} finally {
    rmSync(packDirectory, { recursive: true, force: true });
}
