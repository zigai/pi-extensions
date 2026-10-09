#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { platformVerificationCheckTest, platformVerificationSyntaxScripts } from "./script-inventory.mjs";

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "inherit",
    shell: process.platform === "win32" && /(?:^|\\|\/)npm(?:\.cmd)?$/i.test(command),
  });
  return result.status ?? 1;
}

for (const script of platformVerificationSyntaxScripts) {
  const status = run(process.execPath, ["--check", script]);
  if (status !== 0) process.exit(status);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
process.exit(
  run(npmCommand, [
    "exec",
    "--",
    "vitest",
    "run",
    "--config",
    "scripts/platform-verification/vitest.config.mjs",
    platformVerificationCheckTest,
  ]),
);
