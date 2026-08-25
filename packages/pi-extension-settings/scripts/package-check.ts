import { spawn } from "node:child_process";
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import { Value } from "typebox/value";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const PackDescriptionSchema = Type.Object({
    filename: Type.String(),
    files: Type.Array(Type.Object({ path: Type.String() })),
});
const PackOutputSchema = Type.Union([
    Type.Array(PackDescriptionSchema, { minItems: 1 }),
    Type.Record(Type.String(), PackDescriptionSchema),
]);
const PackageVersionSchema = Type.Object({ version: Type.String() });

type CommandResult = {
    readonly stdout: string;
    readonly stderr: string;
};

function runCommand(
    command: string,
    arguments_: readonly string[],
    cwd: string,
): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, arguments_, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code, signal) => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            reject(
                new Error(
                    `${command} ${arguments_.join(" ")} failed (${String(code ?? signal)}): ${stderr || stdout}`,
                ),
            );
        });
    });
}

async function installedVersion(packagePath: string): Promise<string> {
    const parsed = Value.Parse(
        PackageVersionSchema,
        JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8")),
    );
    return parsed.version;
}

async function collectTextFiles(directory: string): Promise<readonly string[]> {
    const found: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            found.push(...(await collectTextFiles(entryPath)));
        } else if ([".js", ".json", ".map", ".md", ".ts"].includes(path.extname(entry.name))) {
            found.push(entryPath);
        }
    }
    return found;
}

async function assertMissing(pathname: string, message: string): Promise<void> {
    try {
        await access(pathname);
    } catch {
        return;
    }
    throw new Error(message);
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pi-extension-settings-package-"));
try {
    const packDirectory = path.join(temporaryRoot, "pack");
    const consumerDirectory = path.join(temporaryRoot, "consumer");
    await Promise.all([mkdir(packDirectory), mkdir(consumerDirectory)]);

    const packedCommand = await runCommand(
        npmExecutable,
        [
            "pack",
            "--dry-run=false",
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            packDirectory,
        ],
        packageRoot,
    );
    const packOutput = Value.Parse(PackOutputSchema, JSON.parse(packedCommand.stdout));
    const packed = Array.isArray(packOutput) ? packOutput[0] : Object.values(packOutput)[0];
    if (packed === undefined) throw new Error("npm pack did not return an artifact");

    const packedFiles = new Set(packed.files.map((file) => file.path));
    for (const required of [
        "package.json",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/pi.ts",
        "dist/pi.d.ts",
        "dist/runtime.ts",
        "dist/runtime.d.ts",
        "dist/cli-entry.js",
        "README.md",
        "docs/manual-setup.md",
        "docs/generation.md",
        "docs/runtime.md",
        "docs/ui-controls.md",
        "LICENSE",
    ]) {
        if (!packedFiles.has(required)) throw new Error(`npm package is missing ${required}`);
    }
    for (const packedFile of packedFiles) {
        if (
            packedFile.startsWith("node_modules/") ||
            packedFile.includes("/node_modules/") ||
            packedFile.startsWith("src/") ||
            packedFile.startsWith("test/") ||
            packedFile.startsWith("scripts/")
        ) {
            throw new Error(`npm package contains development-only content: ${packedFile}`);
        }
    }

    await writeFile(
        path.join(consumerDirectory, "package.json"),
        `${JSON.stringify({ private: true, type: "module" }, undefined, 2)}\n`,
    );
    const piVersion = await installedVersion(
        path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
    );
    const typeboxVersion = await installedVersion(
        path.join(packageRoot, "node_modules", "typebox"),
    );
    const tarballPath = path.join(packDirectory, packed.filename);
    await runCommand(
        npmExecutable,
        [
            "install",
            "--dry-run=false",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            tarballPath,
            `@earendil-works/pi-coding-agent@${piVersion}`,
            `typebox@${typeboxVersion}`,
        ],
        consumerDirectory,
    );

    await writeFile(
        path.join(consumerDirectory, "extension.ts"),
        [
            'import * as authoring from "@zigai/pi-extension-settings";',
            'import * as runtime from "@zigai/pi-extension-settings/runtime";',
            'import * as piSettings from "@zigai/pi-extension-settings/pi";',
            "",
            "export default function extension(pi) {",
            '  if (typeof authoring.defineExtensionSettings !== "function") throw new Error("root export missing");',
            '  if (typeof runtime.definePrevalidatedExtensionSettings !== "function") throw new Error("runtime export missing");',
            '  if (typeof piSettings.loadPiExtensionSettings !== "function") throw new Error("pi export missing");',
            '  pi.on("session_start", () => {});',
            "}",
            "",
        ].join("\n"),
    );
    await writeFile(
        path.join(consumerDirectory, "smoke.mjs"),
        [
            'import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";',
            'import * as authoring from "@zigai/pi-extension-settings";',
            'import path from "node:path";',
            'if (typeof authoring.defineExtensionSettings !== "function") throw new Error("root import failed");',
            "const loader = new DefaultResourceLoader({",
            "  cwd: process.cwd(),",
            '  agentDir: path.join(process.cwd(), "agent"),',
            '  additionalExtensionPaths: [path.join(process.cwd(), "extension.ts")],',
            "});",
            "await loader.reload();",
            "const loaded = loader.getExtensions();",
            "if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));",
            'if (loaded.extensions.length !== 1) throw new Error("extension did not load");',
            "",
        ].join("\n"),
    );
    await runCommand(process.execPath, ["smoke.mjs"], consumerDirectory);
    const cli = await runCommand(
        npmExecutable,
        ["exec", "--dry-run=false", "--", "pi-extension-settings", "--help"],
        consumerDirectory,
    );
    if (!cli.stdout.startsWith("Usage: pi-extension-settings")) {
        throw new Error("installed CLI did not print its help text");
    }

    const installedPackage = await realpath(
        path.join(consumerDirectory, "node_modules", "@zigai", "pi-extension-settings"),
    );
    await assertMissing(
        path.join(installedPackage, "node_modules"),
        "installed package contains nested node_modules",
    );
    const workspacePaths = new Set([packageRoot, packageRoot.split(path.sep).join("/")]);
    for (const file of await collectTextFiles(installedPackage)) {
        const content = await readFile(file, "utf8");
        for (const workspacePath of workspacePaths) {
            if (content.includes(workspacePath)) {
                throw new Error(`installed package contains an absolute workspace path: ${file}`);
            }
        }
    }

    console.log("packed package check passed");
} finally {
    await rm(temporaryRoot, { recursive: true, force: true });
}
