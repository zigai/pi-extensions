import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";

const StringDictionarySchema = Type.Record(Type.String(), Type.String());
const ScriptInventorySchema = Type.Object({
  platformVerificationCheckTest: Type.String(),
  platformVerificationPackageScripts: Type.Array(Type.String()),
  platformVerificationSyntaxScripts: Type.Array(Type.String()),
});

const PlatformPackageSchema = Type.Object(
  {
    engines: Type.Optional(StringDictionarySchema),
    files: Type.Optional(Type.Array(Type.String())),
    scripts: Type.Optional(StringDictionarySchema),
  },
  { additionalProperties: true },
);

const PackDescriptionSchema = Type.Object({
  files: Type.Array(Type.Object({ path: Type.String() })),
});

const PackOutputSchema = Type.Union([
  Type.Array(PackDescriptionSchema),
  Type.Record(Type.String(), PackDescriptionSchema),
]);

function run(command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32" && command === "npm",
  });
}

function readScriptInventory() {
  const result = run(process.execPath, [
    "--input-type=module",
    "-e",
    String.raw`
import { platformVerificationCheckTest, platformVerificationPackageScripts, platformVerificationSyntaxScripts } from "./scripts/platform-verification/script-inventory.mjs";
console.log(JSON.stringify({ platformVerificationCheckTest, platformVerificationPackageScripts, platformVerificationSyntaxScripts }));
`,
  ]);
  assert.equal(result.status, 0, result.stderr);
  return Value.Parse(ScriptInventorySchema, JSON.parse(result.stdout));
}

