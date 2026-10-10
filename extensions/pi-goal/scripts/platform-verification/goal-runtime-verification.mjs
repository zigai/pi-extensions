#!/usr/bin/env node
import { packageRoot, piCliPath, packRuntimeDependencies } from "./workspace-packages.mjs";

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Type } from "typebox";
import { Value } from "typebox/value";

const ContentCandidatesSchema = Type.Array(Type.Unknown());
const TextContentSchema = Type.Object(
  { type: Type.Literal("text"), text: Type.String() },
  { additionalProperties: true },
);
const SessionEntrySchema = Type.Object({ message: Type.Unknown() }, { additionalProperties: true });
const AssistantMessageSchema = Type.Object(
  { role: Type.Literal("assistant"), content: ContentCandidatesSchema },
  { additionalProperties: true },
);
const ReadToolCallSchema = Type.Object(
  {
    type: Type.Literal("toolCall"),
    name: Type.Literal("read"),
    id: Type.String(),
    arguments: Type.Object({ path: Type.String() }, { additionalProperties: true }),
  },
  { additionalProperties: true },
);

const ReadToolResultSchema = Type.Object(
  {
    role: Type.Literal("toolResult"),
    toolName: Type.Literal("read"),
    isError: Type.Literal(false),
    toolCallId: Type.String(),
    content: ContentCandidatesSchema,
  },
  { additionalProperties: true },
);

