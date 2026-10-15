import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { readModuleGraph } from "./module-graph.ts";
import { describe, expect, it, onTestFinished } from "vitest";
import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import { jsonValueSchema } from "../src/json-value.ts";

const dependencyMap = Type.Record(Type.String(), Type.String());
const lockRootSchema = Type.Object({
    dependencies: Type.Optional(dependencyMap),
    devDependencies: Type.Optional(dependencyMap),
    peerDependencies: Type.Optional(dependencyMap),
    optionalDependencies: Type.Optional(dependencyMap),
});

const packageJsonSchema = Type.Object({
    files: Type.Array(Type.String()),
    exports: Type.Optional(Type.Record(Type.String(), jsonValueSchema)),
    dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
    devDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
    peerDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
    optionalDependencies: Type.Optional(dependencyMap),
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

function resolvedPackageRoot(name: string): string {
    let directory = dirname(fileURLToPath(import.meta.resolve(name)));
    for (;;) {
        try {
            const manifest = Value.Parse(
                Type.Object({ name: Type.String() }),
                JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
            );
            if (manifest.name === name) return directory;
        } catch {}

        const parent = dirname(directory);
        if (parent === directory) throw new Error(`Cannot locate resolved package ${name}`);

        directory = parent;
    }
}

describe("package manifest", () => {
    it("exports the tool-rendering protocol for extension authors", async () => {
        const { decodeGlowupNode, text } = await import("@zigai/pi-glowup/protocol");

        expect(decodeGlowupNode(text("example"))).toMatchObject({
            kind: "text",
            text: "example",
        });
    });

    it("keeps the public protocol independent from Pi and internal renderer types", () => {
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

    it.each([
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ] as const)(
        "keeps manifest and monorepo lockfile workspace %s declarations identical",
        (section) => {
            const manifest = readPackageJson();
            const workspaceKey = "extensions/pi-glowup";

            const lock = Value.Parse(
                Type.Object({ packages: Type.Record(Type.String(), lockRootSchema) }),
                JSON.parse(
                    readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8"),
                ),
            );
            const workspace = lock.packages[workspaceKey];
            expect(workspace, "the root lockfile must contain this workspace").toBeDefined();
            expect(workspace?.[section] ?? {}).toEqual(manifest[section] ?? {});
        },
    );

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

    it("tokenizes long lines from the packed worker with extension-local host peers absent", async () => {
        const packageRoot = resolve(import.meta.dirname, "..");
        const root = await mkdtemp(join(homedir(), ".cache", "glowup-worker-"));
        onTestFinished(async () => {
            await rm(root, { recursive: true, force: true });
        });
        const buildRoot = join(root, "build");
        await mkdir(buildRoot);

        for (const file of ["package.json", "config.schema.json", "LICENSE", "README.md"])
            await copyFile(join(packageRoot, file), join(buildRoot, file));

        for (const folder of ["src", "scripts", "themes"])
            await cp(join(packageRoot, folder), join(buildRoot, folder), { recursive: true });

        for (const dependency of [
            "esbuild",
            "typescript",
            "@pierre/diffs",
            "ansi-styles",
            "unbash",
            "shiki",
        ]) {
            const destination = join(buildRoot, "node_modules", dependency);
            await mkdir(dirname(destination), { recursive: true });
            await symlink(resolvedPackageRoot(dependency), destination, "dir");
        }

        execFileSync(process.execPath, [join(buildRoot, "scripts", "build.mjs")], {
            cwd: buildRoot,
            stdio: "pipe",
        });

        execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", root], {
            cwd: buildRoot,
            stdio: "pipe",
        });
        const archive = (await readdir(root)).find((name) => name.endsWith(".tgz"));
        if (archive === undefined) throw new Error("Missing tarball");

        const consumerRoot = join(root, "consumer");
        const installedRoot = join(consumerRoot, "node_modules", "@zigai", "pi-glowup");
        await mkdir(installedRoot, { recursive: true });
        execFileSync("tar", [
            "-xzf",
            join(root, archive),
            "-C",
            installedRoot,
            "--strip-components=1",
        ]);
        await symlink(
            resolvedPackageRoot("shiki"),
            join(consumerRoot, "node_modules", "shiki"),
            "dir",
        );
        const source = `const before = 1;\n/* ${"note ".repeat(1_800)}\nconst hidden = 2;\n*/ const after = 3;`;
        const consumer = join(consumerRoot, "consumer.mjs");
        await writeFile(
            consumer,
            `import { Worker } from "node:worker_threads";
import fs from "node:fs";
const theme = JSON.parse(fs.readFileSync(new URL("./node_modules/@zigai/pi-glowup/themes/darker-modern-theme.json", import.meta.url), "utf8"));
const worker = new Worker(new URL("./node_modules/@zigai/pi-glowup/dist/src/tokenize-worker.mjs", import.meta.url), { execArgv: [] });
try {
    const response = new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    worker.postMessage({ id: 1, code: ${JSON.stringify(source)}, language: "javascript", brackets: true, theme });
    console.log(JSON.stringify(await response));
} finally { await worker.terminate(); }
`,
        );
        const raw: unknown = JSON.parse(
            execFileSync(process.execPath, [consumer], { cwd: consumerRoot, encoding: "utf8" }),
        );
        const result = Value.Parse(
            Type.Object({ id: Type.Number(), lines: Type.Array(Type.String()) }),
            raw,
        );
        expect(result.lines[1]).toContain("\u001b[");
        expect(result.lines[2]).toContain("\u001b[38;2;106;153;85mconst hidden");
        expect(result.lines[3]).toContain("\u001b[38;2;86;156;214mconst");
        expect(result.lines.map((line) => stripVTControlCharacters(line)).join("\n")).toBe(source);
    }, 30_000);

    it("publishes a callable root factory with checked consumer types", async () => {
        const packageRoot = resolve(import.meta.dirname, "..");
        const root = await mkdtemp(join(tmpdir(), "glowup-root-types-"));
        onTestFinished(async () => {
            await rm(root, { recursive: true, force: true });
        });

        const buildRoot = join(root, "build");
        await mkdir(buildRoot);
        await Promise.all([
            copyFile(join(packageRoot, "package.json"), join(buildRoot, "package.json")),
            copyFile(
                join(packageRoot, "config.schema.json"),
                join(buildRoot, "config.schema.json"),
            ),
            cp(join(packageRoot, "src"), join(buildRoot, "src"), { recursive: true }),
            cp(join(packageRoot, "scripts"), join(buildRoot, "scripts"), { recursive: true }),
            copyFile(join(packageRoot, "LICENSE"), join(buildRoot, "LICENSE")),
            copyFile(join(packageRoot, "README.md"), join(buildRoot, "README.md")),
            cp(join(packageRoot, "themes"), join(buildRoot, "themes"), { recursive: true }),
        ]);

        for (const dependency of [
            "esbuild",
            "typescript",
            "@pierre/diffs",
            "ansi-styles",
            "unbash",
            "@zigai/pi-extension-settings",
            "typebox",
            "shiki",
            "@earendil-works/pi-coding-agent",
            "@earendil-works/pi-tui",
        ]) {
            const destination = join(buildRoot, "node_modules", dependency);
            await mkdir(dirname(destination), { recursive: true });
            await symlink(resolvedPackageRoot(dependency), destination, "dir");
        }

        execFileSync(process.execPath, [join(buildRoot, "scripts", "build.mjs")], {
            cwd: buildRoot,
            stdio: "pipe",
        });

        execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", root], {
            cwd: buildRoot,
            stdio: "pipe",
        });
        const archives = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
        expect(archives).toHaveLength(1);
        const archive = archives[0];
        if (archive === undefined) throw new Error("Missing packed package");

        const consumerRoot = join(root, "consumer");
        const installedRoot = join(consumerRoot, "node_modules", "@zigai", "pi-glowup");
        await mkdir(installedRoot, { recursive: true });
        execFileSync("tar", [
            "-xzf",
            join(root, archive),
            "-C",
            installedRoot,
            "--strip-components=1",
        ]);

        for (const dependency of ["@earendil-works/pi-coding-agent", "typebox"]) {
            const destination = join(consumerRoot, "node_modules", dependency);
            await mkdir(dirname(destination), { recursive: true });
            await symlink(resolvedPackageRoot(dependency), destination, "dir");
        }

        await writeFile(join(consumerRoot, "package.json"), JSON.stringify({ type: "module" }));
        await writeFile(
            join(consumerRoot, "tsconfig.json"),
            JSON.stringify({
                compilerOptions: {
                    strict: true,
                    noEmit: true,
                    skipLibCheck: true,
                    target: "ES2022",
                    module: "NodeNext",
                    moduleResolution: "NodeNext",
                    allowImportingTsExtensions: true,
                    types: [],
                },
                files: ["consumer.ts"],
            }),
        );

        const consumer = join(consumerRoot, "consumer.ts");
        await writeFile(
            consumer,
            `import glowup from "@zigai/pi-glowup";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
declare const pi: ExtensionAPI;
glowup(pi);
glowup({ on: pi.on });
`,
        );
        const compiler = fileURLToPath(new URL("../bin/tsc", import.meta.resolve("typescript")));
        const valid = spawnSync(process.execPath, [compiler, "--project", "tsconfig.json"], {
            cwd: consumerRoot,
            encoding: "utf8",
        });
        expect(valid.status, `${valid.stdout.slice(0, 3000)}\n${valid.stderr}`).toBe(0);

        await writeFile(
            consumer,
            `import glowup from "@zigai/pi-glowup";
glowup({});
`,
        );
        const invalid = spawnSync(process.execPath, [compiler, "--project", "tsconfig.json"], {
            cwd: consumerRoot,
            encoding: "utf8",
        });
        expect(invalid.status).not.toBe(0);
        expect(invalid.stdout).toContain("TS2345");
    }, 30_000);
});