test("platform verification scripts have working syntax and help", () => {
  const inventory = readScriptInventory();
  assert.equal(inventory.platformVerificationCheckTest, "test/platform-verification.check.ts");
  assert.ok(
    inventory.platformVerificationSyntaxScripts.includes(
      "scripts/platform-verification/platform-build.mjs",
    ),
  );
  assert.ok(
    inventory.platformVerificationSyntaxScripts.includes("scripts/platform-verification/check.mjs"),
  );

  for (const path of inventory.platformVerificationSyntaxScripts) {
    assert.equal(run(process.execPath, ["--check", path]).status, 0, path);
  }

  assert.ok(existsSync("scripts/platform-verification/platform-build-windows.ps1"));

  const powershellScript = readFileSync(
    "scripts/platform-verification/platform-build-windows.ps1",
    "utf8",
  );
  assert.match(powershellScript, /platform-build\.mjs/);
  assert.doesNotMatch(powershellScript, /npm run verify/);
  const goalRuntimeScript = readFileSync(
    "scripts/platform-verification/goal-runtime-verification.mjs",
    "utf8",
  );
  assert.match(goalRuntimeScript, /"install", "-l", installPath, "--approve"/);
  assert.match(goalRuntimeScript, /"list", "--approve"/);
  assert.match(goalRuntimeScript, /"--approve",\s*"--model"/);
  assert.match(goalRuntimeScript, /built-in read tool/);
  assert.match(goalRuntimeScript, /readToolObserved/);
  const help = run(process.execPath, ["scripts/platform-verification.mjs", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /windows-native/);
  assert.match(help.stdout, /PLATFORM_VERIFICATION_CRABBOX/);
  assert.match(help.stdout, /platform-build/);
  assert.match(help.stdout, /goal-runtime-verification/);
  assert.match(help.stdout, /zai\/glm-5\.2/);
  assert.match(help.stdout, /--skip-windows-disposable-probe/);
  const doctor = readFileSync("scripts/platform-verification/doctor.mjs", "utf8");
  assert.match(doctor, /disposableWindowsSshProbe/);
  assert.match(doctor, /skipWindowsDisposableProbe/);
  assert.match(doctor, /disposable Windows clone SSH\/tool probe OK/);
  const readme = readFileSync("README.md", "utf8");
  const platformDocs = readFileSync("docs/platform-verification.md", "utf8");
  assert.match(readme, /\[Platform verification testing\]\(docs\/platform-verification\.md\)/);
  assert.doesNotMatch(readme, /^## Interactive `?\/goal`? verification/m);
  assert.match(platformDocs, /^## Interactive `\/goal` verification/m);
  assert.match(platformDocs, /session JSONL contains the `\/goal` command path/);
  assert.match(platformDocs, /`update_goal` completion/);
});

test("platform verification config and package scripts require macOS, Ubuntu, and native Windows", () => {
  const packageJson = Value.Parse(
    PlatformPackageSchema,
    JSON.parse(readFileSync("package.json", "utf8")),
  );
  assert.equal(packageJson.engines?.node, ">=24.0.0");
  assert.ok(packageJson.files?.includes("scripts"));
  assert.ok(packageJson.files?.includes("platform-verification.config.mjs"));
  assert.ok(packageJson.files?.includes(".crabboxignore"));
  assert.equal(
    packageJson.scripts?.["check:platform-verification"],
    "node scripts/platform-verification/check.mjs",
  );
  assert.match(packageJson.scripts?.["check:code"] ?? "", /check:platform-verification/);
  assert.equal(packageJson.scripts?.verify, "npm run check");
  assert.equal(
    packageJson.scripts?.["verify:platform:doctor"],
    "node scripts/platform-verification.mjs doctor",
  );
  assert.match(
    packageJson.scripts?.["verify:platform:all"] ?? "",
    /doctor --skip-windows-disposable-probe/,
  );
  assert.match(packageJson.scripts?.["verify:platform:all"] ?? "", /macos,ubuntu,windows-native/);
  assert.match(packageJson.scripts?.["verify:platform:windows-native"] ?? "", /windows-native/);

  const code = String.raw`
import config from "./platform-verification.config.mjs";
const result = {
  targets: config.requiredTargets,
  suites: config.requiredSuites,
  packageName: config.packageName,
  crabboxMinVersion: config.requiredCrabbox.minVersion,
  ubuntuImage: config.ubuntuContainerImage,
  macosWorkRoot: config.macosStaticSsh.workRoot,
  windowsVm: config.windowsParallels.sourceVm,
  windowsSnapshot: config.windowsParallels.snapshot,
  windowsWorkRoot: config.windowsParallels.workRoot,
};
console.log(JSON.stringify(result));
if (result.packageName !== "pi-codex-goal") process.exit(1);
if (result.suites.join(",") !== "platform-build,goal-runtime-verification") process.exit(1);
if (result.targets.join(",") !== "macos,ubuntu,windows-native") process.exit(1);
if (result.crabboxMinVersion !== "0.26.0") process.exit(1);
if (result.ubuntuImage !== "cimg/node:24.16") process.exit(1);
if (result.macosWorkRoot !== "/Users/$USER/crabbox/pi-codex-goal") process.exit(1);
if (result.windowsVm !== "pi-extension-windows-template") process.exit(1);
if (result.windowsSnapshot !== "crabbox-ready") process.exit(1);
if (result.windowsWorkRoot !== "C:\\crabbox\\pi-codex-goal") process.exit(1);
`;
  const result = run(process.execPath, ["--input-type=module", "-e", code]);
  assert.equal(result.status, 0, result.stderr);
});

test("platform verification hygiene rejects local secret and package artifacts before sync", () => {
  const ignored = run("git", ["check-ignore", "--no-index", "--", ".env", ".env.private"]);
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.deepEqual(ignored.stdout.trim().split(/\r?\n/u), [".env", ".env.private"]);
  const crabboxignore = readFileSync(".crabboxignore", "utf8");
  assert.match(crabboxignore, /^\.env$/m);
  assert.match(crabboxignore, /^\.env\.\*$/m);

  const code = String.raw`
import { forbiddenArtifactMessage, isForbiddenLocalArtifactPath, isForbiddenProjectPath, localForbiddenProjectArtifacts } from "./scripts/platform-verification/hygiene.mjs";
const localArtifacts = localForbiddenProjectArtifacts();
const result = {
  env: isForbiddenProjectPath(".env") && isForbiddenLocalArtifactPath(".env"),
  envLocal: isForbiddenProjectPath("subdir/.env.local") && isForbiddenLocalArtifactPath("subdir/.env.local"),
  tarball: isForbiddenProjectPath("pi-codex-goal-0.1.26.tgz") && isForbiddenLocalArtifactPath("pi-codex-goal-0.1.26.tgz"),
  artifacts: isForbiddenProjectPath(".artifacts/platform-verification/out.txt") && !isForbiddenLocalArtifactPath(".artifacts/platform-verification/out.txt"),
  source: !isForbiddenProjectPath("src/index.ts"),
  message: forbiddenArtifactMessage(["./.env.local"]).includes("./.env.local"),
  localScan: localArtifacts.includes("./.env.platform-verification-test") && !localArtifacts.includes("./.artifacts"),
};
if (!Object.values(result).every(Boolean)) process.exit(1);
`;

  writeFileSync(".env.platform-verification-test", "test-only");

  try {
    const result = run(process.execPath, ["--input-type=module", "-e", code]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    unlinkSync(".env.platform-verification-test");
  }

  const cli = readFileSync("scripts/platform-verification.mjs", "utf8");
  assert.match(cli, /localForbiddenProjectArtifacts/);
  assert.match(cli, /Remove them before platform sync/);
});

test("platform-build command rendering uses POSIX and PowerShell without source-extension shortcuts", () => {
  const code = String.raw`
import { readFileSync } from "node:fs";
import { buildTargetBaseArgs } from "./scripts/platform-verification/crabbox-runner.mjs";
import { buildGoalRuntimeVerificationCommand, buildPlatformBuildCommand, platformFor } from "./scripts/platform-verification/targets.mjs";
const posix = buildPlatformBuildCommand("ubuntu", "pi-codex-goal", 24);
const macos = buildPlatformBuildCommand("macos", "pi-codex-goal", 24);
const powershell = buildPlatformBuildCommand("windows-native", "pi-codex-goal", 24);
const goalRuntime = buildGoalRuntimeVerificationCommand({ packageName: "pi-codex-goal", defaultModel: "zai/glm-5.2" }, "ubuntu");
const customConfig = {
  packageName: "custom-goal-package",
  ubuntuContainerImage: "node:24-test",
  macosStaticSsh: { host: "127.0.0.1", workRoot: "/Users/$USER/crabbox/custom-goal-package" },
  windowsParallels: { sourceVm: "custom-template", snapshot: "custom-snapshot", user: "windows-user", workRoot: "C:\\crabbox\\custom-goal-package" },
};
const macArgs = buildTargetBaseArgs("macos", customConfig);
const ubuntuArgs = buildTargetBaseArgs("ubuntu", customConfig);
const windowsArgs = buildTargetBaseArgs("windows-native", customConfig);
const result = {
  macosPlatform: platformFor("macos"),
  ubuntuPlatform: platformFor("ubuntu"),
  windowsPlatform: platformFor("windows-native"),
  posixUsesOrchestrator: posix.includes("node scripts/platform-verification/platform-build.mjs"),
  posixHasPackage: posix.includes("--package-name 'pi-codex-goal'"),
  posixHasNodeMajor: posix.includes("--node-validation-major 24"),
  posixNoExtensionShortcut: !/\\bpi\\s+(?:-e|--extension)\\s+\\./.test(posix),
  macosUsesSameOrchestrator: macos === posix,
  powershellUsesWrapper: powershell.includes("platform-build-windows.ps1"),
  powershellHasPackage: powershell.includes("pi-codex-goal"),
  powershellWrapperIsThin: readFileSync("scripts/platform-verification/platform-build-windows.ps1", "utf8").includes("platform-build.mjs") && !readFileSync("scripts/platform-verification/platform-build-windows.ps1", "utf8").includes("npm run verify"),
  powershellNoExtensionShortcut: !/\\bpi\\s+(?:-e|--extension)\\s+\\./.test(powershell),
  goalRuntimeHasDefaultModel: goalRuntime.includes("zai/glm-5.2"),
  goalRuntimeHasPackage: goalRuntime.includes("pi-codex-goal"),
  goalRuntimeChangesWorkspace: goalRuntime.startsWith("cd extensions/pi-goal && "),
  powershellChangesWorkspace: powershell.includes("Set-Location"),
  goalRuntimeAssertsReadTool: readFileSync("scripts/platform-verification/goal-runtime-verification.mjs", "utf8").includes("readToolObserved"),
  goalRuntimeTargetChecksReadTool: readFileSync("scripts/platform-verification/targets.mjs", "utf8").includes("read-tool-observed"),
  macArgsUseConfigHost: macArgs.includes("127.0.0.1"),
  macArgsUseConfigWorkRoot: macArgs.includes("/Users/" + process.env.USER + "/crabbox/custom-goal-package"),
  ubuntuArgsUseConfigImage: ubuntuArgs.includes("node:24-test"),
  windowsArgsUseConfigTemplate: windowsArgs.includes("custom-template"),
  windowsArgsUseConfigSnapshot: windowsArgs.includes("custom-snapshot"),
  windowsArgsUseConfigUser: windowsArgs.includes("windows-user"),
  windowsArgsUseConfigWorkRoot: windowsArgs.includes("C:\\crabbox\\custom-goal-package"),
};
console.log(JSON.stringify(result));
if (!Object.values(result).every(Boolean)) process.exit(1);
`;
  const result = run(process.execPath, ["--input-type=module", "-e", code]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("artifact manifests and lease cleanup failures are enforced", () => {
  const code = String.raw`
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSecretValues, redactSecrets, scanForSecrets, writeManifest } from "./scripts/platform-verification/artifacts.mjs";
import { createLeaseCleanupFailureResult, createLeaseCleanupResult, createWarmupFailureResult, runTargetSuites } from "./scripts/platform-verification/targets.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-codex-goal-platform-verification-test-"));
try {
  const suiteDir = join(root, "suite");
  mkdirSync(suiteDir, { recursive: true });
  writeFileSync(join(suiteDir, "present.txt"), "ok");
  const manifest = writeManifest(suiteDir, ["artifact-manifest.json", "present.txt", "missing.txt"]);
  const cleanup = createLeaseCleanupFailureResult({ artifactRoot: root, packageName: "pi-codex-goal" }, "ubuntu", "cbx_failed", {
    stdout: "",
    stderr: "stop failed",
    code: 1,
    signal: null,
  });
  const cleanupSuccess = createLeaseCleanupResult({ artifactRoot: root, packageName: "pi-codex-goal" }, "ubuntu", "cbx_ok", {
    stdout: "stopped",
    stderr: "",
    code: 0,
    signal: null,
  }, {
    stdout: "cleaned stale clones",
    stderr: "",
    code: 0,
    signal: null,
  });
  const warmupSecret = "warmup-secret-value-1234567890";
  process.env.ZAI_API_KEY = warmupSecret;
  const warmupFailure = createWarmupFailureResult({ artifactRoot: root, packageName: "pi-codex-goal" }, "ubuntu", "warmup-failure", {
    stdout: "",
    stderr: "warmup failed " + warmupSecret,
    code: 1,
    signal: null,
  });
  const assertions = JSON.parse(readFileSync(join(cleanup.suiteDir, "assertions.json"), "utf8"));
  const cleanupTarget = JSON.parse(readFileSync(join(cleanup.suiteDir, "target.json"), "utf8"));
  const successManifest = JSON.parse(readFileSync(join(cleanupSuccess.suiteDir, "artifact-manifest.json"), "utf8"));
  const warmupManifest = JSON.parse(readFileSync(join(warmupFailure.suiteDir, "artifact-manifest.json"), "utf8"));
  const warmupAssertionsText = readFileSync(join(warmupFailure.suiteDir, "assertions.json"), "utf8");
  const warmupFailuresText = readFileSync(join(warmupFailure.suiteDir, "failures.md"), "utf8");
  const warmupStderrText = readFileSync(join(warmupFailure.suiteDir, "crabbox.stderr.txt"), "utf8");
  const warmupAssertions = JSON.parse(warmupAssertionsText);
  const fakeCrabboxJs = join(root, "fake-crabbox.js");
  writeFileSync(fakeCrabboxJs, "process.stderr.write(" + JSON.stringify("warmup failed " + warmupSecret + "\n") + "); process.exit(1);\n");
  const fakeCrabboxBin = process.platform === "win32" ? join(root, "fake-crabbox.cmd") : join(root, "fake-crabbox");
  if (process.platform === "win32") {
    writeFileSync(fakeCrabboxBin, "@echo off\r\n\"" + process.execPath + "\" \"%~dp0fake-crabbox.js\" %*\r\n");
  } else {
    writeFileSync(fakeCrabboxBin, "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(fakeCrabboxJs) + " \"$@\"\n");
    chmodSync(fakeCrabboxBin, 0o755);
  }
  const originalCrabbox = process.env.PLATFORM_VERIFICATION_CRABBOX;
  process.env.PLATFORM_VERIFICATION_CRABBOX = fakeCrabboxBin;
  const multiWarmupFailure = await runTargetSuites({ artifactRoot: root, packageName: "pi-codex-goal", defaultAuthEnv: ["ZAI_API_KEY"], ubuntuContainerImage: "fake-node-24" }, "ubuntu", ["platform-build", "goal-runtime-verification"]);
  if (originalCrabbox === undefined) delete process.env.PLATFORM_VERIFICATION_CRABBOX;
  else process.env.PLATFORM_VERIFICATION_CRABBOX = originalCrabbox;
  const multiWarmup = multiWarmupFailure.results[0];
  const multiWarmupAssertionsText = readFileSync(join(multiWarmup.suiteDir, "assertions.json"), "utf8");
  const multiWarmupFailuresText = readFileSync(join(multiWarmup.suiteDir, "failures.md"), "utf8");
  const multiWarmupStderrText = readFileSync(join(multiWarmup.suiteDir, "crabbox.stderr.txt"), "utf8");
  const env = { ZAI_API_KEY: "zai-secret-value-1234567890" };
  const secrets = collectSecretValues(["ZAI_API_KEY"], env);
  const redacted = redactSecrets("token=" + env.ZAI_API_KEY, secrets);
  const result = {
    manifestIncludesSelf: manifest.present.includes("artifact-manifest.json"),
    missingRecorded: manifest.missing.includes("missing.txt"),
    cleanupOk: cleanup.ok,
    cleanupSuccessOk: cleanupSuccess.ok,
    cleanupSuccessRecorded: successManifest.present.includes("crabbox.stop.stdout.txt") && successManifest.present.includes("crabbox.cleanup.stdout.txt"),
    warmupOk: warmupFailure.ok,
    warmupFailureRecorded: warmupManifest.present.includes("crabbox.stderr.txt") && warmupManifest.present.includes("crabbox.timing.json"),
    warmupAssertionFailed: warmupAssertions.checks.some((check) => check.id === "crabbox-warmup" && check.ok === false),
    warmupSecretRedacted: !warmupStderrText.includes(warmupSecret) && warmupStderrText.includes("[REDACTED_SECRET]") && !warmupAssertionsText.includes(warmupSecret) && !warmupFailuresText.includes(warmupSecret),
    multiWarmupFailure: multiWarmupFailure.ok === false && multiWarmup.suiteDir.includes("warmup-failure"),
    multiWarmupSecretRedacted: !multiWarmupStderrText.includes(warmupSecret) && !multiWarmupAssertionsText.includes(warmupSecret) && !multiWarmupFailuresText.includes(warmupSecret),
    assertionsOk: assertions.ok,
    leaseCleanupFailed: assertions.checks.some((check) => check.id === "lease-cleanup" && check.ok === false),
    targetRecordsProvider: cleanupTarget.provider === "local-container" && cleanupTarget.crabboxTarget === "linux",
    secretDetected: scanForSecrets("token=" + env.ZAI_API_KEY, secrets).includes("raw forwarded secret value"),
    secretRedacted: !redacted.includes(env.ZAI_API_KEY) && redacted.includes("[REDACTED_SECRET]"),
  };
  console.log(JSON.stringify(result));
  if (!result.manifestIncludesSelf || !result.missingRecorded || result.cleanupOk || !result.cleanupSuccessOk || !result.cleanupSuccessRecorded || result.warmupOk || !result.warmupFailureRecorded || !result.warmupAssertionFailed || !result.warmupSecretRedacted || !result.multiWarmupFailure || !result.multiWarmupSecretRedacted || result.assertionsOk || !result.leaseCleanupFailed || !result.targetRecordsProvider || !result.secretDetected || !result.secretRedacted) process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
`;
  const result = run(process.execPath, ["--input-type=module", "-e", code]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("npm pack includes platform verification docs and scripts", () => {
  const result = run("npm", ["pack", "--dry-run", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = Value.Parse(PackOutputSchema, JSON.parse(result.stdout));
  const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const paths = new Set(pack?.files.map((file) => file.path) ?? []);
  for (const path of [
    "docs/platform-verification.md",
    ".crabboxignore",
    "platform-verification.config.mjs",
    ...readScriptInventory().platformVerificationPackageScripts,
  ]) {
    assert.ok(paths.has(path), `expected npm pack to include ${path}`);
  }

  assert.equal(
    [...paths].some((path) => path.startsWith("node_modules/")),
    false,
  );

  for (const forbidden of [".artifacts/", ".crabbox/", ".debug/", ".env", ".env."]) {
    assert.equal(
      [...paths].some((path) => path === forbidden || path.startsWith(forbidden)),
      false,
    );
  }

  assert.equal(
    [...paths].some((path) => path.endsWith(".tgz")),
    false,
  );
  assert.equal(
    [...paths].some((path) => path.startsWith("../") || path.includes("/../")),
    false,
  );
});
