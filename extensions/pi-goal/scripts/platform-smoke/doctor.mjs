/** Platform smoke doctor. Fails before target runs when Crabbox/platform setup is missing. */

import { execFileSync, execSync } from "node:child_process";
import { accessSync, constants, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

function env(name) {
	return process.env[name] ?? "";
}

function ok(label) {
	console.log(`  ✓ ${label}`);
}

function warn(label) {
	console.log(`  ⚠ ${label}`);
}

function fail(label, failures) {
	console.error(`  ✗ ${label}`);
	failures.count += 1;
}

function silent(cmd, args, options = {}) {
	try {
		return execFileSync(cmd, args, { timeout: 20_000, stdio: "pipe", ...options }).toString().trim();
	} catch {
		return null;
	}
}

function shell(command, options = {}) {
	try {
		return execSync(command, { timeout: 20_000, stdio: "pipe", ...options }).toString().trim();
	} catch {
		return null;
	}
}

function hasCommand(name) {
	return silent("which", [name]) !== null;
}

function commandPath(name) {
	return silent("which", [name]);
}

function parseLeaseId(output) {
	return output.match(/\bleased\s+(\S+)/)?.[1]
		?? output.match(/\blease=(\S+)/)?.[1]
		?? null;
}

function windowsCrabboxBaseArgs(packageName) {
	const vmName = env("PLATFORM_SMOKE_WINDOWS_VM") || "pi-extension-windows-template";
	const snapshot = env("PLATFORM_SMOKE_WINDOWS_SNAPSHOT") || "crabbox-ready";
	const user = env("PLATFORM_SMOKE_WINDOWS_USER") || env("USER");
	const workRoot = env("PLATFORM_SMOKE_WINDOWS_WORK_ROOT") || `C:\\crabbox\\${packageName}`;
	return [
		"--provider", "parallels",
		"--target", "windows",
		"--windows-mode", "normal",
		"--parallels-source", vmName,
		"--parallels-source-snapshot", snapshot,
		"--parallels-user", user,
		"--parallels-work-root", workRoot,
	];
}

function crabbox(cbox, args, timeout = 300_000) {
	try {
		return {
			ok: true,
			stdout: execFileSync(cbox, args, {
				timeout,
				stdio: "pipe",
				env: { ...process.env, CRABBOX_SYNC_GIT_SEED: "false" },
			}).toString(),
			stderr: "",
		};
	} catch (error) {
		return {
			ok: false,
			stdout: error.stdout?.toString?.() ?? "",
			stderr: error.stderr?.toString?.() ?? error.message,
		};
	}
}

function disposableWindowsSshProbe(cbox, packageName) {
	const slug = `${packageName}-doctor-windows`;
	const baseArgs = windowsCrabboxBaseArgs(packageName);
	const warm = crabbox(cbox, ["warmup", ...baseArgs, "--slug", slug, "--keep", "--reclaim"], 300_000);
	const leaseId = parseLeaseId(warm.stdout) ?? parseLeaseId(warm.stderr) ?? slug;
	try {
		if (!warm.ok) return { ok: false, message: `disposable Windows warmup failed: ${(warm.stderr || warm.stdout).slice(-500)}` };
		const probeCommand = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command 'Get-Command node,npm,git,tar -ErrorAction Stop | Out-Null; node --version; npm --version; git --version; tar --version | Select-Object -First 1; whoami'";
		const run = crabbox(cbox, ["run", ...baseArgs, "--id", leaseId, "--no-sync", "--shell", probeCommand], 120_000);
		if (!run.ok) return { ok: false, message: `disposable Windows probe failed: ${(run.stderr || run.stdout).slice(-500)}` };
		const lines = run.stdout.trim().split(/\r?\n/).slice(-5);
		if (!/^v\d+\./.test(lines[0] ?? "")) return { ok: false, message: `disposable Windows node probe missing or invalid: ${lines.join(" | ")}` };
		if (!/^\d+\.\d+\./.test(lines[1] ?? "")) return { ok: false, message: `disposable Windows npm probe missing or invalid: ${lines.join(" | ")}` };
		if (!/^git version/i.test(lines[2] ?? "")) return { ok: false, message: `disposable Windows git probe missing or invalid: ${lines.join(" | ")}` };
		if (!/tar/i.test(lines[3] ?? "")) return { ok: false, message: `disposable Windows tar probe missing or invalid: ${lines.join(" | ")}` };
		if (!(lines[4] ?? "").trim()) return { ok: false, message: `disposable Windows whoami probe missing: ${lines.join(" | ")}` };
		return { ok: true, message: lines.join(" | ") };
	} finally {
		crabbox(cbox, ["stop", ...baseArgs, "--id", leaseId], 60_000);
	}
}

function parseVersion(version) {
	const match = String(version).match(/\d+(?:\.\d+){0,2}/);
	return match ? match[0].split(".").map((part) => Number(part)) : null;
}

function versionAtLeast(actual, minimum) {
	const parsedActual = parseVersion(actual);
	const parsedMinimum = parseVersion(minimum);
	if (!parsedActual || !parsedMinimum) return false;
	for (let i = 0; i < Math.max(parsedActual.length, parsedMinimum.length); i += 1) {
		const a = parsedActual[i] ?? 0;
		const b = parsedMinimum[i] ?? 0;
		if (a > b) return true;
		if (a < b) return false;
	}
	return true;
}

function isForbiddenProjectPath(path) {
	return /(^|\/)\.env(?:\..*)?$/.test(path)
		|| /(^|\/)[^/]+\.tgz$/.test(path)
		|| /(^|\/)\.artifacts(?:\/|$)/.test(path)
		|| /(^|\/)\.crabbox(?:\/|$)/.test(path)
		|| /(^|\/)\.debug(?:\/|$)/.test(path);
}

function npmPackFiles() {
	const output = silent("npm", ["pack", "--dry-run", "--json"]);
	if (!output) return null;
	try {
		const parsed = JSON.parse(output);
		return parsed[0]?.files?.map((file) => file.path) ?? [];
	} catch {
		return null;
	}
}

function checkForbiddenProjectFiles(failures) {
	const tracked = shell("git ls-files")?.split(/\r?\n/).filter(Boolean) ?? [];
	const trackedForbidden = tracked.filter(isForbiddenProjectPath);
	if (trackedForbidden.length === 0) ok("tracked source files exclude forbidden local artifacts");
	else fail(`forbidden tracked source path(s): ${trackedForbidden.join(", ")}`, failures);

	const localForbidden = shell("find . -maxdepth 2 \\( -name '.env' -o -name '.env.*' -o -name '*.tgz' \\) -not -path './node_modules/*' 2>/dev/null")
		?.split(/\r?\n/).filter(Boolean) ?? [];
	if (localForbidden.length === 0) ok("no local .env or package tarball artifacts at repo top level");
	else fail(`forbidden local artifact(s): ${localForbidden.join(", ")}`, failures);

	const packFiles = npmPackFiles();
	if (!packFiles) {
		fail("could not inspect npm pack contents", failures);
		return;
	}
	const packedForbidden = packFiles.filter(isForbiddenProjectPath);
	if (packedForbidden.length === 0) ok("npm package excludes forbidden local artifacts");
	else fail(`forbidden npm package path(s): ${packedForbidden.join(", ")}`, failures);
}

function crabboxProviders(cbox) {
	const output = silent(cbox, ["providers"]);
	if (!output) return [];
	return output.split(/\r?\n/)
		.filter((line) => /^\S/.test(line))
		.map((line) => line.trim().split(/\s+/)[0])
		.filter(Boolean);
}

function checkRequiredProviders(cbox, failures) {
	const providers = crabboxProviders(cbox);
	if (providers.length === 0) {
		fail("could not read crabbox providers", failures);
		return;
	}
	for (const provider of ["ssh", "local-container", "parallels"]) {
		if (providers.includes(provider)) ok(`crabbox provider available: ${provider}`);
		else fail(`crabbox provider missing: ${provider}`, failures);
	}
}

function checkCrabboxProvider(cbox, args, label, failures) {
	const output = silent(cbox, ["doctor", ...args, "--json"]);
	if (!output) {
		fail(`${label} crabbox doctor failed`, failures);
		return;
	}
	try {
		const parsed = JSON.parse(output);
		if (parsed.ok) ok(`${label} provider OK`);
		else fail(`${label} provider not ready: ${parsed.error ?? "unknown error"}`, failures);
	} catch {
		warn(`${label} provider returned non-JSON doctor output`);
	}
}

export async function runDoctor(config, options = {}) {
	const failures = { count: 0 };
	const skipWindowsDisposableProbe = options.skipWindowsDisposableProbe === true;
	const packageName = config?.packageName ?? "pi-codex-goal";
	const artifactRoot = config?.artifactRoot ?? ".artifacts/platform-smoke";
	const nodeMajor = config?.nodeValidationMajor ?? 24;

	console.log("\n── Platform smoke config ──");
	ok(`package: ${packageName}`);
	ok(`targets: ${(config?.requiredTargets ?? []).join(", ")}`);
	ok(`suites: ${(config?.requiredSuites ?? []).join(", ")}`);

	console.log("\n── Crabbox binary ──");
	const cbox = env("PLATFORM_SMOKE_CRABBOX") || "crabbox";
	const cboxPath = env("PLATFORM_SMOKE_CRABBOX") || commandPath("crabbox");
	if (!cboxPath) {
		fail("crabbox not found on PATH; install with Homebrew or set PLATFORM_SMOKE_CRABBOX", failures);
	} else {
		if (env("PLATFORM_SMOKE_CRABBOX")) {
			try {
				accessSync(cboxPath, constants.X_OK);
				ok(`binary: ${cboxPath}`);
			} catch {
				fail(`${cboxPath} is not executable`, failures);
			}
		} else {
			ok(`binary: ${cboxPath}`);
		}
		const version = silent(cbox, ["--version"]);
		if (version) {
			const displayVersion = version.split(/\r?\n/)[0];
			ok(`version: ${displayVersion}`);
			const minVersion = config?.requiredCrabbox?.minVersion;
			if (minVersion) {
				if (versionAtLeast(displayVersion, minVersion)) ok(`version ${displayVersion} >= ${minVersion}`);
				else fail(`Crabbox version ${displayVersion} < ${minVersion}`, failures);
			}
		} else {
			fail("could not read Crabbox version", failures);
		}
	}

	console.log("\n── Model smoke configuration ──");
	const model = process.env.PLATFORM_SMOKE_MODEL || config?.defaultModel || "zai/glm-5.1";
	const authEnv = (process.env.PLATFORM_SMOKE_AUTH_ENV
		? process.env.PLATFORM_SMOKE_AUTH_ENV.split(",")
		: (config?.defaultAuthEnv ?? ["ZAI_API_KEY", "Z_AI_API_KEY"])
	).map((name) => String(name).trim()).filter(Boolean);
	ok(`model: ${model}`);
	if ((config?.requiredSuites ?? []).includes("goal-runtime-smoke")) {
		const presentAuth = authEnv.filter((name) => env(name).length > 0);
		if (presentAuth.length > 0) ok(`auth env present: ${presentAuth.map((name) => `${name}=(present, redacted)`).join(", ")}`);
		else fail(`no model auth env present; set one of ${authEnv.join(", ")} or PLATFORM_SMOKE_AUTH_ENV`, failures);
	}

	console.log("\n── Host tools ──");
	for (const [name, command] of [["node", "node --version"], ["npm", "npm --version"], ["git", "git --version"], ["tar", "tar --version"]]) {
		const output = shell(command);
		if (!output) fail(`${name} not found`, failures);
		else ok(`${name}: ${output.split(/\r?\n/)[0]}`);
	}
	const localNode = shell("node --version");
	const localNodeMajor = Number(localNode?.replace(/^v/, "").split(".")[0] ?? 0);
	if (localNodeMajor >= nodeMajor) ok(`host Node major ${localNodeMajor} >= ${nodeMajor}`);
	else fail(`host Node major ${localNodeMajor || "unknown"} < ${nodeMajor}`, failures);

	console.log("\n── Crabbox providers ──");
	if (cboxPath) {
		checkRequiredProviders(cbox, failures);
		const ubuntuImage = env("PLATFORM_SMOKE_UBUNTU_IMAGE") || config?.ubuntuContainerImage || "cimg/node:24.16";
		checkCrabboxProvider(cbox, ["--provider", "local-container", "--local-container-image", ubuntuImage], "ubuntu local-container", failures);
		const macUser = env("PLATFORM_SMOKE_MAC_USER") || env("USER");
		const macHost = env("PLATFORM_SMOKE_MAC_HOST") || "localhost";
		const macRoot = env("PLATFORM_SMOKE_MAC_WORK_ROOT") || `/Users/${macUser}/crabbox/${packageName}`;
		checkCrabboxProvider(cbox, ["--provider", "ssh", "--target", "macos", "--static-host", macHost, "--static-user", macUser, "--static-port", "22", "--static-work-root", macRoot], "macOS ssh", failures);
	}

	console.log("\n── Docker / Ubuntu ──");
	const dockerVersion = shell("docker info --format '{{.ServerVersion}}'");
	if (dockerVersion) ok(`Docker ${dockerVersion}`);
	else fail("Docker is not available or not running", failures);

	console.log("\n── macOS SSH ──");
	const sshUser = env("PLATFORM_SMOKE_MAC_USER") || env("USER");
	const sshHost = env("PLATFORM_SMOKE_MAC_HOST") || "localhost";
	const sshProbe = shell(`ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${sshUser}@${sshHost} 'node --version && npm --version && git --version'`);
	if (sshProbe) ok(`SSH ${sshUser}@${sshHost}: ${sshProbe.split(/\r?\n/).join(" | ")}`);
	else fail(`SSH probe failed for ${sshUser}@${sshHost}`, failures);

	if ((config?.requiredTargets ?? []).includes("windows-native")) {
		console.log("\n── Windows native / Parallels ──");
		if (!hasCommand("prlctl")) {
			fail("prlctl not found", failures);
		} else {
			ok("prlctl found");
			const vmName = env("PLATFORM_SMOKE_WINDOWS_VM") || "pi-extension-windows-template";
			const snapshot = env("PLATFORM_SMOKE_WINDOWS_SNAPSHOT") || "crabbox-ready";
			const user = env("PLATFORM_SMOKE_WINDOWS_USER") || env("USER");
			const workRoot = env("PLATFORM_SMOKE_WINDOWS_WORK_ROOT") || `C:\\crabbox\\${packageName}`;
			const list = shell("prlctl list -a --no-header 2>/dev/null");
			if (!list) {
				fail("prlctl list returned no VMs", failures);
			} else if (!list.includes(vmName)) {
				fail(`Windows VM ${vmName} not found`, failures);
			} else {
				ok(`Windows VM ${vmName} found`);
				const status = shell(`prlctl status "${vmName.replace(/"/g, "\\\"")}" 2>/dev/null`);
				if (/\bstopped\b/i.test(status ?? "")) ok(`Windows source VM ${vmName} is stopped`);
				else fail(`Windows source VM ${vmName} must be stopped for forkable snapshot use; current status: ${status ?? "unknown"}`, failures);
				const snapshotsJson = shell(`prlctl snapshot-list "${vmName.replace(/"/g, "\\\"")}" -j 2>/dev/null`);
				let snapshotMatch = null;
				try {
					const snapshots = JSON.parse(snapshotsJson ?? "{}");
					snapshotMatch = Object.entries(snapshots).find(([id, data]) => id === snapshot || data?.name === snapshot);
				} catch {
					// Fall through to the failure below.
				}
				let snapshotPowerOff = false;
				if (snapshotMatch) {
					ok(`snapshot ${snapshot} found`);
					const snapshotState = snapshotMatch[1]?.state ?? "unknown";
					snapshotPowerOff = snapshotState === "poweroff";
					if (snapshotPowerOff) ok(`snapshot ${snapshot} state is poweroff`);
					else fail(`snapshot ${snapshot} must be poweroff; current snapshot state: ${snapshotState}`, failures);
				} else {
					fail(`snapshot ${snapshot} not found on ${vmName}`, failures);
				}
				checkCrabboxProvider(cbox, ["--provider", "parallels", "--target", "windows", "--windows-mode", "normal", "--parallels-source", vmName, "--parallels-source-snapshot", snapshot, "--parallels-user", user, "--parallels-work-root", workRoot], "windows parallels", failures);
				const ipLine = shell(`prlctl list -f --no-header "${vmName.replace(/"/g, "\\\"")}" 2>/dev/null`);
				if (!ipLine) {
					fail(`could not inspect Windows VM IP for ${vmName}`, failures);
				} else {
					const parts = ipLine.trim().split(/\s+/);
					const ip = parts.length >= 3 ? parts[2] : null;
					if (ip && ip !== "-") {
						ok(`Windows template IP: ${ip}`);
						const portCheck = shell(`nc -z -w 3 ${ip} 22 2>/dev/null && echo open || echo closed`);
						if (portCheck?.includes("open")) ok(`SSH open on ${ip}:22`);
						else fail(`SSH not open on ${ip}:22 — enable OpenSSH Server in the Windows template VM`, failures);
					} else if (skipWindowsDisposableProbe) {
						warn(`template ${vmName} has no IP; skipping disposable Windows clone probe because a full target run is expected to validate SSH/tools`);
					} else if (cboxPath && snapshotMatch && snapshotPowerOff) {
						ok(`template ${vmName} has no IP; verifying Windows SSH/tools through a disposable Crabbox clone`);
						const probe = disposableWindowsSshProbe(cbox, packageName);
						if (probe.ok) ok(`disposable Windows clone SSH/tool probe OK: ${probe.message}`);
						else fail(probe.message, failures);
					} else {
						fail(`Windows SSH probe could not run because ${vmName} has no IP and no verified poweroff snapshot was available`, failures);
					}
				}
			}
		}
	} else {
		console.log("\n── Windows native / Parallels ──");
		warn("windows-native is not listed in requiredTargets for this configuration");
	}

	console.log("\n── Artifact root ──");
	const artRoot = resolve(process.cwd(), artifactRoot);
	try {
		mkdirSync(artRoot, { recursive: true });
		const probe = resolve(artRoot, ".doctor-write-test");
		writeFileSync(probe, "ok");
		unlinkSync(probe);
		ok(`writable: ${artRoot}`);
	} catch (error) {
		fail(`artifact root not writable: ${error.message}`, failures);
	}

	console.log("\n── Repository hygiene ──");
	const status = shell("git status --short");
	if (status) warn(`${status.split(/\r?\n/).length} uncommitted change(s) recorded for smoke evidence`);
	else ok("git status clean");
	checkForbiddenProjectFiles(failures);

	console.log(`\n=== Results: ${failures.count} failure(s) ===`);
	if (failures.count > 0) {
		console.log("Fix doctor failures before running smoke:platform:all.");
		process.exitCode = 1;
	} else {
		console.log("Platform smoke setup is ready.");
	}
}
