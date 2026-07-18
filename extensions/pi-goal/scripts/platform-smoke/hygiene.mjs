/** Repository hygiene checks shared by platform smoke doctor and run preflight. */

import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function shell(command, options = {}) {
  try {
    return execSync(command, { timeout: 20_000, stdio: "pipe", ...options })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function isForbiddenProjectPath(path) {
  return (
    isForbiddenLocalArtifactPath(path) ||
    /(^|\/)\.artifacts(?:\/|$)/.test(path) ||
    /(^|\/)\.crabbox(?:\/|$)/.test(path) ||
    /(^|\/)\.debug(?:\/|$)/.test(path)
  );
}

export function isForbiddenLocalArtifactPath(path) {
  return /(^|\/)\.env(?:\..*)?$/.test(path) || /(^|\/)[^/]+\.tgz$/.test(path);
}

export function trackedForbiddenProjectPaths() {
  const tracked = shell("git ls-files")?.split(/\r?\n/).filter(Boolean) ?? [];
  return tracked.filter(isForbiddenProjectPath);
}

function scanLocalForbiddenArtifacts(dir, depth, maxDepth, results) {
  if (depth > maxDepth) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (depth === 0 && entry.name === "node_modules") continue;
    const relative = dir === "." ? `./${entry.name}` : `${dir}/${entry.name}`;
    const projectPath = relative.replace(/^\.\//, "");
    if (isForbiddenLocalArtifactPath(projectPath)) {
      results.push(relative);
    }
    if (entry.isDirectory() && depth + 1 < maxDepth) {
      scanLocalForbiddenArtifacts(relative, depth + 1, maxDepth, results);
    } else if (entry.isSymbolicLink() && depth + 1 < maxDepth) {
      try {
        if (statSync(join(dir, entry.name)).isDirectory()) {
          scanLocalForbiddenArtifacts(relative, depth + 1, maxDepth, results);
        }
      } catch {
        // Broken local symlinks are irrelevant to the forbidden artifact preflight.
      }
    }
  }
}

export function localForbiddenProjectArtifacts() {
  const results = [];
  scanLocalForbiddenArtifacts(".", 0, 2, results);
  return results;
}

export function forbiddenArtifactMessage(paths) {
  return `forbidden local artifact(s): ${paths.join(", ")}`;
}
