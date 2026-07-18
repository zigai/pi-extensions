/** Thin Crabbox CLI wrapper for cross-platform smoke tests. */

import { spawn } from "node:child_process";

function env(name) {
  return process.env[name] ?? "";
}

export function crabboxBin() {
  return process.env.PLATFORM_SMOKE_CRABBOX || "crabbox";
}

function packageSlug(config = {}) {
  return config.packageName || process.env.PLATFORM_SMOKE_PACKAGE_SLUG || "pi-codex-goal";
}

function expandUser(value, user) {
  return String(value).replace(/\$USER/g, user);
}

export function buildTargetBaseArgs(targetName, config = {}) {
  switch (targetName) {
    case "macos": {
      const user = env("PLATFORM_SMOKE_MAC_USER") || env("USER");
      const host = env("PLATFORM_SMOKE_MAC_HOST") || config.macosStaticSsh?.host || "localhost";
      const configuredRoot = config.macosStaticSsh?.workRoot;
      const workRoot =
        env("PLATFORM_SMOKE_MAC_WORK_ROOT") ||
        (configuredRoot
          ? expandUser(configuredRoot, user)
          : `/Users/${user}/crabbox/${packageSlug(config)}`);
      return [
        "--provider",
        "ssh",
        "--target",
        "macos",
        "--static-host",
        host,
        "--static-user",
        user,
        "--static-port",
        "22",
        "--static-work-root",
        workRoot,
      ];
    }
    case "ubuntu": {
      const image =
        env("PLATFORM_SMOKE_UBUNTU_IMAGE") || config.ubuntuContainerImage || "cimg/node:24.16";
      return [
        "--provider",
        "local-container",
        "--target",
        "linux",
        "--local-container-image",
        image,
      ];
    }
    case "windows-native": {
      const windows = config.windowsParallels ?? {};
      const vm =
        env("PLATFORM_SMOKE_WINDOWS_VM") || windows.sourceVm || "pi-extension-windows-template";
      const snapshot =
        env("PLATFORM_SMOKE_WINDOWS_SNAPSHOT") || windows.snapshot || "crabbox-ready";
      const user = env("PLATFORM_SMOKE_WINDOWS_USER") || windows.user || env("USER");
      const workRoot =
        env("PLATFORM_SMOKE_WINDOWS_WORK_ROOT") ||
        windows.workRoot ||
        `C:\\crabbox\\${packageSlug(config)}`;
      return [
        "--provider",
        "parallels",
        "--target",
        "windows",
        "--windows-mode",
        "normal",
        "--parallels-source",
        vm,
        "--parallels-source-snapshot",
        snapshot,
        "--parallels-user",
        user,
        "--parallels-work-root",
        workRoot,
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
  return text.match(/\bleased\s+(\S+)/)?.[1] ?? text.match(/\blease=(\S+)/)?.[1] ?? null;
}

function quoteCmd(value) {
  return `"${String(value).replace(/["^&|<>()%]/g, "^$&")}"`;
}

function spawnCrabbox(args, options = {}) {
  const bin = crabboxBin();
  const spawnOptions = {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CRABBOX_SYNC_GIT_SEED: "false", ...options.env },
  };
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(bin)) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawn(
      comspec,
      ["/d", "/s", "/c", [quoteCmd(bin), ...args.map(quoteCmd)].join(" ")],
      spawnOptions,
    );
  }
  return spawn(bin, args, spawnOptions);
}

export function execCrabbox(args, options = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnCrabbox(args, options);
    } catch (error) {
      resolvePromise({
        stdout: "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        code: 1,
        signal: null,
      });
      return;
    }
    const stdout = [];
    const stderr = [];
    let timeout;
    let killTimeout;
    if (options.timeout) {
      timeout = setTimeout(() => {
        stderr.push(
          Buffer.from(`\n[platform-smoke] crabbox timed out after ${options.timeout}ms\n`),
        );
        try {
          child.kill("SIGTERM");
        } catch {}
        killTimeout = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 10_000);
      }, options.timeout);
    }
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolvePromise({
        stdout: Buffer.concat(stdout).toString(),
        stderr: `${Buffer.concat(stderr).toString()}${error.message}\n`,
        code: 1,
        signal: null,
      });
    });
    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolvePromise({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        code: code ?? (signal ? 1 : 0),
        signal,
      });
    });
  });
}

export async function warmupLease(targetName, slug, config = {}) {
  const args = ["warmup", ...buildTargetBaseArgs(targetName, config), "--slug", slug, "--keep"];
  console.log(`  [crabbox] ${args.join(" ")}`);
  const result = await execCrabbox(args, { timeout: 300_000 });
  return {
    ...result,
    ok: result.code === 0,
    leaseId: parseLeaseId(`${result.stdout}\n${result.stderr}`) ?? leaseIdFor(targetName, slug),
  };
}

export async function runOnLease(targetName, leaseId, command, options = {}) {
  const args = ["run", ...buildTargetBaseArgs(targetName, options.config), "--id", leaseId];
  for (const name of options.allowEnv ?? []) {
    args.push("--allow-env", name);
  }
  if (options.sync === false) args.push("--no-sync");
  else args.push("--fresh-sync");
  args.push("--shell", command);
  console.log(
    `  [crabbox] run ${targetName} ${options.sync === false ? "--no-sync" : "--fresh-sync"}`,
  );
  return execCrabbox(args, { timeout: options.timeout ?? 900_000 });
}

export async function stopLease(targetName, leaseId, config = {}) {
  const args = ["stop", ...buildTargetBaseArgs(targetName, config), "--id", leaseId];
  console.log(`  [crabbox] ${args.join(" ")}`);
  return execCrabbox(args, { timeout: 90_000 });
}

export async function cleanupStaleTargetState(targetName, config = {}) {
  if (targetName === "macos") return null;
  const args = ["cleanup", ...buildTargetBaseArgs(targetName, config)];
  console.log(`  [crabbox] ${args.join(" ")}`);
  return execCrabbox(args, { timeout: 120_000 });
}
