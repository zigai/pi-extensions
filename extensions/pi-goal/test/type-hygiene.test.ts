import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

function tsFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...tsFiles(path));
      continue;
    }
    if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

const bannedEscapeHatchPatterns = [
  { label: "double assertion through unknown", pattern: new RegExp("as\\s+unknown\\s+as") },
  { label: "any assertion", pattern: new RegExp("as\\s+any\\b") },
  { label: "never assertion", pattern: new RegExp("as\\s+never\\b") },
  { label: "explicit any annotation", pattern: new RegExp(":\\s*any\\b") },
  { label: "ts ignore directive", pattern: new RegExp("@ts-" + "ignore") },
  { label: "unchecked ts expect error directive", pattern: new RegExp("@ts-" + "expect-error") },
  { label: "lint suppression", pattern: new RegExp("eslint-" + "disable") },
];

test("source and tests avoid banned TypeScript escape hatches", () => {
  const violations: string[] = [];
  for (const file of [...tsFiles("src"), ...tsFiles("test")]) {
    const text = readFileSync(file, "utf8");
    for (const { label, pattern } of bannedEscapeHatchPatterns) {
      if (pattern.test(text)) violations.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(violations, []);
});
