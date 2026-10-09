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
import { homedir } from "node:os";
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

const PackOutputSchema = Type.Object({
    "@zigai/pi-extension-settings": PackDescriptionSchema,
});
const PackageVersionSchema = Type.Object({ version: Type.String() });

type CommandResult = {
    readonly stdout: string;
    readonly stderr: string;
};

async function runCommand(
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

const cacheDirectory = path.join(homedir(), ".cache", "pi-tweaks", "package-tests");
await mkdir(cacheDirectory, { recursive: true });
const temporaryRoot = await mkdtemp(path.join(cacheDirectory, "settings-"));

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
            "--workspaces=false",
            "--json",
            "--pack-destination",
            packDirectory,
        ],
        packageRoot,
    );
    const packed = Value.Parse(PackOutputSchema, JSON.parse(packedCommand.stdout))[
        "@zigai/pi-extension-settings"
    ];

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
        `${JSON.stringify(
            {
                private: true,
                type: "module",
                piExtensionSettings: {
                    definition: "./settings-input.ts",
                    prevalidation: "./settings.prevalidated.ts",
                },
            },
            undefined,
            2,
        )}\n`,
    );

    const piVersion = await installedVersion(
        fileURLToPath(new URL("..", import.meta.resolve("@earendil-works/pi-coding-agent"))),
    );
    const typeboxVersion = await installedVersion(
        fileURLToPath(new URL("..", import.meta.resolve("typebox"))),
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

    // Generate with Node before Pi transforms the same codec source. Function text changes
    // during that transformation must not invalidate the generated runtime artifact.
    await writeFile(path.join(consumerDirectory, "README.md"), "# Package check\n");
    await writeFile(
        path.join(consumerDirectory, "settings-input.ts"),
        [
            'import { Type } from "typebox";',
            "export default {",
            '  id: "package-check", title: "Package Check", description: "Packed codec settings.",',
            "  schema: Type.Object({",
            '    value: Type.Codec(Type.String({ default: "value", description: "Codec value." }))',
            "      .Decode((value) => value + '-decoded')",
            "      .Encode((value) => value.slice(0,-8)),",
            "  }, { additionalProperties: false }),",
            "};",
            "",
        ].join("\n"),
    );
    await runCommand(
        npmExecutable,
        ["exec", "--dry-run=false", "--", "pi-extension-settings", "generate"],
        consumerDirectory,
    );
    await runCommand(
        npmExecutable,
        ["exec", "--dry-run=false", "--", "pi-extension-settings", "check"],
        consumerDirectory,
    );
    await writeFile(
        path.join(consumerDirectory, "extension.ts"),
        [
            'import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";',
            'import { loadPiExtensionSettings, updatePiExtensionSettings } from "@zigai/pi-extension-settings/pi";',
            'import input from "./settings-input.ts";',
            'import artifact from "./settings.prevalidated.ts";',
            "export const settingsDefinition = definePrevalidatedExtensionSettings(input, artifact);",
            "",
            "export default function extension(pi) {",
            '  pi.on("session_start", async (_event, ctx) => {',
            "    const options = { bundledSchema: { kind: 'url', url: new URL('./config.schema.json', import.meta.url) } };",
            "    const first = loadPiExtensionSettings(settingsDefinition, ctx, options);",
            '    if (first.settings.value !== "value-decoded") throw new Error("packed codec did not decode");',
            "    const updated = await updatePiExtensionSettings(settingsDefinition, ctx, {",
            "      scope: 'global',",
            "      update: (current) => ({ ...current, value: 'updated' }),",
            "    });",
            "    if (updated.status !== 'updated' && updated.status !== 'unchanged') throw new Error(JSON.stringify(updated));",
            "    const reloaded = loadPiExtensionSettings(settingsDefinition, ctx, options);",
            '    if (reloaded.settings.value !== "updated-decoded") throw new Error("packed update did not reload");',
            "    globalThis.__packageCheckLoaded = reloaded;",
            "  });",
            "}",
            "",
        ].join("\n"),
    );
    await writeFile(
        path.join(consumerDirectory, "verify.mjs"),
        [
            'import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";',
            'import * as authoring from "@zigai/pi-extension-settings";',
            'import { existsSync } from "node:fs";',
            'import path from "node:path";',
            'if (typeof authoring.defineExtensionSettings !== "function") throw new Error("root import failed");',
            'const agentDir = path.join(process.cwd(), "agent");',
            'const settingsDir = path.join(agentDir, "extension-settings");',
            "process.env.PI_CODING_AGENT_DIR = agentDir;",
            'if (existsSync(settingsDir)) throw new Error("import created settings files");',
            "const loader = new DefaultResourceLoader({",
            "  cwd: process.cwd(),",
            "  agentDir,",
            '  additionalExtensionPaths: [path.join(process.cwd(), "extension.ts")],',
            "  noSkills: true, noPromptTemplates: true, noThemes: true,",
            "});",
            "await loader.reload();",
            "const loaded = loader.getExtensions();",
            "if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));",
            'if (loaded.extensions.length !== 1) throw new Error("extension did not load");',
            'if (existsSync(settingsDir)) throw new Error("factory created settings files");',
            'const handlers = loaded.extensions[0].handlers.get("session_start") ?? [];',
            'if (handlers.length !== 1) throw new Error("session handler missing");',
            "await handlers[0]({ type: 'session_start', reason: 'startup' }, {",
            "  cwd: process.cwd(),",
            "  isProjectTrusted: () => true,",
            "});",
            'if (!existsSync(path.join(settingsDir, "package-check.json"))) throw new Error("settings not scaffolded");',
            'if (globalThis.__packageCheckLoaded?.settings.value !== "updated-decoded") throw new Error("lifecycle result missing");',
            "",
        ].join("\n"),
    );
    await runCommand(process.execPath, ["verify.mjs"], consumerDirectory);

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
