import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Exercise the public SDK from the tarball without access to repository source.
 * @param {string} packageRoot
 */
export async function checkProtocolPackage(packageRoot) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "glowup-protocol-package-"));

  try {
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", temporaryRoot], {
      cwd: packageRoot,
      stdio: "pipe",
    });

    const archives = (await readdir(temporaryRoot)).filter((name) => name.endsWith(".tgz"));
    const archive = archives[0];
    if (archives.length !== 1 || archive === undefined) {
      throw new Error("npm pack must produce exactly one package");
    }

    const consumerRoot = path.join(temporaryRoot, "consumer");
    const installedRoot = path.join(consumerRoot, "node_modules", "@zigai", "pi-glowup");
    await mkdir(installedRoot, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      path.join(temporaryRoot, archive),
      "-C",
      installedRoot,
      "--strip-components=1",
    ]);

    // Supply only the public protocol's declared schema peer, not workspace sources.
    await symlink(
      path.join(packageRoot, "node_modules", "typebox"),
      path.join(consumerRoot, "node_modules", "typebox"),
      "dir",
    );
    await copyFile(
      path.join(packageRoot, "test", "typecheck", "packed-protocol-consumer.ts"),
      path.join(consumerRoot, "consumer.ts"),
    );
    await writeFile(path.join(consumerRoot, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      path.join(consumerRoot, "tsconfig.json"),
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
    execFileSync(
      process.execPath,
      [
        path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"),
        "--project",
        path.join(consumerRoot, "tsconfig.json"),
      ],
      { cwd: consumerRoot, stdio: "pipe" },
    );
    execFileSync(
      process.execPath,
      [
        "--import",
        fileURLToPath(import.meta.resolve("tsx")),
        path.join(consumerRoot, "consumer.ts"),
      ],
      { cwd: consumerRoot, stdio: "pipe" },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
