import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";
import ts from "typescript";
import { pierreDiffsRuntimeSource } from "./pierre-diffs-runtime.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(packageRoot, "dist");
const outfile = path.join(outputRoot, "src", "index.ts");
const pierreDiffsDirectory = path.dirname(fileURLToPath(import.meta.resolve("@pierre/diffs")));

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
  "web-tree-sitter",
  "web-tree-sitter/*",
  "@vscode/tree-sitter-wasm",
  "@vscode/tree-sitter-wasm/*",
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.dirname(outfile), { recursive: true });

const result = await esbuild.build({
  absWorkingDir: packageRoot,
  entryPoints: ["src/index.ts", "src/presentation.ts"],
  outdir: path.dirname(outfile),
  outExtension: { ".js": ".ts" },
  bundle: true,
  splitting: true,
  chunkNames: "shared-[hash]",
  platform: "node",
  format: "esm",
  target: "node22.19",
  define: {
    "import.meta.glowupThemeDirectory": JSON.stringify("../../themes"),
    "import.meta.glowupSyntaxWorker": JSON.stringify("./tokenize-worker.mjs"),
    "import.meta.glowupStatementWorker": JSON.stringify("./statement-worker.mjs"),
  },
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
          path: "pierre-diffs-runtime",
          namespace: "pi-glowup-pierre-runtime",
        }));
        build.onLoad({ filter: /.*/, namespace: "pi-glowup-pierre-runtime" }, () => ({
          contents: pierreDiffsRuntimeSource,
          resolveDir: pierreDiffsDirectory,
          loader: "js",
        }));
      },
    },
  ],
  metafile: true,
});

const workerResult = await esbuild.build({
  absWorkingDir: packageRoot,
  entryPoints: ["src/rendering/syntax/tokenize-worker.ts"],
  outfile: path.join(outputRoot, "src", "tokenize-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.19",
  treeShaking: true,
  sourcemap: true,
  sourcesContent: true,
  legalComments: "none",
  external,
  metafile: true,
});

const statementWorkerResult = await esbuild.build({
  absWorkingDir: packageRoot,
  entryPoints: ["src/rendering/streaming/statement-worker.ts"],
  outfile: path.join(outputRoot, "src", "statement-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.19",
  treeShaking: true,
  sourcemap: true,
  sourcesContent: true,
  legalComments: "none",
  external,
  metafile: true,
});

await copyFile(
  path.join(packageRoot, "config.schema.json"),
  path.join(outputRoot, "config.schema.json"),
);

const bundledHostInputs = [
  ...Object.keys(result.metafile.inputs),
  ...Object.keys(workerResult.metafile.inputs),
  ...Object.keys(statementWorkerResult.metafile.inputs),
].filter((input) =>
  /node_modules\/(?:@earendil-works|@mariozechner|@sinclair\/typebox|shiki|typebox)\//u.test(input),
);
if (bundledHostInputs.length > 0) {
  throw new Error(
    `Host or lazy syntax modules entered the bundle: ${bundledHostInputs.join(", ")}`,
  );
}

const output = await readFile(outfile, "utf8");
if (output.includes(packageRoot)) throw new Error("Bundle contains an absolute workspace path");

const configFile = ts.readConfigFile(path.join(packageRoot, "tsconfig.json"), (file) =>
  ts.sys.readFile(file),
);
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageRoot);
const declarations = ts.createProgram(
  [path.join(packageRoot, "src", "index.ts"), path.join(packageRoot, "src", "presentation.ts")],
  {
    ...parsedConfig.options,
    allowJs: false,
    checkJs: false,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    rootDir: path.join(packageRoot, "src"),
    outDir: path.join(outputRoot, "src"),
  },
);
const diagnostics = ts.getPreEmitDiagnostics(declarations);
if (diagnostics.length > 0) {
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => packageRoot,
      getNewLine: () => "\n",
    }),
  );
}

declarations.emit();
