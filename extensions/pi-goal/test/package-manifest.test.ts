import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";

const StringDictionarySchema = Type.Record(Type.String(), Type.String());
const PackageManifestSchema = Type.Object(
  {
    bundledDependencies: Type.Optional(Type.Array(Type.String())),
    bundleDependencies: Type.Optional(Type.Array(Type.String())),
    dependencies: Type.Optional(StringDictionarySchema),
    devDependencies: Type.Optional(StringDictionarySchema),
    files: Type.Optional(Type.Array(Type.String())),
    pi: Type.Optional(
      Type.Object({
        extensions: Type.Optional(Type.Array(Type.String())),
        prompts: Type.Optional(Type.Array(Type.String())),
      }),
    ),
    scripts: Type.Optional(StringDictionarySchema),
  },
  { additionalProperties: true },
);

test("package keeps the bundled creation template without exposing /create-goal", () => {
  const packageJson = Value.Parse(
    PackageManifestSchema,
    JSON.parse(readFileSync("package.json", "utf8")),
  );

  assert.ok(packageJson.files?.includes("prompts"));
  assert.deepEqual(packageJson.pi?.extensions, ["./src/index.ts"]);
  assert.equal(packageJson.pi?.prompts, undefined);
  assert.equal(packageJson.dependencies?.["pi-typed-args"], "0.1.1");
  assert.equal(packageJson.dependencies?.["@zigai/pi-glowup"], "1.0.0");
  assert.equal(packageJson.bundledDependencies, undefined);
  assert.equal(packageJson.bundleDependencies, undefined);
  assert.equal(packageJson.scripts?.test, "vitest run");
  assert.equal(packageJson.devDependencies?.tsx, undefined);
  assert.match(packageJson.devDependencies?.vitest ?? "", /^\^4\./);
});

test("bundled creation prompt is a dynamic settings template", () => {
  const prompt = readFileSync("prompts/create-goal.md", "utf8");
  assert.doesNotMatch(prompt, /^---/);
  assert.match(prompt, /{{task}}/);
  assert.match(prompt, /{{constraints}}/);
  assert.match(prompt, /{{currentGoal}}/);
  assert.match(prompt, /replace_existing: true/);
  assert.match(prompt, /3\. Constraints and boundaries/);
  assert.match(prompt, /5\. Completion audit/);
  assert.match(prompt, /status `blocked`/);
  assert.doesNotMatch(prompt, /token budget/i);
});
