import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packDirectory = mkdtempSync(path.join(tmpdir(), "pi-branch-pack-"));

function fail(message: string): never {
    throw new Error(`Package smoke test failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function parseJson(text: string): unknown {
    const parsed: unknown = JSON.parse(text);
    return parsed;
}

try {
    const output = execFileSync("npm", ["pack", "--json", "--pack-destination", packDirectory], {
        cwd: projectRoot,
        encoding: "utf8",
    });
    const parsed = parseJson(output);
    let result: unknown;
    if (Array.isArray(parsed)) {
        result = parsed[0];
    } else if (isRecord(parsed)) {
        result = Object.values(parsed)[0];
    }
    if (!isRecord(result)) {
        fail("npm pack returned no result");
    }
    const filename = result.filename;
    if (typeof filename !== "string") {
        fail("npm pack did not report a filename");
    }

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

    const dependencyManifest = parseJson(
        execFileSync("tar", ["-xOf", archive, "package/node_modules/pi-typed-args/package.json"], {
            encoding: "utf8",
        }),
    );
    if (!isRecord(dependencyManifest) || dependencyManifest.name !== "pi-typed-args") {
        fail("bundled dependency has the wrong package name");
    }

    process.stdout.write("package smoke test passed\n");
} finally {
    rmSync(packDirectory, { recursive: true, force: true });
}
