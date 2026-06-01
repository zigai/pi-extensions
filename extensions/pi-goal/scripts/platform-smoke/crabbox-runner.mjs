/** Thin Crabbox CLI wrapper for cross-platform smoke tests. */

import { spawn } from "node:child_process";

function env(name) {
	return process.env[name] ?? "";
}

export function crabboxBin() {
	return process.env.PLATFORM_SMOKE_CRABBOX || "crabbox";
}

function packageSlug() {
	return process.env.PLATFORM_SMOKE_PACKAGE_SLUG || "pi-codex-goal";
}

export function buildTargetBaseArgs(targetName) {
	switch (targetName) {
		case "macos": {
			const user = env("PLATFORM_SMOKE_MAC_USER") || env("USER");
			const host = env("PLATFORM_SMOKE_MAC_HOST") || "localhost";
			const workRoot = env("PLATFORM_SMOKE_MAC_WORK_ROOT") || `/Users/${user}/crabbox/${packageSlug()}`;
			return [
				"--provider", "ssh",
				"--target", "macos",
				"--static-host", host,
				"--static-user", user,
				"--static-port", "22",
				"--static-work-root", workRoot,
			];
		}
		case "ubuntu": {
			const image = env("PLATFORM_SMOKE_UBUNTU_IMAGE") || "cimg/node:24.16";
			return [
				"--provider", "local-container",
				"--target", "linux",
				"--local-container-image", image,
			];
		}
		case "windows-native": {
			const vm = env("PLATFORM_SMOKE_WINDOWS_VM") || "pi-extension-windows-template";
			const snapshot = env("PLATFORM_SMOKE_WINDOWS_SNAPSHOT") || "crabbox-ready";
			const user = env("PLATFORM_SMOKE_WINDOWS_USER") || env("USER");
			const workRoot = env("PLATFORM_SMOKE_WINDOWS_WORK_ROOT") || `C:\\crabbox\\${packageSlug()}`;
			return [
				"--provider", "parallels",
				"--target", "windows",
				"--windows-mode", "normal",
				"--parallels-source", vm,
				"--parallels-source-snapshot", snapshot,
				"--parallels-user", user,
				"--parallels-work-root", workRoot,
			];
		}
		default:
			throw new Error(`unknown platform smoke target: ${targetName}`);
	}
}

export function leaseIdFor(targetName, slug) {
	if (targetName === "macos") return "static_localhost";
	return slug;
}

function parseLeaseId(text) {
	return text.match(/\bleased\s+(\S+)/)?.[1]
		?? text.match(/\blease=(\S+)/)?.[1]
		?? null;
}

export function execCrabbox(args, options = {}) {
	return new Promise((resolvePromise) => {
		const child = spawn(crabboxBin(), args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, CRABBOX_SYNC_GIT_SEED: "false", ...options.env },
		});
		const stdout = [];
		const stderr = [];
		let timeout;
		let killTimeout;
		if (options.timeout) {
			timeout = setTimeout(() => {
				stderr.push(Buffer.from(`\n[platform-smoke] crabbox timed out after ${options.timeout}ms\n`));
				try { child.kill("SIGTERM"); } catch {}
				killTimeout = setTimeout(() => {
					try { child.kill("SIGKILL"); } catch {}
				}, 10_000);
			}, options.timeout);
		}
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.on("error", (error) => {
			if (timeout) clearTimeout(timeout);
			if (killTimeout) clearTimeout(killTimeout);
			resolvePromise({ stdout: Buffer.concat(stdout).toString(), stderr: `${Buffer.concat(stderr).toString()}${error.message}\n`, code: 1, signal: null });
		});
		child.on("close", (code, signal) => {
			if (timeout) clearTimeout(timeout);
			if (killTimeout) clearTimeout(killTimeout);
			resolvePromise({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), code: code ?? (signal ? 1 : 0), signal });
		});
	});
}

export async function warmupLease(targetName, slug) {
	const args = ["warmup", ...buildTargetBaseArgs(targetName), "--slug", slug, "--keep"];
	console.log(`  [crabbox] ${args.join(" ")}`);
	const result = await execCrabbox(args, { timeout: 300_000 });
	return {
		...result,
		ok: result.code === 0,
		leaseId: parseLeaseId(`${result.stdout}\n${result.stderr}`) ?? leaseIdFor(targetName, slug),
	};
}

export async function runOnLease(targetName, leaseId, command, options = {}) {
	const args = ["run", ...buildTargetBaseArgs(targetName), "--id", leaseId];
	for (const name of options.allowEnv ?? []) {
		args.push("--allow-env", name);
	}
	if (options.sync === false) args.push("--no-sync");
	else args.push("--fresh-sync");
	args.push("--shell", command);
	console.log(`  [crabbox] run ${targetName} ${options.sync === false ? "--no-sync" : "--fresh-sync"}`);
	return execCrabbox(args, { timeout: options.timeout ?? 900_000 });
}

export async function stopLease(targetName, leaseId) {
	const args = ["stop", ...buildTargetBaseArgs(targetName), "--id", leaseId];
	console.log(`  [crabbox] ${args.join(" ")}`);
	return execCrabbox(args, { timeout: 90_000 });
}

export async function cleanupStaleTargetState(targetName) {
	if (targetName === "macos") return null;
	const args = ["cleanup", ...buildTargetBaseArgs(targetName)];
	console.log(`  [crabbox] ${args.join(" ")}`);
	return execCrabbox(args, { timeout: 120_000 });
}