function parseArgs(argv) {
  const args = { model: "zai/glm-5.2", packageName: "@zigai/pi-goal" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: node scripts/platform-verification/goal-runtime-verification.mjs --model <model> --package-name <name>`,
      );

      process.exit(0);
    }

    if (arg === "--model" && argv[i + 1]) {
      args.model = argv[++i];
      continue;
    }

    if (arg === "--package-name" && argv[i + 1]) {
      args.packageName = argv[++i];
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
  });

  return {
    command: [command, ...args].join(" "),
    cwd: options.cwd,
    status: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function section(name, text) {
  console.log(`--- ${name} START ---`);
  if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  console.log(`--- ${name} END ---`);
}

function b64(text) {
  return Buffer.from(text ?? "", "utf8").toString("base64");
}

function walkFiles(root) {
  const files = [];

  function visit(dir) {
    let entries = [];

    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }

  visit(root);

  return files;
}

function findSessionJsonl(sessionDir) {
  const candidates = walkFiles(sessionDir).filter((file) => file.endsWith(".jsonl"));
  let best = "";
  let bestScore = -1;
  for (const file of candidates) {
    let text = "";

    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const score = (text.includes("pi-codex-goal") ? 10_000 : 0) + text.length;
    if (score > bestScore) {
      best = file;
      bestScore = score;
    }
  }

  return best;
}

function latestPackedTarball(packDir, packageName) {
  const files = readdirSync(packDir)
    .filter((file) => file.startsWith(`${packageName}-`) && file.endsWith(".tgz"))
    .map((file) => join(packDir, file));

  files.sort();

  return files.at(-1) ?? "";
}

function textContent(content) {
  let candidates;
  try {
    candidates = Value.Parse(ContentCandidatesSchema, content);
  } catch {
    return "";
  }

  return candidates
    .flatMap((candidate) => {
      try {
        return [Value.Parse(TextContentSchema, candidate).text];
      } catch {
        return [];
      }
    })
    .join("\n");
}

function observedSuccessfulReadTool(sessionJsonl, expectedPath, expectedContent) {
  const readCallIds = new Set();
  let successfulReadResult = false;

  for (const line of sessionJsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let message;
    try {
      message = Value.Parse(SessionEntrySchema, JSON.parse(line)).message;
    } catch {
      continue;
    }

    try {
      const assistantMessage = Value.Parse(AssistantMessageSchema, message);
      for (const candidate of assistantMessage.content) {
        try {
          const readCall = Value.Parse(ReadToolCallSchema, candidate);
          if (readCall.arguments.path === expectedPath) {
            readCallIds.add(readCall.id);
          }
        } catch {
          // Ignore non-read content blocks in assistant messages.
        }
      }
      continue;
    } catch {
      // The message may instead be the matching tool result.
    }

    try {
      const readResult = Value.Parse(ReadToolResultSchema, message);
      if (
        readCallIds.has(readResult.toolCallId) &&
        textContent(readResult.content).trim() === expectedContent
      ) {
        successfulReadResult = true;
      }
    } catch {
      // Ignore unrelated session messages.
    }
  }

  return successfulReadResult;
}

const args = parseArgs(process.argv);
const sourceRoot = packageRoot;
const runId = `goal-runtime-verification-${new Date()
  .toISOString()
  .replace(/[-:.TZ]/g, "")
  .slice(0, 14)}-${process.pid}`;
const runRoot = resolve(sourceRoot, ".platform-verification-runs", runId);
const packDir = join(runRoot, "pack");
const piProject = join(runRoot, "pi-project");
const sessionDir = join(runRoot, "session");
const agentDir = join(runRoot, "agent-config");
const verificationFile = join(piProject, "goal-runtime-verification.txt");

mkdirSync(packDir, { recursive: true });
mkdirSync(piProject, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const npm = commandName("npm");
const piCommand = process.execPath;
const piPrefixArgs = [piCliPath];
const piEnv = { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
const commands = [];
const pack = run(npm, ["pack", "--silent", "--pack-destination", packDir], { cwd: sourceRoot });
commands.push({ name: "npm-pack", ...pack });

const packedTarball =
  latestPackedTarball(packDir, args.packageName) ||
  join(packDir, pack.stdout.trim().split(/\r?\n/).at(-1) ?? "");

const npmInit = run(npm, ["init", "-y", "--workspaces=false"], { cwd: piProject });
commands.push({ name: "npm-init", ...npmInit });

const npmInstall = run(
  npm,
  [
    "install",
    "--prefix",
    piProject,
    "--workspaces=false",
    "--ignore-scripts",
    "--no-save",
    packedTarball,
    ...packRuntimeDependencies(packDir),
  ],
  { cwd: piProject },
);
commands.push({ name: "npm-install-packed", ...npmInstall });

const installPath = `.${process.platform === "win32" ? "\\" : "/"}node_modules${process.platform === "win32" ? "\\" : "/"}${args.packageName}`;
const piInstall = run(piCommand, [...piPrefixArgs, "install", "-l", installPath, "--approve"], {
  cwd: piProject,
  env: piEnv,
});
commands.push({ name: "pi-install", ...piInstall });

const piList = run(piCommand, [...piPrefixArgs, "list", "--approve"], {
  cwd: piProject,
  env: piEnv,
});
commands.push({ name: "pi-list", ...piList });

const expectedContent = "PI_CODEX_GOAL_RUNTIME_OK";
const prompt = `You are running a real cross-platform verification test for the pi-codex-goal extension.
Do not use slash commands. Use the available goal tools and filesystem tools.
Required steps:
1. Call create_goal with an objective that requires creating ${verificationFile} containing ${expectedContent}, verifying the file content from the filesystem, inspecting the current goal, and marking it complete only after verification.
2. Create ${verificationFile} with exactly ${expectedContent}.
3. Verify the file content by reading it from the filesystem with the built-in read tool, not with shell cat/type.
4. Call get_goal and confirm the goal is active before completion.
5. Call update_goal with status complete only after the file content is verified.
6. Call get_goal again and confirm the final status is complete.
Final answer exactly: GOAL_RUNTIME_VERIFICATION_OK status=complete file=${expectedContent}`;

const piRun = run(
  piCommand,
  [
    ...piPrefixArgs,
    "--approve",
    "--model",
    args.model,
    "--session-dir",
    sessionDir,
    "--no-context-files",
    "-p",
    prompt,
  ],
  { cwd: piProject, env: piEnv },
);
commands.push({ name: "pi-run", ...piRun });

let fileContent = "";

try {
  fileContent = readFileSync(verificationFile, "utf8").trim();
} catch {}

const sessionJsonlPath = findSessionJsonl(sessionDir);
let sessionJsonl = "";

try {
  sessionJsonl = readFileSync(sessionJsonlPath, "utf8");
} catch {}

const finalMarkerObserved = piRun.stdout.includes(
  `GOAL_RUNTIME_VERIFICATION_OK status=complete file=${expectedContent}`,
);
const customGoalObserved = sessionJsonl.includes("pi-codex-goal");
const completeGoalObserved =
  sessionJsonl.includes('"status":"complete"') || sessionJsonl.includes('"status": "complete"');
const readToolObserved = observedSuccessfulReadTool(
  sessionJsonl,
  verificationFile,
  expectedContent,
);
const fileVerified = fileContent === expectedContent;
const ok =
  pack.status === 0 &&
  npmInit.status === 0 &&
  npmInstall.status === 0 &&
  piInstall.status === 0 &&
  piList.status === 0 &&
  piRun.status === 0 &&
  finalMarkerObserved &&
  customGoalObserved &&
  completeGoalObserved &&
  readToolObserved &&
  fileVerified;

const result = {
  ok,
  model: args.model,
  packageName: args.packageName,
  runRoot,
  piProject,
  sessionDir,
  agentDir,
  sessionJsonlPath,
  verificationFile,
  packedTarball,
  checks: {
    npmPack: pack.status === 0,
    npmInit: npmInit.status === 0,
    npmInstallPacked: npmInstall.status === 0,
    piInstall: piInstall.status === 0,
    piList: piList.status === 0 && piList.stdout.replaceAll("\\", "/").includes(args.packageName),
    piRun: piRun.status === 0,
    finalMarkerObserved,
    customGoalObserved,
    completeGoalObserved,
    readToolObserved,
    fileVerified,
  },
  commands: commands.map((command) => ({
    name: command.name,
    command: command.command,
    cwd: command.cwd,
    status: command.status,
    signal: command.signal,
  })),
};

console.log(`PLATFORM_GOAL_RUNTIME_MODEL=${args.model}`);
console.log(`PLATFORM_GOAL_RUNTIME_RUN_ROOT=${runRoot}`);
console.log(`PLATFORM_GOAL_RUNTIME_PACKED_TARBALL=${packedTarball}`);
console.log(`PLATFORM_GOAL_RUNTIME_PI_EXIT=${piRun.status}`);
console.log(`PLATFORM_GOAL_RUNTIME_OK=${ok ? 1 : 0}`);
console.log("PLATFORM_GOAL_RUNTIME_JSON_START");
console.log(JSON.stringify(result, null, 2));
console.log("PLATFORM_GOAL_RUNTIME_JSON_END");
section("NPM_PACK_STDOUT", pack.stdout);
section("NPM_PACK_STDERR", pack.stderr);
section("PACKED_NODE_INSTALL_STDOUT", npmInstall.stdout);
section("PACKED_NODE_INSTALL_STDERR", npmInstall.stderr);
section("PI_INSTALL_STDOUT", piInstall.stdout);
section("PI_INSTALL_STDERR", piInstall.stderr);
section("PI_LIST_STDOUT", piList.stdout);
section("PI_LIST_STDERR", piList.stderr);
section("PI_RUN_STDOUT", piRun.stdout);
section("PI_RUN_STDERR", piRun.stderr);
section("SESSION_JSONL_B64", b64(sessionJsonl));

if (ok) {
  console.log("GOAL_RUNTIME_VERIFICATION_OK");
} else {
  console.log("GOAL_RUNTIME_VERIFICATION_FAILED");
  process.exit(1);
}
