/** Single source of truth for cheap platform-verification script checks. */

export const platformVerificationSyntaxScripts = [
  "scripts/platform-verification.mjs",
  "scripts/platform-verification/artifacts.mjs",
  "scripts/platform-verification/check.mjs",
  "scripts/platform-verification/crabbox-runner.mjs",
  "scripts/platform-verification/doctor.mjs",
  "scripts/platform-verification/goal-runtime-verification.mjs",
  "scripts/platform-verification/hygiene.mjs",
  "scripts/platform-verification/platform-build.mjs",
  "scripts/platform-verification/script-inventory.mjs",
  "scripts/platform-verification/targets.mjs",
];

export const platformVerificationPackageScripts = [
  ...platformVerificationSyntaxScripts,
  "scripts/platform-verification/platform-build-windows.ps1",
];

export const platformVerificationCheckTest = "test/platform-verification.check.ts";
