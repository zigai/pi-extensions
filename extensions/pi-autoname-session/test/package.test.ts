import { execFile } from "node:child_process";
import {
    access,
    copyFile,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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
    const installDir = await mkdtemp(join(tmpdir(), "pi-autoname-package-test-"));
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

        await writeFile(
            join(installDir, "package.json"),
            JSON.stringify({
                private: true,
                type: "module",
                dependencies: {
                    "@zigai/pi-autoname-session": `file:${join(installDir, archive)}`,
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
