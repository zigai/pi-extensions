import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("package keeps the bundled creation template without exposing /create-goal", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    bundledDependencies?: string[];
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    files?: string[];
    pi?: { extensions?: string[]; prompts?: string[] };
    scripts?: Record<string, string>;
  };

  assert.ok(packageJson.files?.includes("prompts"));
  assert.deepEqual(packageJson.pi?.extensions, ["./src/index.ts"]);
  assert.equal(packageJson.pi?.prompts, undefined);
  assert.equal(packageJson.dependencies?.["pi-typed-args"], "file:../pi-typed-commands");
  assert.deepEqual(packageJson.bundledDependencies, ["pi-typed-args"]);
  assert.equal(packageJson.scripts?.test, "vitest run");
  assert.equal(packageJson.devDependencies?.tsx, undefined);
  assert.match(packageJson.devDependencies?.vitest ?? "", /^\^4\./);
  assert.match(readFileSync(".npmrc", "utf8"), /^install-links=true\s*$/);
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
