import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

test("the real SDK file loader registers every goal tool and command without import errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-goal-file-loader-"));
  const agentDirectory = join(directory, "agent");
  mkdirSync(agentDirectory);
  const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;

  try {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: agentDirectory,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const extension = loaded.extensions[0];
    assert.ok(extension);
    expect([...extension.tools.keys()].sort()).toEqual(["create_goal", "get_goal", "update_goal"]);
    expect([...extension.commands.keys()]).toEqual(["goal"]);
  } finally {
    if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;

    rmSync(directory, { recursive: true, force: true });
  }
});
