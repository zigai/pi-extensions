import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { once } from "node:events";

import { Type } from "typebox";
import { Value } from "typebox/value";
import { checkProtocolPackage } from "./check-protocol-package.mjs";

const packageManifestSchema = Type.Object({
  files: Type.Array(Type.String()),
  exports: Type.Object({
    ".": Type.Object({ types: Type.String(), default: Type.String() }),
  }),
  piExtensionSettings: Type.Object({
    definition: Type.String(),
    prevalidation: Type.String(),
  }),
});

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = path.join(packageRoot, "dist", "src");
const bundleFiles = (await readdir(bundleDirectory)).filter(
  (file) => file.endsWith(".ts") && !file.endsWith(".d.ts"),
);
const [outputs, schema, sourceSchema, theme, packageManifest] = await Promise.all([
  Promise.all(bundleFiles.map(async (file) => readFile(path.join(bundleDirectory, file), "utf8"))),
  readFile(path.join(packageRoot, "dist", "config.schema.json"), "utf8"),
  readFile(path.join(packageRoot, "config.schema.json"), "utf8"),
  readFile(path.join(packageRoot, "themes", "darker-modern-theme.json"), "utf8"),
  readFile(path.join(packageRoot, "package.json"), "utf8").then((text) =>
    Value.Parse(packageManifestSchema, JSON.parse(text)),
  ),
]);
const output = outputs.join("\n");
assert.equal(schema, sourceSchema);
await Promise.all([
  readFile(path.join(packageRoot, packageManifest.exports["."].types)),
  readFile(path.join(packageRoot, packageManifest.exports["."].default)),
]);

for (const configuredPath of [
  packageManifest.piExtensionSettings.definition,
  packageManifest.piExtensionSettings.prevalidation,
  "./src/unknown-values.ts",
  "./src/rendering/preview-settings.ts",
  "./src/tools/protocol/decode.ts",
  "./src/tools/protocol/contract.ts",
  "./src/tools/protocol/nodes.ts",
  "./src/json-value.ts",
]) {
  const packagePath = configuredPath.replace(/^\.\//u, "");
  assert.equal(
    packageManifest.files.includes(packagePath),
    true,
    `published files must include ${packagePath}`,
  );
}

assert.doesNotThrow(() => JSON.parse(theme));
assert.equal(output.includes(packageRoot), false, "bundle must not contain workspace paths");

for (const requiredExternal of [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@zigai/pi-extension-settings/pi",
  "@zigai/pi-extension-settings/runtime",
  "typebox",
]) {
  assert.equal(
    output.includes(`from "${requiredExternal}"`),
    true,
    `bundle must retain ${requiredExternal} as an external`,
  );
}

assert.equal(
  output.includes('import("shiki")'),
  true,
  "Shiki must remain a first-use dynamic import",
);
assert.equal(
  /from\s+["']shiki(?:\/[^"']*)?["']/u.test(output),
  false,
  "Shiki must not be imported eagerly",
);

for (const inlinedDependency of ["@pierre/diffs", "ansi-styles", "unbash"]) {
  assert.equal(
    new RegExp(`(?:from|import\\()\\s*["']${inlinedDependency.replace("/", "\\/")}`).test(output),
    false,
    `bundle must inline ${inlinedDependency}`,
  );
}

for (const forbidden of [
  "node_modules/@earendil-works/pi-coding-agent",
  "node_modules/@earendil-works/pi-tui",
  "node_modules/shiki",
  "node_modules/typebox",
]) {
  assert.equal(output.includes(forbidden), false, `bundle must externalize ${forbidden}`);
}

await checkProtocolPackage(packageRoot);

const statementResponseSchema = Type.Object({
  id: Type.Integer(),
  units: Type.Array(Type.Object({ start: Type.Integer(), end: Type.Integer() })),
});

const statementWorker = new Worker(new URL("../dist/src/statement-worker.mjs", import.meta.url), {
  execArgv: [],
});

try {
  let id = 0;
  for (const { language, source, expected } of [
    {
      language: "javascript",
      source: "const complete = 1;\nconst pending =",
      expected: "const complete = 1;",
    },
    {
      language: "typescript",
      source: "const complete: number = 1;\nconst pending =",
      expected: "const complete: number = 1;",
    },
    { language: "python", source: "complete = 1\npending =", expected: "complete = 1" },
    { language: "bash", source: 'printf complete\nprintf "', expected: "printf complete" },
  ]) {
    id += 1;

    const pending = once(statementWorker, "message");

    statementWorker.postMessage({ id, source, language, complete: false });

    const parsed = Value.Parse(statementResponseSchema, (await pending)[0]);
    assert.equal(parsed.id, id);
    assert.deepEqual(
      parsed.units.map((unit) => source.slice(unit.start, unit.end)),
      [expected],
    );
  }
} finally {
  await statementWorker.terminate();
}

console.log("glowup package check passed");
