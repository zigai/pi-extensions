import { execFile } from "node:child_process";
import {
    access,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const repositoryDir = fileURLToPath(new URL("../", import.meta.url));
const packageVersionSchema = Type.Object({ version: Type.String({ minLength: 1 }) });

async function installedVersion(packageName: string): Promise<string> {
    const manifestUrl = new URL("../package.json", import.meta.resolve(packageName));
    const document: unknown = JSON.parse(await readFile(manifestUrl, "utf8"));
    return Value.Parse(packageVersionSchema, document).version;
}

it("loads the packed production install in Pi and restores persisted naming progress", async () => {
    const cacheDir = join(homedir(), ".cache", "pi-tweaks", "package-tests");
    await mkdir(cacheDir, { recursive: true });
    const installDir = await mkdtemp(join(cacheDir, "autoname-"));
    try {
        const npmrc = join(installDir, "npmrc");
        const globalNpmrc = join(installDir, "global-npmrc");
        await Promise.all([writeFile(npmrc, ""), writeFile(globalNpmrc, "")]);
        const runtimeDir = join(installDir, "runtime");
        const env: NodeJS.ProcessEnv = {
            PATH: process.env.PATH,
            PI_CODING_AGENT_DIR: join(runtimeDir, "agent"),
            PI_OFFLINE: "1",
            npm_config_userconfig: npmrc,
            npm_config_globalconfig: globalNpmrc,
            npm_config_fetch_retries: "0",
            npm_config_fetch_timeout: "30000",
        };
        await execute("npm", ["pack", "--pack-destination", installDir], {
            cwd: repositoryDir,
            env,
            timeout: 30_000,
        });
        const archives = (await readdir(installDir)).filter((name) => name.endsWith(".tgz"));
        expect(archives).toHaveLength(1);
        const archive = archives[0];
        if (archive === undefined) {
            throw new Error("npm pack did not produce an archive.");
        }

        const settingsPackageDir = fileURLToPath(
            new URL("..", import.meta.resolve("@zigai/pi-extension-settings")),
        );
        const settingsPack = await execute(
            "npm",
            [
                "pack",
                "--ignore-scripts",
                "--workspaces=false",
                "--json",
                "--pack-destination",
                installDir,
            ],
            { cwd: settingsPackageDir, env, timeout: 30_000 },
        );
        const packDescriptionSchema = Type.Object({ filename: Type.String() });
        const settingsPackOutput = Value.Parse(
            Type.Union([
                Type.Tuple([packDescriptionSchema]),
                Type.Object({ "@zigai/pi-extension-settings": packDescriptionSchema }),
            ]),
            JSON.parse(settingsPack.stdout),
        );
        const packedSettings = Object.values(settingsPackOutput)[0];
        if (packedSettings === undefined) {
            throw new Error("npm pack did not describe the settings archive.");
        }

        await writeFile(
            join(installDir, "package.json"),
            JSON.stringify({
                private: true,
                type: "module",
                dependencies: {
                    "@zigai/pi-autoname-session": `file:${join(installDir, archive)}`,
                    "@zigai/pi-extension-settings": `file:${join(installDir, packedSettings.filename)}`,
                    "@earendil-works/pi-coding-agent": await installedVersion(
                        "@earendil-works/pi-coding-agent",
                    ),
                    "@earendil-works/pi-ai": await installedVersion("@earendil-works/pi-ai"),
                    typebox: await installedVersion("typebox"),
                },
            }),
        );

        await execute(
            "npm",
            ["install", "--omit=dev", "--no-audit", "--no-fund", "--prefer-offline"],
            {
                cwd: installDir,
                env,
                timeout: 120_000,
                maxBuffer: 4 * 1024 * 1024,
            },
        );
        const installedPackage = join(installDir, "node_modules", "@zigai", "pi-autoname-session");
        expect(await realpath(installedPackage)).toBe(installedPackage);
        await access(join(installedPackage, "src", "settings.prevalidated.ts"));
        await access(join(installedPackage, "config.schema.json"));
        await expect(access(join(installDir, "node_modules", "vitest"))).rejects.toThrow();
        const fixture = join(installDir, "package-fixture.ts");
        await copyFile(new URL("./package-fixture.ts", import.meta.url), fixture);
        const result = await execute(process.execPath, [fixture, installedPackage, runtimeDir], {
            cwd: installDir,
            env,
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
        });
        expect(result.stdout).toBe(
            "Installed package named and restored the session and refresh baseline.\n",
        );

        expect(result.stderr).toBe("");
    } finally {
        await rm(installDir, { recursive: true, force: true });
    }
}, 180_000);
