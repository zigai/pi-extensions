import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import { Value } from "typebox/value";

const packageManifestSchema = Type.Object({
  files: Type.Array(Type.String()),
  piExtensionSettings: Type.Object({
    definition: Type.String(),
    prevalidation: Type.String(),
  }),
});

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [output, schema, sourceSchema, theme, packageManifest] = await Promise.all([
  readFile(path.join(packageRoot, "dist", "src", "index.ts"), "utf8"),
  readFile(path.join(packageRoot, "dist", "config.schema.json"), "utf8"),
  readFile(path.join(packageRoot, "config.schema.json"), "utf8"),
  readFile(path.join(packageRoot, "themes", "darker-modern-theme.json"), "utf8"),
  readFile(path.join(packageRoot, "package.json"), "utf8").then((text) =>
    Value.Parse(packageManifestSchema, JSON.parse(text)),
  ),
]);

assert.equal(schema, sourceSchema);
for (const configuredPath of [
  packageManifest.piExtensionSettings.definition,
  packageManifest.piExtensionSettings.prevalidation,
  "./src/mutations/settings.ts",
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
console.log("glowup package check passed");
