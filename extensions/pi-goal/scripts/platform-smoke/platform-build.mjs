#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function parseArgs(argv) {
	const args = { packageName: "pi-codex-goal", nodeValidationMajor: 24 };
	for (let i = 2; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			console.log("Usage: node scripts/platform-smoke/platform-build.mjs --package-name <name> --node-validation-major <major>");
			process.exit(0);
		}
		if (arg === "--package-name" && argv[i + 1]) {
			args.packageName = argv[++i];
			continue;
		}
		if (arg === "--node-validation-major" && argv[i + 1]) {
			args.nodeValidationMajor = Number(argv[++i]);
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
		maxBuffer: 50 * 1024 * 1024,
		shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
	});
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? (result.error?.message ?? "");
	if (!options.quiet) {
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
	}
	return { status: result.status ?? 1, stdout, stderr };
}

function section(name, text) {
	console.log(`--- ${name} START ---`);
	if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
	console.log(`--- ${name} END ---`);
}

function write(path, text) {
	writeFileSync(path, text ?? "");
}

const args = parseArgs(process.argv);
const sourceRoot = process.cwd();
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const runRoot = join(".platform-smoke-runs", `platform-build-${stamp}-${process.pid}`);
const packDir = resolve(sourceRoot, runRoot, "pack");
const testWorkspace = resolve(sourceRoot, runRoot, "test-workspace");
const piProject = resolve(sourceRoot, runRoot, "pi-project");
mkdirSync(packDir, { recursive: true });
mkdirSync(testWorkspace, { recursive: true });
mkdirSync(piProject, { recursive: true });

console.log(`Starting platform-build in ${sourceRoot} at ${new Date().toISOString()}`);
console.log(`PLATFORM_RUN_ROOT=${runRoot}`);

const nodeVersion = process.version;
const nodeMajor = Number(nodeVersion.replace(/^v/, "").split(".")[0] ?? 0);
const nodeVersionExit = nodeMajor >= args.nodeValidationMajor ? 0 : 1;
console.log(`PLATFORM_NODE_VERSION=${nodeVersion}`);
console.log(`PLATFORM_NODE_VERSION_EXIT=${nodeVersionExit}`);

const npm = commandName("npm");
const npmCi = run(npm, ["ci"], { cwd: sourceRoot });
console.log(`PLATFORM_NPM_CI_EXIT=${npmCi.status}`);

const verify = run(npm, ["run", "verify"], { cwd: sourceRoot });
console.log(`PLATFORM_VERIFY_EXIT=${verify.status}`);

const packStderr = join(packDir, "npm-pack.stderr.txt");
const pack = run(npm, ["pack", "--silent", "--pack-destination", packDir], { cwd: sourceRoot, quiet: true });
write(packStderr, pack.stderr);
const packTarball = pack.stdout.trim().split(/\r?\n/).at(-1) ?? "";
const packFile = packTarball ? join(packDir, packTarball) : "";
if (pack.stderr) process.stderr.write(pack.stderr);
console.log(`PLATFORM_NPM_PACK_EXIT=${pack.status}`);
console.log(`PLATFORM_PACKED_TARBALL=${packFile}`);

let fixtureExit = 0;
try {
	for (const file of ["package.json", "README.md"]) {
		writeFileSync(join(testWorkspace, file), readFileSync(resolve(sourceRoot, file)));
	}
	for (const dir of ["src", "prompts"]) {
		cpSync(resolve(sourceRoot, dir), join(testWorkspace, dir), { recursive: true });
	}
} catch (error) {
	write(join(packDir, "fixture.stderr.txt"), `${error.message}\n`);
	fixtureExit = 1;
}
console.log(`PLATFORM_FIXTURE_EXIT=${fixtureExit}`);
if (existsSync(join(packDir, "fixture.stderr.txt"))) process.stderr.write(readFileSync(join(packDir, "fixture.stderr.txt"), "utf8"));

let piCli = resolve(sourceRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
if (!existsSync(piCli)) piCli = process.platform === "win32" && existsSync(resolve(sourceRoot, "node_modules", ".bin", "pi")) ? resolve(sourceRoot, "node_modules", ".bin", "pi") : "pi";
console.log(`PLATFORM_PI_CLI=${piCli}`);

const packedNodeInstallStdout = join(packDir, "packed-node-install.stdout.txt");
const packedNodeInstallStderr = join(packDir, "packed-node-install.stderr.txt");
let packedNodeInstallExit = 1;
if (packFile && existsSync(packFile)) {
	const npmInit = run(npm, ["init", "-y"], { cwd: piProject, quiet: true });
	const npmInstall = npmInit.status === 0 ? run(npm, ["install", "--no-save", packFile], { cwd: piProject, quiet: true }) : { status: npmInit.status, stdout: "", stderr: "" };
	packedNodeInstallExit = npmInit.status === 0 ? npmInstall.status : npmInit.status;
	write(packedNodeInstallStdout, `${npmInit.stdout}${npmInstall.stdout}`);
	write(packedNodeInstallStderr, `${npmInit.stderr}${npmInstall.stderr}`);
} else {
	write(packedNodeInstallStdout, "");
	write(packedNodeInstallStderr, "missing tarball\n");
}
console.log(`PLATFORM_PACKED_NODE_INSTALL_EXIT=${packedNodeInstallExit}`);
section("PACKED_NODE_INSTALL_STDOUT", readFileSync(packedNodeInstallStdout, "utf8"));
section("PACKED_NODE_INSTALL_STDERR", readFileSync(packedNodeInstallStderr, "utf8"));

const piInstallStdout = join(packDir, "pi-install.stdout.txt");
const piInstallStderr = join(packDir, "pi-install.stderr.txt");
let piInstallExit = 1;
if (packedNodeInstallExit === 0) {
	const installPath = `.${process.platform === "win32" ? "\\" : "/"}node_modules${process.platform === "win32" ? "\\" : "/"}${args.packageName}`;
	const piInstall = run(piCli, ["install", "-l", installPath, "--approve"], { cwd: piProject, env: { PI_OFFLINE: "1" }, quiet: true });
	piInstallExit = piInstall.status;
	write(piInstallStdout, piInstall.stdout);
	write(piInstallStderr, piInstall.stderr);
} else {
	write(piInstallStdout, "");
	write(piInstallStderr, "packed npm install failed\n");
}
console.log(`PLATFORM_PI_INSTALL_EXIT=${piInstallExit}`);
section("PI_INSTALL_STDOUT", readFileSync(piInstallStdout, "utf8"));
section("PI_INSTALL_STDERR", readFileSync(piInstallStderr, "utf8"));

const piListStdout = join(packDir, "pi-list.stdout.txt");
const piListStderr = join(packDir, "pi-list.stderr.txt");
const piList = run(piCli, ["list", "--approve"], { cwd: piProject, env: { PI_OFFLINE: "1" }, quiet: true });
write(piListStdout, piList.stdout);
write(piListStderr, piList.stderr);
console.log(`PLATFORM_PI_LIST_EXIT=${piList.status}`);
section("PI_LIST_STDOUT", piList.stdout);
section("PI_LIST_STDERR", piList.stderr);

if ([nodeVersionExit, npmCi.status, verify.status, pack.status, fixtureExit, packedNodeInstallExit, piInstallExit, piList.status].some((status) => status !== 0)) {
	console.log("PLATFORM_BUILD_FAILED");
	process.exit(1);
}

console.log("PLATFORM_BUILD_OK");
