import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(packageRoot, "dist");
const outfile = path.join(outputRoot, "src", "index.ts");
const pierreDiffsRuntime = path.join(packageRoot, "scripts", "pierre-diffs-runtime.mjs");
const external = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-agent-core/*",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/*",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-coding-agent/*",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-tui/*",
  "@mariozechner/*",
  "@zigai/pi-extension-settings",
  "@zigai/pi-extension-settings/*",
  "@sinclair/typebox",
  "@sinclair/typebox/*",
  "shiki",
  "shiki/*",
  "typebox",
  "typebox/*",
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.dirname(outfile), { recursive: true });
const result = await esbuild.build({
  absWorkingDir: packageRoot,
  entryPoints: ["src/index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  treeShaking: true,
  sourcemap: true,
  sourcesContent: true,
  legalComments: "none",
  external,
  plugins: [
    {
      name: "pi-glowup-pierre-runtime",
      setup(build) {
        build.onResolve({ filter: /^@pierre\/diffs$/ }, () => ({
          path: pierreDiffsRuntime,
        }));
      },
    },
  ],
  metafile: true,
});
await copyFile(
  path.join(packageRoot, "config.schema.json"),
  path.join(outputRoot, "config.schema.json"),
);

const bundledHostInputs = Object.keys(result.metafile.inputs).filter((input) =>
  /node_modules\/(?:@earendil-works|@mariozechner|@sinclair\/typebox|shiki|typebox)\//u.test(input),
);
if (bundledHostInputs.length > 0) {
  throw new Error(
    `Host or lazy syntax modules entered the bundle: ${bundledHostInputs.join(", ")}`,
  );
}
const output = await readFile(outfile, "utf8");
if (output.includes(packageRoot)) throw new Error("Bundle contains an absolute workspace path");
