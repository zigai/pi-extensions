#!/usr/bin/env node

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { forbiddenArtifactMessage, localForbiddenProjectArtifacts } from "./platform-smoke/hygiene.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

let config;
try {
	config = require(resolve(repoRoot, "platform-smoke.config.mjs"));
	if (config.default) config = config.default;
} catch (error) {
	config = null;
}

function printHelp() {
	console.log(`Usage: node scripts/platform-smoke.mjs <command> [options]

Commands:
  doctor                     Validate Crabbox and platform prerequisites; spends no model tokens
  run --target <names>       Run one or more comma-separated targets concurrently

Package scripts:
  check:platform-smoke       Syntax-check harness scripts and run cheap harness invariant tests
  smoke:platform:all         Runs doctor first, then the full macOS/Ubuntu/Windows matrix
  run --suite <name>         Run one suite on all or specified targets

Targets:
  macos, ubuntu, windows-native

Suites:
  platform-build             npm ci, npm run verify, npm pack, packed pi install/list with project trust approval
  goal-runtime-smoke         real model run through packed pi-codex-goal install

Options:
  --target <names>           Comma-separated target names
  --suite <name>             Suite name; defaults to configured required suites
  --skip-windows-disposable-probe
                            Doctor: skip the disposable Windows clone probe when a full target run follows
  --help, -h                 Show this help

Examples:
  npm run check:platform-smoke
  npm run smoke:platform:doctor
  npm run smoke:platform:all
  node scripts/platform-smoke.mjs doctor
  node scripts/platform-smoke.mjs run --target macos
  node scripts/platform-smoke.mjs run --target ubuntu --suite platform-build
  node scripts/platform-smoke.mjs run --target macos,ubuntu,windows-native

Environment:
  PLATFORM_SMOKE_CRABBOX              Optional Crabbox binary override; defaults to crabbox on PATH
  PLATFORM_SMOKE_MAC_HOST             macOS SSH host; default localhost
  PLATFORM_SMOKE_MAC_USER             macOS SSH user; default $USER
  PLATFORM_SMOKE_MAC_WORK_ROOT        macOS Crabbox work root
  PLATFORM_SMOKE_UBUNTU_IMAGE         Ubuntu local-container image
  PLATFORM_SMOKE_WINDOWS_VM           Parallels Windows template VM
  PLATFORM_SMOKE_WINDOWS_SNAPSHOT     Parallels snapshot name
  PLATFORM_SMOKE_WINDOWS_USER         Windows SSH user
  PLATFORM_SMOKE_WINDOWS_WORK_ROOT    Windows work root, for example C:\\crabbox\\pi-codex-goal
  PLATFORM_SMOKE_MODEL                Model for real runtime smoke; default zai/glm-5.2
  PLATFORM_SMOKE_AUTH_ENV             Comma-separated auth env names to forward; default ZAI_API_KEY,Z_AI_API_KEY
`);
}

function parseArgs(argv) {
	const parsed = { command: null, target: null, suite: null, skipWindowsDisposableProbe: false, rest: [] };
	for (let i = 2; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			parsed.command = "help";
			return parsed;
		}
		if (arg === "doctor" || arg === "run") {
			parsed.command = arg;
			continue;
		}
		if (arg === "--target" && argv[i + 1]) {
			parsed.target = argv[i + 1];
			i += 1;
			continue;
		}
		if (arg === "--suite" && argv[i + 1]) {
			parsed.suite = argv[i + 1];
			i += 1;
			continue;
		}
		if (arg === "--skip-windows-disposable-probe") {
			parsed.skipWindowsDisposableProbe = true;
			continue;
		}
		parsed.rest.push(arg);
	}
	return parsed;
}

function validateNames(kind, names, allowed) {
	const invalid = names.filter((name) => !allowed.includes(name));
	if (invalid.length > 0) throw new Error(`unknown ${kind}: ${invalid.join(", ")}`);
}

async function main() {
	const args = parseArgs(process.argv);
	if (!args.command || args.command === "help") {
		printHelp();
		process.exit(args.command === "help" ? 0 : 1);
	}
	if (!config) throw new Error("platform-smoke.config.mjs not found or invalid");

	if (args.command === "doctor") {
		const { runDoctor } = await import("./platform-smoke/doctor.mjs");
		await runDoctor(config, { skipWindowsDisposableProbe: args.skipWindowsDisposableProbe });
		return;
	}

	if (args.command === "run") {
		const localForbidden = localForbiddenProjectArtifacts();
		if (localForbidden.length > 0) {
			throw new Error(`${forbiddenArtifactMessage(localForbidden)}. Remove them before platform sync or run smoke:platform:doctor for full setup checks.`);
		}

		const { runTargetSuite, runTargetSuites } = await import("./platform-smoke/targets.mjs");
		const targets = args.target ? args.target.split(",").map((name) => name.trim()).filter(Boolean) : config.requiredTargets;
		const suites = args.suite ? [args.suite] : config.requiredSuites;
		const supportedTargets = config.supportedTargets ?? config.requiredTargets;
		validateNames("target", targets, supportedTargets);
		validateNames("suite", suites, config.requiredSuites);
		const runs = targets.map(async (targetName) => {
			console.log(`\n=== Target: ${targetName} ===`);
			const result = args.suite
				? await runTargetSuite(config, targetName, suites[0])
				: await runTargetSuites(config, targetName, suites);
			return { targetName, result };
		});
		const results = await Promise.all(runs);
		const failed = results.filter(({ result }) => !result.ok);
		if (failed.length > 0) {
			console.error(`\nPlatform smoke failed for ${failed.map(({ targetName }) => targetName).join(", ")}. See ${config.artifactRoot}.`);
			process.exitCode = 1;
		}
		return;
	}

	throw new Error(`unknown command: ${args.command}`);
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
