import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const repositoryRoot = resolve(packageRoot, "../..");
export const piCliPath = fileURLToPath(
  new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
);

/** Locate a declared dependency through npm resolution, including hoisted workspace links. */
export function resolvedPackageRoot(name) {
  let directory = dirname(fileURLToPath(import.meta.resolve(name)));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (manifest.name === name) return directory;
    } catch {
      // The public entry may be nested below its package manifest.
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate resolved package ${name}`);
    directory = parent;
  }
}

/** Pack the built local runtime closure, so verification never substitutes registry copies. */
export function packRuntimeDependencies(packDirectory) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return ["@zigai/pi-extension-settings", "@zigai/pi-glowup", "pi-typed-args"].map((name) => {
    const output = execFileSync(
      npm,
      ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory],
      {
        cwd: resolvedPackageRoot(name),
        encoding: "utf8",
        shell: process.platform === "win32",
      },
    );
    const parsed = JSON.parse(output);
    const description = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    if (!description?.filename) throw new Error(`npm pack returned no tarball for ${name}`);
    return join(packDirectory, description.filename);
  });
}
