import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Value } from "typebox/value";
import { loadWorkspacePackages, workspaceManifest } from "./workspace-packages.ts";
import { loadReleasePackages, planWorkspacePublish } from "./publish-workspace.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = loadWorkspacePackages(packageRoot);

/**
 * @param {string} cwd
 * @param {string} destination
 * @returns {string}
 */
function pack(cwd, destination) {
    const result = execFileSync(
        "npm",
        ["pack", "--silent", "--ignore-scripts", "--pack-destination", destination],
        {
            cwd,
            encoding: "utf8",
        },
    );
    const filename = result.trim().split(/\r?\n/u).at(-1);
    if (filename === undefined || filename.length === 0) {
        throw new Error(`npm pack did not report a tarball for ${cwd}`);
    }

    return path.join(destination, filename);
}

const cacheRoot = path.join(homedir(), ".cache", "pi-tweaks", "package-check");
mkdirSync(cacheRoot, { recursive: true });

const temporaryRoot = mkdtempSync(path.join(cacheRoot, "run-"));

try {
    const tarballDirectory = path.join(temporaryRoot, "tarballs");
    mkdirSync(tarballDirectory, { recursive: true });

    const tarballs = new Map(
        workspaces.packages.map((workspace) => [
            workspace.manifest.name,
            pack(workspace.directory, tarballDirectory),
        ]),
    );
    const releases = loadReleasePackages(packageRoot);
    const collection = workspaces.packages.find(
        (workspace) => workspace.manifest.piCollection !== undefined,
    );
    assert.ok(collection, "collection workspace must exist");

    const consumers = [
        ...workspaces.packages.filter((workspace) => workspace !== collection),
        collection,
    ];

    for (const [index, consumer] of consumers.entries()) {
        const consumerRoot = path.join(temporaryRoot, `consumer-${index}`);
        const installRoot = path.join(consumerRoot, "install");
        const agentDirectory = path.join(consumerRoot, "agent");
        const sessionDirectory = path.join(consumerRoot, "sessions");
        const projectDirectory = path.join(consumerRoot, "project");

        for (const directory of [installRoot, agentDirectory, sessionDirectory, projectDirectory]) {
            mkdirSync(directory, { recursive: true });
        }

        let closure = planWorkspacePublish(releases, consumer.manifest.name);
        let consumerTarballs;
        if (consumer === collection) {
            const collectionRelease = releases.find(
                (workspace) => workspace.name === consumer.manifest.name,
            );
            assert.ok(collectionRelease !== undefined, "collection release package must exist");
            closure = [collectionRelease];
            consumerTarballs = [tarballs.get(consumer.manifest.name)];
        } else {
            consumerTarballs = closure.map((workspace) => tarballs.get(workspace.name));
        }

        assert.ok(
            consumerTarballs.every((tarball) => tarball !== undefined),
            "consumer tarballs must exist",
        );

        execFileSync(
            "npm",
            [
                "install",
                ...consumerTarballs,
                "--prefix",
                installRoot,
                "--legacy-peer-deps",
                "--prefer-offline",
                "--package-lock=false",
            ],
            { cwd: packageRoot, encoding: "utf8", stdio: "pipe" },
        );

        const installedModules = path.join(installRoot, "node_modules");
        assert.equal(
            existsSync(path.join(installedModules, "@earendil-works")),
            false,
            "managed-install check must not install Pi host peers",
        );

        const piPackageDirectory = path.join(
            packageRoot,
            "node_modules",
            "@earendil-works",
            "pi-coding-agent",
        );
        const piCli = path.join(piPackageDirectory, "dist", "bundle", "cli.js");

        if (closure.some((workspace) => workspace.name === "@zigai/pi-extension-internals")) {
            const internalsDirectory = path.join(
                installedModules,
                "@zigai",
                "pi-extension-internals",
            );
            const internalsEntry = path.join(internalsDirectory, "dist", "index.js");
            assert.ok(existsSync(internalsEntry), "shared internals must publish JavaScript");
            assert.ok(
                existsSync(path.join(internalsDirectory, "dist", "index.d.ts")),
                "shared internals must publish TypeScript declarations",
            );
            assert.equal(
                existsSync(path.join(internalsDirectory, "src", "index.ts")),
                false,
                "shared internals must not require raw TypeScript at runtime",
            );

            execFileSync(
                process.execPath,
                [
                    "--input-type=module",
                    "--eval",
                    `import { installLinkedMethodPatch, registerEditorEnhancer, loadPiInternalModule } from "@zigai/pi-extension-internals";
if (typeof installLinkedMethodPatch !== "function" || typeof registerEditorEnhancer !== "function") {
    throw new Error("shared internals could not be imported natively without Pi host peers");
}
const options = {
    scope: "pi-tweaks-package-check",
    feature: "theme module",
    parse: (module) => "theme" in module ? "loaded" : undefined,
};
if (await loadPiInternalModule("modes/interactive/theme/theme.js", options) !== "loaded") {
    throw new Error("shared internals could not resolve the explicit Pi package directory");
}
delete process.env.PI_PACKAGE_DIR;
process.env.PI_CODING_AGENT = "true";
process.argv[1] = ${JSON.stringify(piCli)};
if (await loadPiInternalModule("modes/interactive/theme/theme.js", options) !== "loaded") {
    throw new Error("shared internals could not resolve the running Pi CLI");
}`,
                ],
                {
                    cwd: installRoot,
                    encoding: "utf8",
                    env: { ...process.env, PI_PACKAGE_DIR: piPackageDirectory },
                },
            );
        }

        const installedConsumer = path.join(installedModules, consumer.manifest.name);
        const extensionEntries = (consumer.manifest.pi?.extensions ?? []).map((entry) => {
            const installedEntry = path.join(installedConsumer, entry);
            assert.ok(
                existsSync(installedEntry),
                `${consumer.manifest.name} must contain its declared resource ${entry}`,
            );
            return installedEntry;
        });
        const installedPackages = closure.map((workspace) =>
            path.join(installedModules, workspace.name),
        );
        if (consumer === collection) {
            installedPackages.push(
                ...workspaces.extensions.map(({ workspace }) =>
                    path.join(installedConsumer, "node_modules", workspace.manifest.name),
                ),
            );
        }

        for (const installedPackage of installedPackages) {
            const manifestPath = path.join(installedPackage, "package.json");
            assert.ok(
                existsSync(manifestPath),
                `installed dependency must contain ${manifestPath}`,
            );

            /** @type {unknown} */
            const installedValue = JSON.parse(readFileSync(manifestPath, "utf8"));
            assert.ok(
                Value.Check(workspaceManifest, installedValue),
                `Invalid installed workspace manifest ${manifestPath}`,
            );

            const manifest = Value.Parse(workspaceManifest, installedValue);
            if (manifest.piExtensionSettings === undefined) continue;

            for (const relativePath of Object.values(manifest.piExtensionSettings)) {
                assert.ok(
                    existsSync(path.join(installedPackage, relativePath)),
                    `${manifest.name} must contain ${relativePath}`,
                );
            }
        }

        writeFileSync(path.join(agentDirectory, "auth.json"), "{}\n");
        writeFileSync(path.join(agentDirectory, "models-store.json"), "{}\n");
        const consumerPackages = [];
        if (extensionEntries.length > 0) consumerPackages.push(installedConsumer);
        writeFileSync(
            path.join(agentDirectory, "settings.json"),
            `${JSON.stringify(
                {
                    defaultProjectTrust: "always",
                    packages: consumerPackages,
                    quietStartup: true,
                },
                undefined,
                2,
            )}\n`,
        );

        const bundleUrl = pathToFileURL(path.join(piPackageDirectory, "dist/bundle/index.js")).href;
        const identityProbe = path.join(projectDirectory, "pi-public-identity-probe.ts");

        const publicClasses = [
            "TreeSelectorComponent",
            "AssistantMessageComponent",
            "UserMessageComponent",
            "InteractiveMode",
            "ModelSelectorComponent",
            "Theme",
        ];
        writeFileSync(
            identityProbe,
            `import * as pi from "@earendil-works/pi-coding-agent";
export default async function () {
    const host = globalThis[Symbol.for("zigai.pi-tweaks.package-check-host")];
    const deferred = await import("@earendil-works/pi-coding-agent");
    for (const name of ${JSON.stringify(publicClasses)}) {
        if (pi[name] !== host[name] || deferred[name] !== host[name]) {
            throw new Error(name + " is not the running Pi class");
        }
    }
}
`,
        );

        const probePaths = [...extensionEntries, identityProbe];
        let librarySource;
        if (consumer.manifest.name === "@zigai/pi-extension-settings") {
            librarySource = `import { defineExtensionSettings } from "@zigai/pi-extension-settings";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import { loadPiExtensionSettings, updatePiExtensionSettings } from "@zigai/pi-extension-settings/pi";
export default function () {
    for (const entry of [defineExtensionSettings, definePrevalidatedExtensionSettings, loadPiExtensionSettings, updatePiExtensionSettings]) {
        if (typeof entry !== "function") throw new Error("settings published API is unavailable");
    }
}`;
            assert.ok(
                existsSync(path.join(installedConsumer, "dist/index.js")),
                "settings authoring API must publish JavaScript",
            );
            assert.ok(
                existsSync(path.join(installedConsumer, "dist/index.d.ts")),
                "settings must publish declarations",
            );

            const authoringRoot = path.join(consumerRoot, "authoring");
            mkdirSync(authoringRoot, { recursive: true });

            const typeboxTarball = pack(
                path.join(packageRoot, "node_modules", "typebox"),
                tarballDirectory,
            );
            const settingsTarball = tarballs.get(consumer.manifest.name);
            assert.ok(settingsTarball !== undefined);
            execFileSync(
                "npm",
                [
                    "install",
                    settingsTarball,
                    typeboxTarball,
                    "--prefix",
                    authoringRoot,
                    "--legacy-peer-deps",
                    "--prefer-offline",
                    "--package-lock=false",
                ],
                {
                    cwd: packageRoot,
                    encoding: "utf8",
                    stdio: "pipe",
                },
            );

            const help = execFileSync(
                process.execPath,
                [
                    path.join(
                        authoringRoot,
                        "node_modules/@zigai/pi-extension-settings/dist/cli-entry.js",
                    ),
                    "--help",
                ],
                {
                    cwd: authoringRoot,
                    encoding: "utf8",
                },
            );
            assert.match(
                help,
                /Usage: pi-extension-settings/u,
                "installed settings CLI must run natively",
            );

            execFileSync(
                process.execPath,
                [
                    "--input-type=module",
                    "--eval",
                    'import { defineExtensionSettings } from "@zigai/pi-extension-settings"; if (typeof defineExtensionSettings !== "function") throw new Error("settings root API unavailable");',
                ],
                {
                    cwd: authoringRoot,
                    encoding: "utf8",
                },
            );
        } else if (consumer.manifest.name === "pi-typed-args") {
            librarySource = `import { defineTypedCommand } from "pi-typed-args";
import { parseTypedCommandArgs } from "pi-typed-args/core";
import { registerTypedCommand } from "pi-typed-args/command";
export default function () {
    for (const entry of [defineTypedCommand, parseTypedCommandArgs, registerTypedCommand]) {
        if (typeof entry !== "function") throw new Error("typed arguments published API is unavailable");
    }
}`;
            assert.ok(
                existsSync(path.join(installedConsumer, "schemas/skill-arguments.schema.json")),
                "typed arguments must publish its schema",
            );
        }

        if (librarySource !== undefined) {
            const libraryProbe = path.join(installRoot, "library-public-api-probe.ts");
            writeFileSync(libraryProbe, librarySource);
            probePaths.push(libraryProbe);
        }

        const loadProbe = `
        import * as host from ${JSON.stringify(bundleUrl)};
        globalThis[Symbol.for("zigai.pi-tweaks.package-check-host")] = host;
        const paths = JSON.parse(process.argv[1]);
        const additionalPaths = paths.slice(${extensionEntries.length});
        const expected = [...additionalPaths, ...paths.slice(0, ${extensionEntries.length})];
        const loader = new host.DefaultResourceLoader({
            cwd: process.cwd(),
            agentDir: process.env.PI_CODING_AGENT_DIR,
            additionalExtensionPaths: additionalPaths,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
        });
        await loader.reload();
        const result = loader.getExtensions();
        const actual = result.extensions.map((extension) => extension.resolvedPath);
        if (result.errors.length > 0 || JSON.stringify(actual) !== JSON.stringify(expected)) {
            console.error(JSON.stringify({ actual, expected, errors: result.errors }));
            process.exitCode = 1;
        }
    `;

        execFileSync(
            process.execPath,
            ["--input-type=module", "--eval", loadProbe, JSON.stringify(probePaths)],
            {
                cwd: projectDirectory,
                encoding: "utf8",
                env: {
                    ...process.env,
                    PI_CODING_AGENT: "true",
                    PI_PACKAGE_DIR: piPackageDirectory,
                    PI_CODING_AGENT_DIR: agentDirectory,
                    PI_OFFLINE: "1",
                },
            },
        );

        const loaded = spawnSync(
            process.execPath,
            [piCli, "--mode", "rpc", "--no-session", "--session-dir", sessionDirectory],
            {
                cwd: projectDirectory,
                encoding: "utf8",
                env: {
                    ...process.env,
                    NO_COLOR: "1",
                    PI_CODING_AGENT_DIR: agentDirectory,
                    PI_OFFLINE: "1",
                    PI_SKIP_VERSION_CHECK: "1",
                },
                input: '{"type":"get_state"}\n',
                timeout: 120_000,
            },
        );

        assert.equal(loaded.error, undefined, loaded.error?.message);
        assert.equal(
            loaded.status,
            0,
            `packed extensions failed to load\nstdout:\n${loaded.stdout}\nstderr:\n${loaded.stderr}`,
        );
        assert.match(loaded.stdout, /"type":"response"/u, "Pi must answer the load probe");
        assert.doesNotMatch(
            loaded.stderr,
            /unavailable; Pi internals may have changed/u,
            `packed extension disabled a Pi-internal feature:\n${loaded.stderr}`,
        );

        console.log(`Package consumer passed: ${consumer.manifest.name}`);
    }
} finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("pi-tweaks package check passed");
