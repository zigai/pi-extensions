/** Single source of truth for cheap platform-smoke script checks. */

export const platformSmokeSyntaxScripts = [
  "scripts/platform-smoke.mjs",
  "scripts/platform-smoke/artifacts.mjs",
  "scripts/platform-smoke/check.mjs",
  "scripts/platform-smoke/crabbox-runner.mjs",
  "scripts/platform-smoke/doctor.mjs",
  "scripts/platform-smoke/goal-runtime-smoke.mjs",
  "scripts/platform-smoke/hygiene.mjs",
  "scripts/platform-smoke/platform-build.mjs",
  "scripts/platform-smoke/script-inventory.mjs",
  "scripts/platform-smoke/targets.mjs",
];

export const platformSmokePackageScripts = [
  ...platformSmokeSyntaxScripts,
  "scripts/platform-smoke/platform-build-windows.ps1",
];

export const platformSmokeCheckTest = "test/platform-smoke.check.ts";
