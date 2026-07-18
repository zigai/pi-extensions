/** Target/suite runner for pi-codex-goal platform smoke. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  collectSecretValues,
  createSuiteDir,
  redactSecrets,
  scanArtifactTextFiles,
  scanForSecrets,
  writeCommand,
  writeExitCode,
  writeManifest,
  writeSummary,
} from "./artifacts.mjs";
import {
  buildTargetBaseArgs,
  cleanupStaleTargetState,
  runOnLease,
  stopLease,
  warmupLease,
} from "./crabbox-runner.mjs";

export function platformFor(targetName) {
  return targetName === "windows-native" ? "powershell" : "posix";
}

function makeRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function smokeModel(config) {
  return process.env.PLATFORM_SMOKE_MODEL || config.defaultModel || "zai/glm-5.2";
}

function authEnvAllowList(config) {
  const raw = process.env.PLATFORM_SMOKE_AUTH_ENV;
  const names = raw ? raw.split(",") : (config.defaultAuthEnv ?? ["ZAI_API_KEY", "Z_AI_API_KEY"]);
  return names.map((name) => String(name).trim()).filter(Boolean);
}

function sectionBase64(text, name) {
  const raw = section(text, name).trim();
  if (!raw) return "";
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function writeRedacted(path, text, secretValues) {
  writeFileSync(path, redactSecrets(text ?? "", secretValues));
}

function jsonBlock(text, start, end) {
  const startIndex = text.indexOf(start);
  if (startIndex === -1) return "";
  const contentStart = startIndex + start.length;
  const endIndex = text.indexOf(end, contentStart);
  return (endIndex === -1 ? text.slice(contentStart) : text.slice(contentStart, endIndex)).trim();
}

function section(text, name) {
  const start = `--- ${name} START ---`;
  const end = `--- ${name} END ---`;
  const startIndex = text.indexOf(start);
  if (startIndex === -1) return "";
  const contentStart = startIndex + start.length;
  const endIndex = text.indexOf(end, contentStart);
  return (endIndex === -1 ? text.slice(contentStart) : text.slice(contentStart, endIndex))
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");
}

function marker(text, name) {
  return text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() ?? "";
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : (args[index + 1] ?? null);
}

function targetMetadata(config, targetName, runId, slug) {
  const baseArgs = buildTargetBaseArgs(targetName, config);
  return {
    targetName,
    platform: platformFor(targetName),
    runId,
    slug,
    provider: argValue(baseArgs, "--provider"),
    crabboxTarget: argValue(baseArgs, "--target"),
    workRoot:
      argValue(baseArgs, "--static-work-root") ??
      argValue(baseArgs, "--parallels-work-root") ??
      null,
    windowsMode: argValue(baseArgs, "--windows-mode"),
    ubuntuImage: argValue(baseArgs, "--local-container-image"),
    windowsSourceVm: argValue(baseArgs, "--parallels-source"),
    windowsSourceSnapshot: argValue(baseArgs, "--parallels-source-snapshot"),
  };
}

function writeExtracts(suiteDir, stdout, secretValues = []) {
  writeFileSync(
    resolve(suiteDir, "node-version.txt"),
    `${marker(stdout, "PLATFORM_NODE_VERSION")}\n`,
  );
  writeRedacted(
    resolve(suiteDir, "packed-tarball.txt"),
    `${marker(stdout, "PLATFORM_PACKED_TARBALL")}\n`,
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "packed-node-install.stdout.txt"),
    section(stdout, "PACKED_NODE_INSTALL_STDOUT"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "packed-node-install.stderr.txt"),
    section(stdout, "PACKED_NODE_INSTALL_STDERR"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "pi-install.stdout.txt"),
    section(stdout, "PI_INSTALL_STDOUT"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "pi-install.stderr.txt"),
    section(stdout, "PI_INSTALL_STDERR"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "pi-list.stdout.txt"),
    section(stdout, "PI_LIST_STDOUT"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "pi-list.stderr.txt"),
    section(stdout, "PI_LIST_STDERR"),
    secretValues,
  );
}

function assertionsFromChecks(checks) {
  const evaluated = checks.map((check) => {
    let ok = false;
    let error = check.error;
    try {
      ok = check.fn() === true;
    } catch (err) {
      error = err.message;
    }
    return { id: check.id, ok, ...(ok ? {} : { error: error ?? `${check.id} failed` }) };
  });
  return {
    ok: evaluated.every((check) => check.ok),
    checks: evaluated,
    writtenAt: new Date().toISOString(),
  };
}

function writeAssertions(suiteDir, checks) {
  const assertions = assertionsFromChecks(checks);
  writeFileSync(resolve(suiteDir, "assertions.json"), JSON.stringify(assertions, null, 2));
  if (!assertions.ok) {
    writeFileSync(
      resolve(suiteDir, "failures.md"),
      [
        `# Platform smoke failures`,
        "",
        ...assertions.checks
          .filter((check) => !check.ok)
          .map((check) => `- ${check.id}: ${check.error ?? "failed"}`),
        "",
        "Inspect command.txt, crabbox.stdout.txt, and crabbox.stderr.txt in this suite directory.",
        "",
      ].join("\n"),
    );
  }
  return assertions;
}

function finalizeSuite(suiteDir, checks, summary, expectedFiles) {
  const assertions = writeAssertions(suiteDir, checks);
  writeSummary(suiteDir, { ...summary, ok: assertions.ok });
  const expected = assertions.ok ? expectedFiles : [...expectedFiles, "failures.md"];
  const manifest = writeManifest(suiteDir, expected);
  if (manifest.missing.length === 0) return { assertions, manifest };
  const finalAssertions = writeAssertions(suiteDir, [
    ...checks,
    {
      id: "artifact-manifest-complete",
      fn: () => false,
      error: `missing required artifact(s): ${manifest.missing.join(", ")}`,
    },
  ]);
  writeSummary(suiteDir, { ...summary, ok: false });
  return {
    assertions: finalAssertions,
    manifest: writeManifest(suiteDir, [...expectedFiles, "failures.md"]),
  };
}

export function createWarmupFailureResult(
  config,
  targetName,
  suiteName,
  lease,
  startedAt = Date.now(),
  existing = {},
) {
  const runId = existing.runId ?? makeRunId();
  const slug = `${config.packageName}-${targetName}`;
  const suiteDir =
    existing.suiteDir ?? createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
  const secretValues = collectSecretValues(authEnvAllowList(config));
  const command =
    existing.command ??
    `crabbox warmup ${buildTargetBaseArgs(targetName, config).join(" ")} --slug ${slug} --keep`;
  const elapsedMs = Date.now() - startedAt;
  writeFileSync(
    resolve(suiteDir, "target.json"),
    JSON.stringify(targetMetadata(config, targetName, runId, slug), null, 2),
  );
  writeFileSync(
    resolve(suiteDir, "suite.json"),
    JSON.stringify({ suiteName, phase: "warmup", modelCalls: 0 }, null, 2),
  );
  writeCommand(suiteDir, command);
  writeExitCode(suiteDir, lease.code, lease.signal);
  writeRedacted(resolve(suiteDir, "crabbox.stdout.txt"), lease.stdout ?? "", secretValues);
  writeRedacted(resolve(suiteDir, "crabbox.stderr.txt"), lease.stderr ?? "", secretValues);
  writeFileSync(
    resolve(suiteDir, "crabbox.timing.json"),
    JSON.stringify({ elapsedMs, code: lease.code, signal: lease.signal }, null, 2),
  );
  const secretViolations = [
    ...scanForSecrets(`${lease.stdout ?? ""}\n${lease.stderr ?? ""}`, secretValues),
    ...scanArtifactTextFiles(suiteDir, secretValues).map(
      (finding) => `${finding.file}: ${finding.violation}`,
    ),
  ];
  const { assertions } = finalizeSuite(
    suiteDir,
    [
      {
        id: "crabbox-warmup",
        fn: () => false,
        error: "Crabbox warmup failed; inspect redacted crabbox stdout/stderr artifacts",
      },
      {
        id: "no-secret-artifacts",
        fn: () => secretViolations.length === 0,
        error: secretViolations.join(", "),
      },
    ],
    { target: targetName, suite: suiteName, elapsedMs, exitCode: lease.code, signal: lease.signal },
    [
      "summary.json",
      "artifact-manifest.json",
      "target.json",
      "suite.json",
      "command.txt",
      "exit-code.txt",
      "crabbox.stdout.txt",
      "crabbox.stderr.txt",
      "crabbox.timing.json",
      "assertions.json",
    ],
  );
  return { ok: false, suiteDir, assertions };
}

export function createLeaseCleanupResult(
  config,
  targetName,
  leaseId,
  stopResult,
  staleCleanupResult = null,
) {
  const suiteName = "lease-cleanup";
  const runId = makeRunId();
  const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
  const secretValues = collectSecretValues(authEnvAllowList(config));
  writeFileSync(
    resolve(suiteDir, "target.json"),
    JSON.stringify(
      targetMetadata(config, targetName, runId, `${config.packageName}-${targetName}`),
      null,
      2,
    ),
  );
  writeFileSync(
    resolve(suiteDir, "suite.json"),
    JSON.stringify({ suiteName, leaseId, modelCalls: 0 }, null, 2),
  );
  writeCommand(suiteDir, `crabbox stop ${targetName} --id ${leaseId}`);
  writeExitCode(suiteDir, stopResult.code, stopResult.signal);
  writeRedacted(
    resolve(suiteDir, "crabbox.stop.stdout.txt"),
    stopResult.stdout ?? "",
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "crabbox.stop.stderr.txt"),
    stopResult.stderr ?? "",
    secretValues,
  );
  writeFileSync(
    resolve(suiteDir, "crabbox.stop.exit-code.txt"),
    `code=${stopResult.code}\nsignal=${stopResult.signal ?? "none"}\n`,
  );
  if (staleCleanupResult) {
    writeRedacted(
      resolve(suiteDir, "crabbox.cleanup.stdout.txt"),
      staleCleanupResult.stdout ?? "",
      secretValues,
    );
    writeRedacted(
      resolve(suiteDir, "crabbox.cleanup.stderr.txt"),
      staleCleanupResult.stderr ?? "",
      secretValues,
    );
    writeFileSync(
      resolve(suiteDir, "crabbox.cleanup.exit-code.txt"),
      `code=${staleCleanupResult.code}\nsignal=${staleCleanupResult.signal ?? "none"}\n`,
    );
  }
  const secretViolations = [
    ...scanForSecrets(`${stopResult.stdout ?? ""}\n${stopResult.stderr ?? ""}`, secretValues),
    ...scanArtifactTextFiles(suiteDir, secretValues).map(
      (finding) => `${finding.file}: ${finding.violation}`,
    ),
  ];
  const { assertions } = finalizeSuite(
    suiteDir,
    [
      {
        id: "lease-cleanup",
        fn: () => stopResult.code === 0,
        error: `Crabbox stop failed with exit ${stopResult.code}`,
      },
      {
        id: "stale-cleanup",
        fn: () => !staleCleanupResult || staleCleanupResult.code === 0,
        error: `Crabbox cleanup failed with exit ${staleCleanupResult?.code}`,
      },
      {
        id: "no-secret-artifacts",
        fn: () => secretViolations.length === 0,
        error: secretViolations.join(", "),
      },
    ],
    {
      target: targetName,
      suite: suiteName,
      exitCode: stopResult.code,
      signal: stopResult.signal,
      elapsedMs: 0,
    },
    [
      "summary.json",
      "artifact-manifest.json",
      "target.json",
      "suite.json",
      "command.txt",
      "exit-code.txt",
      "crabbox.stop.stdout.txt",
      "crabbox.stop.stderr.txt",
      "crabbox.stop.exit-code.txt",
      ...(staleCleanupResult
        ? [
            "crabbox.cleanup.stdout.txt",
            "crabbox.cleanup.stderr.txt",
            "crabbox.cleanup.exit-code.txt",
          ]
        : []),
      "assertions.json",
    ],
  );
  return { ok: assertions.ok, suiteDir, assertions };
}

export function createLeaseCleanupFailureResult(config, targetName, leaseId, stopResult) {
  return createLeaseCleanupResult(config, targetName, leaseId, stopResult);
}

export function buildGoalRuntimeSmokeCommand(config, targetName) {
  const model = smokeModel(config);
  const packageName = config.packageName ?? "pi-codex-goal";
  if (platformFor(targetName) === "powershell") {
    return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "node .\\scripts\\platform-smoke\\goal-runtime-smoke.mjs --model ${model.replace(/"/g, '`"')} --package-name ${packageName.replace(/"/g, '`"')}"`;
  }
  return `node scripts/platform-smoke/goal-runtime-smoke.mjs --model ${shellQuote(model)} --package-name ${shellQuote(packageName)}`;
}

export function buildPlatformBuildCommand(
  targetName,
  packageName = "pi-codex-goal",
  nodeValidationMajor = 24,
) {
  if (platformFor(targetName) === "powershell") {
    return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\platform-smoke\\platform-build-windows.ps1 -PackageName ${psSingleQuote(packageName)} -NodeValidationMajor ${nodeValidationMajor}`;
  }
  return `node scripts/platform-smoke/platform-build.mjs --package-name ${shellQuote(packageName)} --node-validation-major ${nodeValidationMajor}`;
}

async function runGoalRuntimeSmokeSuite(config, targetName, suiteName, leaseSession) {
  const runId = makeRunId();
  const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
  const startedAt = Date.now();
  const slug = `${config.packageName}-${targetName}`;
  const command = buildGoalRuntimeSmokeCommand(config, targetName);
  writeFileSync(
    resolve(suiteDir, "target.json"),
    JSON.stringify(targetMetadata(config, targetName, runId, slug), null, 2),
  );
  writeFileSync(
    resolve(suiteDir, "suite.json"),
    JSON.stringify({ suiteName, modelCalls: 1, model: smokeModel(config) }, null, 2),
  );
  writeCommand(suiteDir, command);

  let lease = leaseSession;
  const ownsLease = !lease;
  if (!lease) lease = await warmupLease(targetName, slug, config);
  if (!lease.ok) {
    return createWarmupFailureResult(config, targetName, suiteName, lease, startedAt, {
      runId,
      suiteDir,
      command,
    });
  }

  const allowEnv = authEnvAllowList(config);
  const secretValues = collectSecretValues(allowEnv);
  const result = await runOnLease(targetName, lease.leaseId, command, {
    config,
    timeout: 600_000,
    sync: leaseSession?.sync,
    allowEnv,
  });
  const elapsedMs = Date.now() - startedAt;
  writeRedacted(resolve(suiteDir, "crabbox.stdout.txt"), result.stdout, secretValues);
  writeRedacted(resolve(suiteDir, "crabbox.stderr.txt"), result.stderr, secretValues);
  writeFileSync(
    resolve(suiteDir, "crabbox.timing.json"),
    JSON.stringify({ elapsedMs, code: result.code, signal: result.signal }, null, 2),
  );
  writeExitCode(suiteDir, result.code, result.signal);

  let stopResult;
  if (ownsLease) {
    stopResult = await stopLease(targetName, lease.leaseId, config);
    writeRedacted(resolve(suiteDir, "crabbox.stop.stdout.txt"), stopResult.stdout, secretValues);
    writeRedacted(resolve(suiteDir, "crabbox.stop.stderr.txt"), stopResult.stderr, secretValues);
    writeFileSync(
      resolve(suiteDir, "crabbox.stop.exit-code.txt"),
      `code=${stopResult.code}\nsignal=${stopResult.signal ?? "none"}\n`,
    );
  }

  const resultJsonText = jsonBlock(
    result.stdout,
    "PLATFORM_GOAL_RUNTIME_JSON_START",
    "PLATFORM_GOAL_RUNTIME_JSON_END",
  );
  let runtimeResult = {};
  try {
    runtimeResult = JSON.parse(resultJsonText);
  } catch {}
  writeRedacted(
    resolve(suiteDir, "goal-runtime-result.json"),
    resultJsonText ? `${resultJsonText}\n` : "{}\n",
    secretValues,
  );
  writeFileSync(resolve(suiteDir, "packed-tarball.txt"), `${runtimeResult.packedTarball ?? ""}\n`);
  writeRedacted(
    resolve(suiteDir, "npm-pack.stdout.txt"),
    section(result.stdout, "NPM_PACK_STDOUT"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "npm-pack.stderr.txt"),
    section(result.stdout, "NPM_PACK_STDERR"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "packed-node-install.stdout.txt"),
    section(result.stdout, "PACKED_NODE_INSTALL_STDOUT"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "packed-node-install.stderr.txt"),
    section(result.stdout, "PACKED_NODE_INSTALL_STDERR"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "pi-install.stdout.txt"),
    section(result.stdout, "PI_INSTALL_STDOUT"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "pi-install.stderr.txt"),
    section(result.stdout, "PI_INSTALL_STDERR"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "pi-list.stdout.txt"),
    section(result.stdout, "PI_LIST_STDOUT"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "pi-list.stderr.txt"),
    section(result.stdout, "PI_LIST_STDERR"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "pi-run.stdout.txt"),
    section(result.stdout, "PI_RUN_STDOUT"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "pi-run.stderr.txt"),
    section(result.stdout, "PI_RUN_STDERR"),
    secretValues,
  );
  writeRedacted(
    resolve(suiteDir, "session.jsonl"),
    sectionBase64(result.stdout, "SESSION_JSONL_B64"),
    secretValues,
  );

  const secretViolations = [
    ...scanForSecrets(`${result.stdout}\n${result.stderr}`, secretValues),
    ...scanArtifactTextFiles(suiteDir, secretValues).map(
      (finding) => `${finding.file}: ${finding.violation}`,
    ),
  ];
  const checks = [
    { id: "command-exit-zero", fn: () => result.code === 0, error: `exit ${result.code}` },
    {
      id: "runtime-marker",
      fn: () =>
        result.stdout.includes("PLATFORM_GOAL_RUNTIME_OK=1") &&
        result.stdout.includes("GOAL_RUNTIME_SMOKE_OK"),
    },
    { id: "runtime-result-ok", fn: () => runtimeResult.ok === true },
    { id: "model-configured", fn: () => runtimeResult.model === smokeModel(config) },
    { id: "pi-run-exit-zero", fn: () => runtimeResult.checks?.piRun === true },
    { id: "final-marker", fn: () => runtimeResult.checks?.finalMarkerObserved === true },
    { id: "file-verified", fn: () => runtimeResult.checks?.fileVerified === true },
    {
      id: "goal-custom-entry-observed",
      fn: () => runtimeResult.checks?.customGoalObserved === true,
    },
    { id: "goal-complete-observed", fn: () => runtimeResult.checks?.completeGoalObserved === true },
    { id: "read-tool-observed", fn: () => runtimeResult.checks?.readToolObserved === true },
    { id: "pi-list-local-package", fn: () => runtimeResult.checks?.piList === true },
    {
      id: "session-jsonl",
      fn: () => readFileSync(resolve(suiteDir, "session.jsonl"), "utf8").includes("pi-codex-goal"),
    },
    {
      id: "no-secret-artifacts",
      fn: () => secretViolations.length === 0,
      error: secretViolations.join(", "),
    },
  ];
  if (stopResult)
    checks.push({
      id: "lease-cleanup",
      fn: () => stopResult.code === 0,
      error: `stop exit ${stopResult.code}`,
    });
  const expectedFiles = [
    "summary.json",
    "artifact-manifest.json",
    "target.json",
    "suite.json",
    "command.txt",
    "exit-code.txt",
    "crabbox.stdout.txt",
    "crabbox.stderr.txt",
    "crabbox.timing.json",
    "goal-runtime-result.json",
    "packed-tarball.txt",
    "npm-pack.stdout.txt",
    "npm-pack.stderr.txt",
    "packed-node-install.stdout.txt",
    "packed-node-install.stderr.txt",
    "pi-install.stdout.txt",
    "pi-install.stderr.txt",
    "pi-list.stdout.txt",
    "pi-list.stderr.txt",
    "pi-run.stdout.txt",
    "pi-run.stderr.txt",
    "session.jsonl",
    "assertions.json",
  ];
  if (stopResult)
    expectedFiles.push(
      "crabbox.stop.stdout.txt",
      "crabbox.stop.stderr.txt",
      "crabbox.stop.exit-code.txt",
    );
  const { assertions } = finalizeSuite(
    suiteDir,
    checks,
    {
      target: targetName,
      suite: suiteName,
      elapsedMs,
      exitCode: result.code,
      signal: result.signal,
      model: smokeModel(config),
    },
    expectedFiles,
  );
  return { ok: assertions.ok, suiteDir, assertions };
}

export async function runTargetSuite(config, targetName, suiteName, leaseSession) {
  if (suiteName === "goal-runtime-smoke")
    return await runGoalRuntimeSmokeSuite(config, targetName, suiteName, leaseSession);
  if (suiteName !== "platform-build") throw new Error(`unknown suite: ${suiteName}`);
  const runId = makeRunId();
  const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
  const startedAt = Date.now();
  const slug = `${config.packageName}-${targetName}`;
  const command = buildPlatformBuildCommand(
    targetName,
    config.packageName,
    config.nodeValidationMajor,
  );
  mkdirSync(dirname(suiteDir), { recursive: true });
  writeFileSync(
    resolve(suiteDir, "target.json"),
    JSON.stringify(targetMetadata(config, targetName, runId, slug), null, 2),
  );
  writeFileSync(
    resolve(suiteDir, "suite.json"),
    JSON.stringify({ suiteName, modelCalls: 0 }, null, 2),
  );
  writeCommand(suiteDir, command);

  let lease = leaseSession;
  const ownsLease = !lease;
  if (!lease) lease = await warmupLease(targetName, slug, config);
  if (!lease.ok) {
    return createWarmupFailureResult(config, targetName, suiteName, lease, startedAt, {
      runId,
      suiteDir,
      command,
    });
  }

  const secretValues = collectSecretValues(authEnvAllowList(config));
  const result = await runOnLease(targetName, lease.leaseId, command, {
    config,
    timeout: 900_000,
    sync: leaseSession?.sync,
  });
  const elapsedMs = Date.now() - startedAt;
  writeRedacted(resolve(suiteDir, "crabbox.stdout.txt"), result.stdout, secretValues);
  writeRedacted(resolve(suiteDir, "crabbox.stderr.txt"), result.stderr, secretValues);
  writeFileSync(
    resolve(suiteDir, "crabbox.timing.json"),
    JSON.stringify({ elapsedMs, code: result.code, signal: result.signal }, null, 2),
  );
  writeExitCode(suiteDir, result.code, result.signal);
  writeExtracts(suiteDir, result.stdout, secretValues);
  let stopResult;
  if (ownsLease) {
    stopResult = await stopLease(targetName, lease.leaseId, config);
    writeRedacted(resolve(suiteDir, "crabbox.stop.stdout.txt"), stopResult.stdout, secretValues);
    writeRedacted(resolve(suiteDir, "crabbox.stop.stderr.txt"), stopResult.stderr, secretValues);
    writeFileSync(
      resolve(suiteDir, "crabbox.stop.exit-code.txt"),
      `code=${stopResult.code}\nsignal=${stopResult.signal ?? "none"}\n`,
    );
  }

  const stdout = result.stdout;
  const listOutput = section(stdout, "PI_LIST_STDOUT");
  const nodeMajor = Number(
    marker(stdout, "PLATFORM_NODE_VERSION").replace(/^v/, "").split(".")[0] ?? 0,
  );
  const secretViolations = [
    ...scanForSecrets(`${result.stdout}\n${result.stderr}`, secretValues),
    ...scanArtifactTextFiles(suiteDir, secretValues).map(
      (finding) => `${finding.file}: ${finding.violation}`,
    ),
  ];
  const checks = [
    { id: "command-exit-zero", fn: () => result.code === 0, error: `exit ${result.code}` },
    { id: "platform-marker", fn: () => stdout.includes("PLATFORM_BUILD_OK") },
    {
      id: "node-version",
      fn: () => nodeMajor >= (config.nodeValidationMajor ?? 24),
      error: `Node major ${nodeMajor}`,
    },
    { id: "npm-ci", fn: () => /PLATFORM_NPM_CI_EXIT=0/.test(stdout) },
    { id: "npm-run-verify", fn: () => /PLATFORM_VERIFY_EXIT=0/.test(stdout) },
    {
      id: "npm-pack",
      fn: () =>
        /PLATFORM_NPM_PACK_EXIT=0/.test(stdout) &&
        marker(stdout, "PLATFORM_PACKED_TARBALL").length > 0,
    },
    { id: "packed-node-install", fn: () => /PLATFORM_PACKED_NODE_INSTALL_EXIT=0/.test(stdout) },
    { id: "pi-install-local-package", fn: () => /PLATFORM_PI_INSTALL_EXIT=0/.test(stdout) },
    {
      id: "pi-list-local-package",
      fn: () => /PLATFORM_PI_LIST_EXIT=0/.test(stdout) && listOutput.includes(config.packageName),
    },
    {
      id: "no-source-extension-shortcut",
      fn: () => !/\bpi\s+(?:-e|--extension)\s+\./.test(stdout),
    },
    {
      id: "no-secret-artifacts",
      fn: () => secretViolations.length === 0,
      error: secretViolations.join(", "),
    },
  ];
  if (stopResult)
    checks.push({
      id: "lease-cleanup",
      fn: () => stopResult.code === 0,
      error: `stop exit ${stopResult.code}`,
    });
  const expectedFiles = [
    "summary.json",
    "artifact-manifest.json",
    "target.json",
    "suite.json",
    "command.txt",
    "exit-code.txt",
    "crabbox.stdout.txt",
    "crabbox.stderr.txt",
    "crabbox.timing.json",
    "node-version.txt",
    "packed-tarball.txt",
    "packed-node-install.stdout.txt",
    "packed-node-install.stderr.txt",
    "pi-install.stdout.txt",
    "pi-install.stderr.txt",
    "pi-list.stdout.txt",
    "pi-list.stderr.txt",
    "assertions.json",
  ];
  if (stopResult)
    expectedFiles.push(
      "crabbox.stop.stdout.txt",
      "crabbox.stop.stderr.txt",
      "crabbox.stop.exit-code.txt",
    );
  const { assertions } = finalizeSuite(
    suiteDir,
    checks,
    {
      target: targetName,
      suite: suiteName,
      elapsedMs,
      exitCode: result.code,
      signal: result.signal,
    },
    expectedFiles,
  );
  return { ok: assertions.ok, suiteDir, assertions };
}

export async function runTargetSuites(config, targetName, suiteNames) {
  const slug = `${config.packageName}-${targetName}`;
  const startedAt = Date.now();
  const lease = await warmupLease(targetName, slug, config);
  if (!lease.ok)
    return {
      ok: false,
      results: [createWarmupFailureResult(config, targetName, "warmup-failure", lease, startedAt)],
    };
  const results = [];
  let stopResult;
  let staleCleanupResult;
  try {
    let sync = true;
    for (const suiteName of suiteNames) {
      const result = await runTargetSuite(config, targetName, suiteName, { ...lease, sync });
      results.push(result);
      sync = false;
      if (!result.ok) break;
    }
  } finally {
    stopResult = await stopLease(targetName, lease.leaseId, config);
    staleCleanupResult = await cleanupStaleTargetState(targetName, config);
  }
  if (stopResult) {
    results.push(
      createLeaseCleanupResult(config, targetName, lease.leaseId, stopResult, staleCleanupResult),
    );
  }
  return { ok: results.every((result) => result.ok), results };
}
